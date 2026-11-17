import type { InvokeChannel } from '../../shared/ipc';
import type { AppState, OpResult, Settings, SettingsPatch, SourceKind } from '../../shared/types';
import bannerDarkUrl from '../../../assets/banner-dark.png';
import bannerLightUrl from '../../../assets/banner-light.png';
import { audioOutputs } from './audio';

const api = window.api;

const byId = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Elemen #${id} tidak ada`);
  return node as T;
};

// <picture>: banner gelap saat tema gelap, selain itu banner terang.
byId<HTMLSourceElement>('brand-banner-dark').srcset = bannerDarkUrl;
byId<HTMLImageElement>('brand-banner').src = bannerLightUrl;

const theme = byId<HTMLSelectElement>('theme');

const androidList = byId<HTMLDivElement>('android-list');
const pairForm = byId<HTMLFormElement>('pair-form');
const pairAddress = byId<HTMLInputElement>('pair-address');
const pairCode = byId<HTMLInputElement>('pair-code');
const pairButton = byId<HTMLButtonElement>('pair-button');
const connectForm = byId<HTMLFormElement>('connect-form');
const connectAddress = byId<HTMLInputElement>('connect-address');
const connectButton = byId<HTMLButtonElement>('connect-button');
const androidResult = byId<HTMLParagraphElement>('android-result');

const airplayState = byId<HTMLSpanElement>('airplay-state');
const airplayMessage = byId<HTMLSpanElement>('airplay-message');
const airplayRestart = byId<HTMLButtonElement>('airplay-restart');
const iosUsbList = byId<HTMLDivElement>('ios-usb-list');
const iosResult = byId<HTMLParagraphElement>('ios-result');

const audioOutput = byId<HTMLSelectElement>('audio-output');
const audioVolume = byId<HTMLInputElement>('audio-volume');
const audioVolumeValue = byId<HTMLSpanElement>('audio-volume-value');
const audioMuted = byId<HTMLInputElement>('audio-muted');
const keepPhoneAudio = byId<HTMLInputElement>('keep-phone-audio');

const videoMaxSize = byId<HTMLSelectElement>('video-max-size');
const videoBitrate = byId<HTMLInputElement>('video-bitrate');
const videoMaxFps = byId<HTMLSelectElement>('video-max-fps');

const sessionList = byId<HTMLDivElement>('session-list');
const sessionResult = byId<HTMLParagraphElement>('session-result');

const SOURCE_LABEL: Record<SourceKind, string> = { android: 'Android', airplay: 'AirPlay', 'ios-usb': 'iPhone USB' };
const MAX_SIZES = [0, 2560, 1920, 1600, 1280];
const MAX_FPS = [30, 60, 90, 120];

let state: AppState | null = null;
let outputLabels: string[] = [];
/** Kunci operasi yang invoke-nya belum selesai; tombolnya dinonaktifkan. */
const pending = new Set<string>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function showResult(target: HTMLElement, message: string, ok: boolean): void {
  target.textContent = message;
  target.className = ok ? 'result ok' : 'result error';
}

/** Menjalankan invoke dengan tombol terkait nonaktif selama menunggu; pesan hasil ditampilkan di `target`. */
async function operation(key: string, channel: InvokeChannel, payload: unknown, target: HTMLElement): Promise<void> {
  if (pending.has(key)) return;
  pending.add(key);
  render();
  try {
    const result = await api.invoke<OpResult | undefined>(channel, payload);
    if (result) showResult(target, result.message || (result.ok ? '' : 'Gagal'), result.ok);
  } catch (err) {
    showResult(target, err instanceof Error ? err.message : String(err), false);
  } finally {
    pending.delete(key);
    render();
  }
}

function actionButton(label: string, key: string, onClick: () => void, primary = false): HTMLButtonElement {
  const button = el('button', primary ? 'primary' : '', label);
  button.type = 'button';
  button.dataset.key = key;
  button.disabled = pending.has(key);
  button.addEventListener('click', onClick);
  return button;
}

function row(main: (Node | string)[], actions: HTMLElement[]): HTMLDivElement {
  const node = el('div', 'row');
  const mainEl = el('div', 'row-main');
  mainEl.append(...main);
  const actionsEl = el('div', 'row-actions');
  actionsEl.append(...actions);
  node.append(mainEl, actionsEl);
  return node;
}

