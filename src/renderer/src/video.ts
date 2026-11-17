import { nalType, nalUnits } from '../../shared/annexb';
import type { MediaEvent } from '../../shared/types';

type VideoEvent = Extract<MediaEvent, { kind: 'video' }>;
type Rotation = VideoEvent['rotation'];

export interface VideoPipelineOptions {
  /** true: frame ditampilkan menurut timestamp pengirim (iOS); false: selalu frame terbaru (Android). */
  paced: boolean;
  onSize: (width: number, height: number) => void;
}

interface DecodedFrame {
  frame: VideoFrame;
  rotation: Rotation;
}

/** Codec cadangan bila SPS tidak ditemukan di paket config. */
const FALLBACK_CODEC = 'avc1.42e01f';

export class VideoPipeline {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly paced: boolean;
  private readonly onSize: (width: number, height: number) => void;

  private decoder: VideoDecoder;
  private codec = '';
  private config: Uint8Array | null = null;
  private needKey = true;
  /** Reset decoder beruntun tanpa satu pun frame keluar. */
  private failures = 0;
  /** Rotasi per timestamp chunk, karena VideoFrame tidak membawa metadata rotasi dari paket. */
  private readonly rotations = new Map<number, Rotation>();

  private latest: DecodedFrame | null = null;
  private readonly presentation: DecodedFrame[] = [];
  private origin: number | null = null;

  private decodedCount = 0;
  private drawnCount = 0;
  private raf = 0;
  private closed = false;

  constructor(canvas: HTMLCanvasElement, opts: VideoPipelineOptions) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('Canvas 2D tidak tersedia');
    this.ctx = ctx;
    this.paced = opts.paced;
    this.onSize = opts.onSize;
    this.decoder = this.createDecoder();
    this.raf = requestAnimationFrame(this.tick);
  }

  push(ev: VideoEvent): void {
    if (this.closed) return;
    if (ev.config) {
      this.config = ev.data;
      this.needKey = true;
      this.failures = 0;
      let codec = FALLBACK_CODEC;
      for (const nal of nalUnits(ev.data)) {
        if (nalType(nal) === 7 && nal.length >= 4) {
          codec = 'avc1.' + Array.from(nal.subarray(1, 4), (b) => b.toString(16).padStart(2, '0')).join('');
          break;
        }
      }
      if (codec !== this.codec || this.decoder.state !== 'configured') {
        this.codec = codec;
        this.configure();
      }
      return;
    }

    if (this.decoder.state !== 'configured') return;
    if (this.needKey && !ev.keyFrame) return;
    let data = ev.data;
    if (ev.keyFrame) {
      if (this.config) {
        data = new Uint8Array(this.config.length + ev.data.length);
        data.set(this.config);
        data.set(ev.data, this.config.length);
      }
      this.needKey = false;
    }
    if (this.rotations.size > 256) this.rotations.clear();
    this.rotations.set(ev.pts, ev.rotation);
    try {
      this.decoder.decode(new EncodedVideoChunk({ type: ev.keyFrame ? 'key' : 'delta', timestamp: ev.pts, data }));
    } catch (err) {
      console.error('[video] decode gagal', err);
      this.resetDecoder();
    }
  }

  /** Jumlah frame ter-decode dan tergambar sejak panggilan terakhir. */
  stats(): { decoded: number; drawn: number } {
    const result = { decoded: this.decodedCount, drawn: this.drawnCount };
    this.decodedCount = 0;
    this.drawnCount = 0;
    return result;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    cancelAnimationFrame(this.raf);
    if (this.decoder.state !== 'closed') this.decoder.close();
    this.latest?.frame.close();
    this.latest = null;
    for (const item of this.presentation) item.frame.close();
    this.presentation.length = 0;
    this.rotations.clear();
  }

  private createDecoder(): VideoDecoder {
    return new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: (err) => {
        console.error('[video] decoder error', err);
        this.resetDecoder();
      },
    });
  }

  private configure(): void {
    if (this.decoder.state === 'closed') this.decoder = this.createDecoder();
    try {
      this.decoder.configure({ codec: this.codec, optimizeForLatency: true, hardwareAcceleration: 'no-preference' });
    } catch (err) {
      console.error('[video] konfigurasi decoder gagal', this.codec, err);
    }
  }

  private resetDecoder(): void {
    if (this.closed) return;
    if (this.decoder.state !== 'closed') this.decoder.close();
    this.rotations.clear();
    this.decoder = this.createDecoder();
    this.needKey = true;
    // Batasi konfigurasi ulang beruntun tanpa frame keluar (mis. codec tidak didukung) agar tidak berputar terus.
    this.failures++;
    if (this.config && this.failures <= 3) this.configure();
    else if (this.config) console.error('[video] decoder gagal berulang, menunggu paket config berikutnya');
  }

  private onFrame(frame: VideoFrame): void {
    if (this.closed) {
      frame.close();
      return;
    }
    this.failures = 0;
    this.decodedCount++;
    const rotation = this.rotations.get(frame.timestamp) ?? 0;
    this.rotations.delete(frame.timestamp);
    if (this.paced) {
      this.presentation.push({ frame, rotation });
    } else {
      this.latest?.frame.close();
      this.latest = { frame, rotation };
    }
  }

  private readonly tick = (): void => {
    if (this.closed) return;
    this.raf = requestAnimationFrame(this.tick);
    if (!this.paced) {
      if (!this.latest) return;
      this.draw(this.latest);
      this.latest.frame.close();
      this.latest = null;
      return;
    }

    const queue = this.presentation;
    if (queue.length === 0) return;
    const now = performance.now();
    if (this.origin === null) this.origin = now + 32 - queue[0].frame.timestamp / 1000;
    const due = this.origin + queue[0].frame.timestamp / 1000;
    if (queue.length > 8 || now - due > 100 || due - now > 150) {
      for (const item of queue.splice(0, Math.max(0, queue.length - 2))) item.frame.close();
      this.origin = now + 16 - queue[0].frame.timestamp / 1000;
    }

    let pick = -1;
    for (let i = 0; i < queue.length; i++) {
      if (this.origin + queue[i].frame.timestamp / 1000 <= now + 2) pick = i;
      else break;
    }
    if (pick < 0) return;
    const shown = queue.splice(0, pick + 1);
    const current = shown[shown.length - 1];
    for (const item of shown) if (item !== current) item.frame.close();
    this.draw(current);
    current.frame.close();
  };

  private draw({ frame, rotation }: DecodedFrame): void {
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    const odd = (rotation & 1) === 1;
    const cw = odd ? h : w;
    const ch = odd ? w : h;
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
      this.onSize(cw, ch);
    }
    if (rotation === 0) {
      this.ctx.drawImage(frame, 0, 0);
    } else {
      this.ctx.save();
      this.ctx.translate(cw / 2, ch / 2);
      this.ctx.rotate((rotation * Math.PI) / 2);
      this.ctx.drawImage(frame, -w / 2, -h / 2, w, h);
      this.ctx.restore();
    }
    this.drawnCount++;
  }
}
