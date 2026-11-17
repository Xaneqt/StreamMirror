import { BrowserWindow, ipcMain, screen, type WebContents } from 'electron';
import iconPath from '../../assets/icon.ico?asset';
import type { EventEmitter } from 'node:events';
import type { MediaEvent, MirrorInfo, MirrorReady, MirrorStats, Settings, SourceKind } from '../shared/types';
import { loadRendererPage, preloadPath } from './paths';

/** Sumber media satu sesi. Event: 'media' (MediaEvent), 'closed' (reason: string). `stop()` idempoten. */
export interface MediaSource extends EventEmitter {
  stop(): Promise<void>;
}

interface Entry {
  info: MirrorInfo;
  source: MediaSource;
  win: BrowserWindow;
  ready: boolean;
  queue: MediaEvent[];
  queuedBytes: number;
  aspect: number | null;
}

const MAX_QUEUED_BYTES = 32 * 1024 * 1024;
/** Jeda sebelum jendela ditutup supaya alasan `mirror:closed` sempat terbaca. */
const CLOSE_NOTICE_MS = 1500;

const sessions = new Map<string, Entry>();
let onChanged: () => void = () => undefined;
let getAudio: () => Settings['audio'] = () => ({ outputLabel: '', volume: 1, muted: false });

function sendTo(entry: Entry, channel: string, payload: unknown): void {
  if (!entry.win.isDestroyed() && !entry.win.webContents.isDestroyed()) entry.win.webContents.send(channel, payload);
}

function bySender(sender: WebContents): Entry | undefined {
  for (const entry of sessions.values()) {
    if (!entry.win.isDestroyed() && entry.win.webContents === sender) return entry;
  }
  return undefined;
}

function deliver(entry: Entry, ev: MediaEvent): void {
  if (entry.ready) {
    sendTo(entry, 'mirror:media', ev);
    return;
  }
  entry.queue.push(ev);
  entry.queuedBytes += ev.kind === 'notice' ? 0 : ev.data.byteLength;
  if (entry.queuedBytes > MAX_QUEUED_BYTES) void closeSession(entry.info.sessionId, 'Jendela mirror tidak merespons');
}

/** Dipanggil sekali saat start. `changed` dipicu tiap sesi dibuka/ditutup. */
export function initSessions(opts: { onChanged: () => void; audioSettings: () => Settings['audio'] }): void {
  onChanged = opts.onChanged;
  getAudio = opts.audioSettings;

  ipcMain.handle('mirror:ready', (event): MirrorReady => {
    const entry = bySender(event.sender);
    if (!entry) throw new Error('Sesi mirror tidak ditemukan');
    // Flush setelah balasan invoke dikirim; renderer tetap wajib menahan event yang datang lebih dulu.
    setImmediate(() => {
      const queued = entry.queue;
      entry.queue = [];
      entry.queuedBytes = 0;
      entry.ready = true;
      for (const ev of queued) sendTo(entry, 'mirror:media', ev);
    });
    return { info: entry.info, audio: getAudio() };
  });

  ipcMain.on('mirror:size', (event, payload: { width?: unknown; height?: unknown } | undefined) => {
    const entry = bySender(event.sender);
    const width = Number(payload?.width);
    const height = Number(payload?.height);
    if (!entry || !(width > 0) || !(height > 0)) return;
    const ratio = width / height;
    if (entry.aspect !== null && Math.abs(entry.aspect - ratio) < 0.01) return;
    entry.aspect = ratio;
    const area = screen.getDisplayMatching(entry.win.getBounds()).workAreaSize;
    const scale = Math.min(1, (0.8 * area.height) / height, (0.8 * area.width) / width);
    entry.win.setAspectRatio(ratio);
    entry.win.setContentSize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
  });

  ipcMain.on('mirror:stats', (event, stats: Partial<MirrorStats> | undefined) => {
    const entry = bySender(event.sender);
    if (!entry) return;
    console.log(
      `[mirror ${entry.info.sessionId}] decoded=${Number(stats?.decoded) || 0} drawn=${Number(stats?.drawn) || 0} pcm=${Number(stats?.pcmChunks) || 0}`,
    );
  });
}

export function hasSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

/** Memfokuskan jendela sesi yang sudah ada. false = sesi tidak ada. */
export function focusSession(sessionId: string): boolean {
  const entry = sessions.get(sessionId);
  if (!entry) return false;
  if (!entry.win.isDestroyed()) {
    if (entry.win.isMinimized()) entry.win.restore();
    entry.win.focus();
  }
  return true;
}

export function listSessions(): { sessionId: string; title: string; source: SourceKind }[] {
  return [...sessions.values()].map((e) => ({ sessionId: e.info.sessionId, title: e.info.title, source: e.info.source }));
}

export function hasSessionOfSource(source: SourceKind): boolean {
  for (const entry of sessions.values()) if (entry.info.source === source) return true;
  return false;
}

/** Membuka jendela mirror untuk `source`. Sesi dengan id sama yang masih ada ditutup dulu. */
export function openSession(info: MirrorInfo, source: MediaSource): void {
  const previous = sessions.get(info.sessionId);
  if (previous) void closeSession(info.sessionId, 'Sesi diganti');

  const win = new BrowserWindow({
    width: 480,
    height: 900,
    backgroundColor: '#000',
    autoHideMenuBar: true,
    title: info.title,
    icon: iconPath,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  const entry: Entry = { info, source, win, ready: false, queue: [], queuedBytes: 0, aspect: null };
  sessions.set(info.sessionId, entry);

  // Judul jendela = judul sesi (dipakai OBS Window Capture), bukan <title> halaman.
  win.on('page-title-updated', (event) => event.preventDefault());
  win.on('closed', () => {
    if (sessions.get(info.sessionId) !== entry) return;
    sessions.delete(info.sessionId);
    source.removeAllListeners('media');
    void source.stop().catch((error) => console.error(`[mirror ${info.sessionId}] stop:`, error));
    onChanged();
  });

  source.on('media', (ev: MediaEvent) => {
    if (sessions.get(info.sessionId) === entry) deliver(entry, ev);
  });
  source.once('closed', (reason: string) => {
    if (sessions.get(info.sessionId) === entry) void closeSession(info.sessionId, reason || 'Sesi berakhir');
  });

  void loadRendererPage(win, 'mirror.html').catch((error) => {
    console.error(`[mirror ${info.sessionId}] gagal memuat halaman:`, error);
    void closeSession(info.sessionId, 'Gagal memuat jendela mirror');
  });
  onChanged();
}

export async function closeSession(sessionId: string, reason: string): Promise<void> {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  sessions.delete(sessionId);
  entry.source.removeAllListeners('media');
  sendTo(entry, 'mirror:closed', { reason });
  onChanged();
  setTimeout(() => {
    if (!entry.win.isDestroyed()) entry.win.destroy();
  }, CLOSE_NOTICE_MS);
  try {
    await entry.source.stop();
  } catch (error) {
    console.error(`[mirror ${sessionId}] stop:`, error);
  }
}

export async function closeAllSessions(reason: string): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => closeSession(id, reason)));
}

export function broadcastAudioSettings(audio: Settings['audio']): void {
  for (const entry of sessions.values()) sendTo(entry, 'mirror:audio-settings', audio);
}