function renderAndroid(devices: AppState['android']): void {
  const rows = devices.map((d) => {
    const main: Node[] = [
      el('span', 'name', d.model),
      el('span', 'muted', d.serial),
      el('span', `badge ${d.state === 'device' ? 'good' : 'warn'}`, d.state),
      el('span', 'badge', d.wireless ? 'Wi-Fi' : 'USB'),
    ];
    if (d.mirroring) main.push(el('span', 'badge live', 'mirroring'));
    if (d.state === 'unauthorized') main.push(el('span', 'hint', 'Izinkan USB debugging di layar HP'));
    const actions: HTMLButtonElement[] = [];
    if (d.state === 'device') {
      const key = `android:start:${d.serial}`;
      actions.push(actionButton('Mirror', key, () => void operation(key, 'android:start', d.serial, androidResult), true));
    }
    if (d.state === 'device' && !d.wireless) {
      const key = `android:wireless:${d.serial}`;
      actions.push(
        actionButton('Jadikan wireless', key, () => void operation(key, 'android:wireless', d.serial, androidResult)),
      );
    }
    if (d.wireless) {
      const key = `android:disconnect:${d.serial}`;
      actions.push(actionButton('Putuskan', key, () => void operation(key, 'android:disconnect', d.serial, androidResult)));
    }
    return row(main, actions);
  });
  androidList.replaceChildren(
    ...(rows.length > 0
      ? rows
      : [el('p', 'muted', 'Belum ada HP Android. Aktifkan USB debugging lalu colok kabel, atau Pair / Connect lewat Wi-Fi.')]),
  );
}

function renderIos(s: AppState): void {
  airplayState.textContent = s.airplay.state;
  airplayState.className = `badge airplay-${s.airplay.state}`;
  airplayMessage.textContent = s.airplay.message;

  const driverSerials = s.settings.iosUsbDriverSerials;
  const removeButton = (serial: string): HTMLButtonElement => {
    const key = `iosusb:driver:${serial}`;
    return actionButton('Lepas driver USB', key, () =>
      void operation(key, 'iosusb:driver', { serial, remove: true }, iosResult),
    );
  };

  const rows: HTMLElement[] = [];
  if (!s.iosUsbAvailable) rows.push(el('p', 'muted', 'Runtime USB belum dibuild (npm run build:usb)'));
  for (const phone of s.iosUsb) {
    const main: Node[] = [el('span', 'name', phone.name), el('span', 'muted', phone.osVersion)];
    if (phone.mirroring) main.push(el('span', 'badge live', 'mirroring'));
    const actions: HTMLButtonElement[] = [];
    if (phone.driver === 'missing') {
      const key = `iosusb:driver:${phone.serial}`;
      actions.push(
        actionButton('Pasang driver USB', key, () =>
          void operation(key, 'iosusb:driver', { serial: phone.serial, remove: false }, iosResult),
        ),
      );
    } else if (phone.driver === 'replug') {
      main.push(el('span', 'hint', 'Cabut lalu colok lagi iPhone'));
    } else {
      const key = `iosusb:start:${phone.serial}`;
      actions.push(
        actionButton('Mirror via USB', key, () => void operation(key, 'iosusb:start', phone.serial, iosResult), true),
      );
    }
    if (driverSerials.includes(phone.serial)) actions.push(removeButton(phone.serial));
    rows.push(row(main, actions));
  }
  for (const serial of driverSerials) {
    if (s.iosUsb.some((phone) => phone.serial === serial)) continue;
    rows.push(row([el('span', 'name', 'iPhone'), el('span', 'muted', `${serial} (tidak terhubung)`)], [removeButton(serial)]));
  }
  if (rows.length === 0) rows.push(el('p', 'muted', 'Tidak ada iPhone terdeteksi lewat kabel USB.'));
  iosUsbList.replaceChildren(...rows);
}

function renderSessions(sessions: AppState['sessions']): void {
  const rows = sessions.map((sess) => {
    const key = `session:stop:${sess.sessionId}`;
    return row(
      [el('span', 'name', sess.title), el('span', 'badge', SOURCE_LABEL[sess.source])],
      [actionButton('Stop', key, () => void operation(key, 'session:stop', sess.sessionId, sessionResult))],
    );
  });
  sessionList.replaceChildren(...(rows.length > 0 ? rows : [el('p', 'muted', 'Belum ada sesi.')]));
}

/** Mengisi ulang opsi hanya bila daftar berubah; nilai tidak ditimpa selama user memegang kontrolnya. */
function fillSelect(select: HTMLSelectElement, options: [string, string][], current: string): void {
  const focused = document.activeElement === select;
  const signature = JSON.stringify(options);
  if (select.dataset.options !== signature) {
    const keep = focused ? select.value : current;
    select.replaceChildren(
      ...options.map(([value, label]) => {
        const option = el('option', '', label);
        option.value = value;
        return option;
      }),
    );
    select.dataset.options = signature;
    select.value = keep;
  } else if (!focused) {
    select.value = current;
  }
}

function setIfIdle(input: HTMLInputElement, value: string): void {
  if (document.activeElement !== input) input.value = value;
}

