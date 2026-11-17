import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session } from 'electron';
import iconPath from '../../assets/icon.ico?asset';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  AndroidDeviceInfo,
  AppState,
  MediaEvent,
  MirrorInfo,
  OpResult,
  Settings,
  SettingsPatch,
  UsbIphoneInfo,
} from '../shared/types';
import * as adb from './adb';
import { AndroidSession } from './android/session';
import { AirplayReceiver } from './ios/airplay';
import { listUsbIphones, setupUsbDriver, UsbIphoneSession, usbRuntimeAvailable } from './ios/usb';
import { adbPath, loadRendererPage, preloadPath } from './paths';
import {
  broadcastAudioSettings,
  closeAllSessions,
  closeSession,
  focusSession,
  hasSession,
  hasSessionOfSource,
  initSessions,
  listSessions,
  openSession,
  type MediaSource,
} from './sessions';
import { loadSettings, mergeSettings, saveSettings } from './settings';

type AndroidDevice = Omit<AndroidDeviceInfo, 'mirroring'>;
type UsbIphone = Omit<UsbIphoneInfo, 'mirroring'>;
type DriverResult = OpResult & { replug: boolean };

const ADDRESS_PATTERN = /^[0-9A-Za-z.\-]+:\d{1,5}$/;
const PAIR_CODE_PATTERN = /^\d{6}$/;
const ANDROID_POLL_MS = 2000;
const USB_POLL_MS = 3000;
/** `UsbIphoneSession.stop()` menunggu helper sampai 30 s; beri sedikit kelonggaran. */
const SHUTDOWN_TIMEOUT_MS = 35_000;
const MAX_AIRPLAY_PENDING = 512;

let settings: Settings = mergeSettings(loadSettings(), {});
let launcher: BrowserWindow | null = null;
let androidDevices: AndroidDevice[] = [];
let usbIphones: UsbIphone[] = [];
let airplay: AirplayReceiver | null = null;
/** Sumber sesi AirPlay yang sedang tampil; null = tidak ada client yang ditampilkan. */
let airplaySource: MediaSource | null = null;
let airplayPending: MediaEvent[] = [];
let weStartedAdb = false;
let quitting = false;
const starting = new Set<string>();
const stopPolling: (() => void)[] = [];

function buildState(): AppState {
  return {
    android: androidDevices.map((d) => ({ ...d, mirroring: hasSession(`android:${d.serial}`) })),
    iosUsbAvailable: usbRuntimeAvailable(),
    iosUsb: usbIphones.map((d) => ({ ...d, mirroring: hasSession(`ios-usb:${d.serial}`) })),
    airplay: airplay?.status ?? { state: 'starting', message: '' },
    sessions: listSessions(),
    settings,
  };
}

