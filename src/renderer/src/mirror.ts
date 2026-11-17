import type { MediaEvent, MirrorReady, MirrorStats, Settings } from '../../shared/types';
import { AudioPipeline } from './audio';
import { VideoPipeline } from './video';

const api = window.api;
const canvas = document.getElementById('screen') as HTMLCanvasElement;
const toastEl = document.getElementById('toast') as HTMLDivElement;
const closedEl = document.getElementById('closed') as HTMLDivElement;

let toastTimer: number | undefined;
function toast(message: string): void {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 5000);
}

let video: VideoPipeline | null = null;
let audio: AudioPipeline | null = null;
let closed = false;
let statsTimer: number | undefined;
/** Media yang tiba sebelum `mirror:ready` selesai (pipeline butuh `info.paced`). */
const early: MediaEvent[] = [];

function dispatch(ev: MediaEvent): void {
  switch (ev.kind) {
    case 'video':
      video?.push(ev);
      break;
    case 'pcm':
      audio?.push(ev);
      break;
    case 'notice':
      toast(ev.message);
      break;
  }
}

function applyAudio(s: Settings['audio']): void {
  audio?.apply(s).catch((err: unknown) => {
    console.error('[audio] gagal memilih output', err);
    toast(`Gagal memilih output audio: ${err instanceof Error ? err.message : String(err)}`);
  });
}

function shutdown(reason: string): void {
  if (closed) return;
  closed = true;
  early.length = 0;
  window.clearInterval(statsTimer);
  video?.close();
  audio?.close();
  closedEl.textContent = reason;
  closedEl.classList.add('show');
}

api.on<MediaEvent>('mirror:media', (ev) => {
  if (closed) return;
  if (video) dispatch(ev);
  else early.push(ev);
});
// Pengaturan yang datang sebelum `mirror:ready` sudah tercakup di balasan `mirror:ready`.
api.on<Settings['audio']>('mirror:audio-settings', applyAudio);
api.on<{ reason: string }>('mirror:closed', ({ reason }) => shutdown(reason));

async function main(): Promise<void> {
  let ready: MirrorReady;
  try {
    ready = await api.invoke<MirrorReady>('mirror:ready');
  } catch (err) {
    shutdown(`Sesi mirror tidak ditemukan: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (closed) return;
  document.title = ready.info.title;
  video = new VideoPipeline(canvas, {
    paced: ready.info.paced,
    onSize: (width, height) => api.send('mirror:size', { width, height }),
  });
  audio = new AudioPipeline(toast);
  applyAudio(ready.audio);
  for (const ev of early.splice(0)) dispatch(ev);
  statsTimer = window.setInterval(() => {
    if (!video || !audio) return;
    const stats: MirrorStats = { ...video.stats(), pcmChunks: audio.chunks() };
    api.send('mirror:stats', stats);
  }, 5000);
}

void main();