function syncSettings(s: Settings): void {
  const outputs: [string, string][] = [['', 'Default Windows'], ...outputLabels.map((l): [string, string] => [l, l])];
  if (s.audio.outputLabel !== '' && !outputLabels.includes(s.audio.outputLabel)) {
    outputs.push([s.audio.outputLabel, `${s.audio.outputLabel} (tidak terhubung)`]);
  }
  fillSelect(audioOutput, outputs, s.audio.outputLabel);
  setIfIdle(audioVolume, String(Math.round(s.audio.volume * 100)));
  audioVolumeValue.textContent = `${audioVolume.value}%`;
  audioMuted.checked = s.audio.muted;
  keepPhoneAudio.checked = s.android.keepPhoneAudio;
  if (document.activeElement !== theme) theme.value = s.theme;

  const sizes = MAX_SIZES.includes(s.android.maxSize) ? MAX_SIZES : [...MAX_SIZES, s.android.maxSize];
  fillSelect(
    videoMaxSize,
    sizes.map((n): [string, string] => [String(n), n === 0 ? 'Asli' : `${n} px`]),
    String(s.android.maxSize),
  );
  setIfIdle(videoBitrate, String(s.android.videoBitRateMbps));
  const fps = MAX_FPS.includes(s.android.maxFps) ? MAX_FPS : [...MAX_FPS, s.android.maxFps];
  fillSelect(
    videoMaxFps,
    fps.map((n): [string, string] => [String(n), `${n} fps`]),
    String(s.android.maxFps),
  );
}

function render(): void {
  pairButton.disabled = pending.has('pair');
  connectButton.disabled = pending.has('connect');
  airplayRestart.disabled = pending.has('airplay');
  if (!state) return;

  // Baris daftar dibangun ulang penuh; fokus keyboard pada tombol baris dikembalikan lewat data-key.
  const active = document.activeElement;
  const focusKey = active instanceof HTMLElement ? active.dataset.key : undefined;
  renderAndroid(state.android);
  renderIos(state);
  renderSessions(state.sessions);
  syncSettings(state.settings);
  if (focusKey && document.activeElement === document.body) {
    document.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
  }
}

async function patchSettings(patch: SettingsPatch): Promise<void> {
  try {
    const settings = await api.invoke<Settings>('settings:set', patch);
    if (state) {
      state = { ...state, settings };
      render();
    }
  } catch (err) {
    console.error('[launcher] gagal menyimpan pengaturan', err);
  }
}

async function refreshOutputs(): Promise<void> {
  try {
    outputLabels = [...new Set((await audioOutputs()).map((d) => d.label))];
  } catch (err) {
    console.warn('[launcher] daftar output audio gagal dibaca', err);
    outputLabels = [];
  }
  render();
}

pairForm.addEventListener('submit', (e) => {
  e.preventDefault();
  void operation('pair', 'android:pair', { address: pairAddress.value.trim(), code: pairCode.value.trim() }, androidResult);
});
connectForm.addEventListener('submit', (e) => {
  e.preventDefault();
  void operation('connect', 'android:connect', connectAddress.value.trim(), androidResult);
});
airplayRestart.addEventListener('click', () => void operation('airplay', 'airplay:restart', undefined, iosResult));

audioOutput.addEventListener('change', () => void patchSettings({ audio: { outputLabel: audioOutput.value } }));
audioVolume.addEventListener('input', () => {
  audioVolumeValue.textContent = `${audioVolume.value}%`;
  void patchSettings({ audio: { volume: Number(audioVolume.value) / 100 } });
});
audioMuted.addEventListener('change', () => void patchSettings({ audio: { muted: audioMuted.checked } }));
theme.addEventListener('change', () => void patchSettings({ theme: theme.value === 'light' ? 'light' : 'dark' }));
keepPhoneAudio.addEventListener('change', () => void patchSettings({ android: { keepPhoneAudio: keepPhoneAudio.checked } }));
videoMaxSize.addEventListener('change', () => void patchSettings({ android: { maxSize: Number(videoMaxSize.value) } }));
videoMaxFps.addEventListener('change', () => void patchSettings({ android: { maxFps: Number(videoMaxFps.value) } }));
videoBitrate.addEventListener('change', () => {
  const raw = Math.round(Number(videoBitrate.value));
  if (!Number.isFinite(raw) || videoBitrate.value.trim() === '') {
    if (state) videoBitrate.value = String(state.settings.android.videoBitRateMbps);
    return;
  }
  const mbps = Math.min(40, Math.max(2, raw));
  videoBitrate.value = String(mbps);
  void patchSettings({ android: { videoBitRateMbps: mbps } });
});

navigator.mediaDevices.addEventListener('devicechange', () => void refreshOutputs());

api.on<AppState>('state:changed', (s) => {
  state = s;
  render();
});
api
  .invoke<AppState>('state:get')
  .then((s) => {
    // Event `state:changed` yang sudah tiba lebih baru dari balasan ini.
    if (state) return;
    state = s;
    render();
  })
  .catch((err: unknown) => console.error('[launcher] state:get gagal', err));
void refreshOutputs();