function publishState(): void {
  if (launcher && !launcher.isDestroyed()) launcher.webContents.send('state:changed', buildState());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Loop polling tanpa tumpang tindih; mengembalikan fungsi penghenti. */
function poll(intervalMs: number, tick: () => Promise<void>): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const loop = async (): Promise<void> => {
    try {
      await tick();
    } catch (error) {
      console.error('[poll]', error);
    }
    if (!stopped) timer = setTimeout(() => void loop(), intervalMs);
  };
  void loop();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

async function refreshAndroid(): Promise<void> {
  const list = await adb.listDevices();
  if (JSON.stringify(list) === JSON.stringify(androidDevices)) return;
  androidDevices = list;
  publishState();
}

async function refreshUsb(): Promise<void> {
  if (!usbRuntimeAvailable() || hasSessionOfSource('ios-usb')) return;
  const list = await listUsbIphones();
  if (JSON.stringify(list) === JSON.stringify(usbIphones)) return;
  usbIphones = list;
  publishState();
}

/**
 * Menjalankan `start` lalu membuka jendela sesi. Event media/closed yang muncul selama start
 * (mis. paket config H.264 pertama) ditahan dan diteruskan setelah jendela terdaftar.
 */
async function startAndOpen(source: MediaSource, start: () => Promise<MirrorInfo>): Promise<void> {
  const early: { events: MediaEvent[]; closed: string | null } = { events: [], closed: null };
  const collect = (ev: MediaEvent): void => void early.events.push(ev);
  const onClosed = (reason: string): void => {
    early.closed = reason || 'Sesi berakhir';
  };
  source.on('media', collect);
  source.once('closed', onClosed);
  let info: MirrorInfo;
  try {
    info = await start();
  } catch (error) {
    await source.stop().catch(() => undefined);
    throw error;
  } finally {
    source.off('media', collect);
    source.off('closed', onClosed);
  }
  if (early.closed !== null) {
    await source.stop().catch(() => undefined);
    throw new Error(early.closed);
  }
  openSession(info, source);
  for (const ev of early.events) source.emit('media', ev);
}

/** Satu sesi per device: sesi yang sudah ada cukup difokuskan; start ganda ditolak. */
async function startSession(sessionId: string, run: () => Promise<void>): Promise<OpResult> {
  if (focusSession(sessionId)) return { ok: true, message: 'Jendela mirror sudah terbuka' };
  if (starting.has(sessionId)) return { ok: false, message: 'Mirror sedang dimulai' };
  starting.add(sessionId);
  try {
    await run();
    return { ok: true, message: 'Mirror dimulai' };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  } finally {
    starting.delete(sessionId);
    publishState();
  }
}

function startAndroid(serial: unknown): Promise<OpResult> {
  const device = androidDevices.find((d) => d.serial === serial && d.state === 'device');
  if (!device) return Promise.resolve({ ok: false, message: 'HP tidak terhubung' });
  if (!fs.existsSync(adbPath())) {
    return Promise.resolve({ ok: false, message: 'Runtime Android belum diunduh (npm run fetch:android)' });
  }
  const sessionId = `android:${device.serial}`;
  return startSession(sessionId, () => {
    const source = new AndroidSession(device.serial, settings.android);
    return startAndOpen(source, async () => {
      const { deviceName } = await source.start();
      return { sessionId, source: 'android', title: `Mirror - ${device.model || deviceName}`, paced: false };
    });
  });
}

function startIosUsb(serial: unknown): Promise<OpResult> {
  const device = usbIphones.find((d) => d.serial === serial);
  if (!device) return Promise.resolve({ ok: false, message: 'iPhone tidak terhubung' });
  if (device.driver !== 'ready') return Promise.resolve({ ok: false, message: 'Driver USB belum siap untuk iPhone ini' });
  const sessionId = `ios-usb:${device.serial}`;
  return startSession(sessionId, () => {
    const source = new UsbIphoneSession(device.serial);
    return startAndOpen(source, async () => {
      await source.start();
      return { sessionId, source: 'ios-usb', title: `Mirror - ${device.name || 'iPhone'}`, paced: true };
    });
  });
}

async function driverOperation(payload: { serial?: unknown; remove?: unknown } | undefined): Promise<DriverResult> {
  const serial = typeof payload?.serial === 'string' ? payload.serial : '';
  const remove = payload?.remove === true;
  if (!serial) return { ok: false, message: 'Serial iPhone tidak valid', replug: false };
  if (hasSession(`ios-usb:${serial}`)) return { ok: false, message: 'Hentikan mirror USB dulu', replug: false };
  if (!remove) {
    const options = {
      type: 'warning' as const,
      buttons: ['Pasang', 'Batal'],
      defaultId: 0,
      cancelId: 1,
      title: 'Pasang driver USB',
      message:
        'Memasang filter driver libusb0 1.4.0.2 untuk iPhone ini saja (butuh hak admin). Memory Integrity aktif di PC ini; kalau Windows menolak drivernya, filter otomatis dilepas lagi.',
    };
    const choice =
      launcher && !launcher.isDestroyed()
        ? await dialog.showMessageBox(launcher, options)
        : await dialog.showMessageBox(options);
    if (choice.response !== 0) return { ok: false, message: 'Dibatalkan', replug: false };
  }
  const result = await setupUsbDriver(serial, remove);
  if (result.ok) {
    const others = settings.iosUsbDriverSerials.filter((s) => s !== serial);
    settings = { ...settings, iosUsbDriverSerials: remove ? others : [...others, serial] };
    saveSettings(settings);
  }
  await refreshUsb().catch(() => undefined);
  publishState();
  return result;
}

function applySettings(patch: SettingsPatch | undefined): Settings {
  const next = mergeSettings(settings, patch);
  next.audio.volume = Math.min(1, Math.max(0, next.audio.volume));
  next.android.videoBitRateMbps = Math.min(40, Math.max(2, Math.round(next.android.videoBitRateMbps)));
  next.android.maxSize = Math.max(0, Math.round(next.android.maxSize));
  next.android.maxFps = Math.max(0, Math.round(next.android.maxFps));
  next.airplay.name = next.airplay.name.trim() || settings.airplay.name;
  const audioChanged = JSON.stringify(next.audio) !== JSON.stringify(settings.audio);
  const airplayChanged = JSON.stringify(next.airplay) !== JSON.stringify(settings.airplay);
  const themeChanged = next.theme !== settings.theme;
  settings = next;
  saveSettings(settings);
  if (audioChanged) broadcastAudioSettings(settings.audio);
  if (airplayChanged) void airplay?.restart();
  if (themeChanged) nativeTheme.themeSource = settings.theme;
  publishState();
  return settings;
}

async function addressOperation(address: unknown, run: (address: string) => Promise<OpResult>): Promise<OpResult> {
  if (typeof address !== 'string' || !ADDRESS_PATTERN.test(address)) return { ok: false, message: 'Format salah' };
  const result = await run(address);
  await refreshAndroid().catch(() => undefined);
  return result;
}

function registerIpc(): void {
  ipcMain.handle('state:get', () => buildState());
  ipcMain.handle('settings:set', (_event, patch: SettingsPatch | undefined) => applySettings(patch));
  ipcMain.handle('android:start', (_event, serial: unknown) => startAndroid(serial));
  ipcMain.handle('android:pair', (_event, payload: { address?: unknown; code?: unknown } | undefined) => {
    const code = payload?.code;
    if (typeof code !== 'string' || !PAIR_CODE_PATTERN.test(code)) return { ok: false, message: 'Format salah' };
    return addressOperation(payload?.address, (address) => adb.pair(address, code));
  });
  ipcMain.handle('android:connect', (_event, address: unknown) => addressOperation(address, adb.connect));
  ipcMain.handle('android:disconnect', (_event, address: unknown) => addressOperation(address, adb.disconnect));
  ipcMain.handle('android:wireless', async (_event, serial: unknown): Promise<OpResult> => {
    const device = androidDevices.find((d) => d.serial === serial && d.state === 'device' && !d.wireless);
    if (!device) return { ok: false, message: 'HP tidak terhubung lewat USB' };
    const result = await adb.goWireless(device.serial);
    await refreshAndroid().catch(() => undefined);
    return result;
  });
  ipcMain.handle('airplay:restart', () => airplay?.restart());
  ipcMain.handle('iosusb:driver', (_event, payload: { serial?: unknown; remove?: unknown } | undefined) =>
    driverOperation(payload),
  );
  ipcMain.handle('iosusb:start', (_event, serial: unknown) => startIosUsb(serial));
  ipcMain.handle('session:stop', (_event, sessionId: unknown) =>
    typeof sessionId === 'string' ? closeSession(sessionId, 'Dihentikan') : undefined,
  );
}

function startAirplay(): void {
  const receiver = new AirplayReceiver(() => settings.airplay);
  airplay = receiver;
  receiver.on('status', publishState);
  receiver.on('media', (ev: MediaEvent) => {
    if (airplaySource) airplaySource.emit('media', ev);
    else if (airplayPending.length < MAX_AIRPLAY_PENDING) airplayPending.push(ev);
  });
  receiver.on('connected', ({ deviceName }: { deviceName: string | null }) => {
    const source = Object.assign(new EventEmitter(), {
      // Jendela ditutup dari PC selagi client masih tersambung: restart receiver adalah
      // satu-satunya cara memutus client. Setelah client pergi sendiri, stop() tidak berbuat apa-apa.
      stop: async (): Promise<void> => {
        if (airplaySource !== source) return;
        airplaySource = null;
        airplayPending = [];
        await receiver.restart();
      },
    });
    airplaySource = source;
    openSession({ sessionId: 'airplay', source: 'airplay', title: `Mirror - ${deviceName ?? 'iPhone'}`, paced: true }, source);
    const pending = airplayPending;
    airplayPending = [];
    for (const ev of pending) source.emit('media', ev);
  });
  receiver.on('disconnected', () => {
    airplaySource = null;
    airplayPending = [];
    void closeSession('airplay', 'iPhone berhenti mirroring');
  });
  void receiver.start();
}

function createLauncher(): void {
  const win = new BrowserWindow({
    width: 900,
    height: 720,
    autoHideMenuBar: true,
    title: 'StreamMirror',
    icon: iconPath,
    webPreferences: { preload: preloadPath(), contextIsolation: true, sandbox: false },
  });
  launcher = win;
  win.on('closed', () => {
    launcher = null;
    app.quit();
  });
  void loadRendererPage(win, 'index.html');
}

async function shutdown(): Promise<void> {
  for (const stop of stopPolling) stop();
  await closeAllSessions('Aplikasi ditutup');
  await airplay?.stop();
  if (weStartedAdb) await adb.adb(['kill-server'], 5000);
}

// Tanpa ini Chromium berhenti me-render jendela yang tertutup jendela lain (jendela mirror
// di belakang OBS / game), sehingga OBS Window Capture membeku. `backgroundThrottling: false` saja tidak cukup.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!launcher || launcher.isDestroyed()) return;
    if (launcher.isMinimized()) launcher.restore();
    launcher.focus();
  });

  // Quit ditahan sampai shutdown selesai. Permintaan quit kedua (mis. default `window-all-closed`
  // setelah launcher ditutup) juga ditahan, supaya uxplay/adb/iPhone USB sempat dibereskan.
  let shutdownDone = false;
  app.on('before-quit', (event) => {
    if (shutdownDone) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void Promise.race([shutdown(), delay(SHUTDOWN_TIMEOUT_MS, undefined, { ref: false })])
      .catch((error) => console.error('[shutdown]', error))
      .finally(() => {
        shutdownDone = true;
        app.quit();
      });
  });

  void app.whenReady().then(async () => {
    // App hanya memuat konten lokal; izin diperlukan agar label device audio dan setSinkId tersedia.
    session.defaultSession.setPermissionCheckHandler(() => true);
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(true));

    initSessions({ onChanged: publishState, audioSettings: () => settings.audio });
    registerIpc();
    // Tema launcher: CSS memakai light-dark(), yang mengikuti themeSource ini.
    nativeTheme.themeSource = settings.theme;
    createLauncher();
    startAirplay();

    if (fs.existsSync(adbPath())) weStartedAdb = await adb.startServer();
    else console.warn('[android] adb belum ada: jalankan `npm run fetch:android`');
    if (quitting) return;
    stopPolling.push(poll(ANDROID_POLL_MS, refreshAndroid), poll(USB_POLL_MS, refreshUsb));
  });
}
