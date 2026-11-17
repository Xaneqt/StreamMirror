import { EventEmitter } from 'node:events';
import net, { type AddressInfo } from 'node:net';
import { nalType, nalUnits } from '../../shared/annexb';
import type { MediaEvent } from '../../shared/types';

// Framing harus cocok byte-per-byte dengan native/mirrorlab_bridge.h (little-endian):
// "MLB1" @0, u32 size @4, u32 kind @8, u32 argument @12, u64 pts_us @16, lalu `size` byte payload.
const MAGIC = 0x3142_4c4d; // "MLB1" dibaca sebagai u32 LE
const HEADER_SIZE = 24;
const MAX_PAYLOAD = 16 * 1024 * 1024;
const KIND_VIDEO = 1;
const KIND_PCM = 2;
const START_CODE = [0, 0, 0, 1];

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Parser stream `MLB1` → MediaEvent. Menahan byte parsial antar-`push`; payload selalu disalin. */
export class MediaBridgeParser {
  private readonly header = new Uint8Array(HEADER_SIZE);
  private headerFill = 0;
  private payload: Uint8Array | null = null;
  private payloadFill = 0;
  private kind = 0;
  private argument = 0;
  private pts = 0n;
  private sps: Uint8Array | null = null;
  private pps: Uint8Array | null = null;
  private dirty = false;
  private origin: bigint | null = null;

  push(chunk: Uint8Array): MediaEvent[] {
    const events: MediaEvent[] = [];
    let i = 0;
    while (i < chunk.length) {
      if (!this.payload) {
        const n = Math.min(HEADER_SIZE - this.headerFill, chunk.length - i);
        this.header.set(chunk.subarray(i, i + n), this.headerFill);
        this.headerFill += n;
        i += n;
        if (this.headerFill < HEADER_SIZE) break;
        const view = new DataView(this.header.buffer);
        if (view.getUint32(0, true) !== MAGIC) throw new Error('Frame media bridge rusak: magic salah');
        const size = view.getUint32(4, true);
        if (size < 1 || size > MAX_PAYLOAD) throw new Error(`Frame media bridge rusak: ukuran ${size}`);
        this.kind = view.getUint32(8, true);
        this.argument = view.getUint32(12, true);
        this.pts = view.getBigUint64(16, true);
        this.payload = new Uint8Array(size);
        this.payloadFill = 0;
        this.headerFill = 0;
      }
      const payload = this.payload;
      const n = Math.min(payload.length - this.payloadFill, chunk.length - i);
      payload.set(chunk.subarray(i, i + n), this.payloadFill);
      this.payloadFill += n;
      i += n;
      if (this.payloadFill === payload.length) {
        this.payload = null;
        if (this.kind === KIND_VIDEO) this.video(payload, events);
        else if (this.kind === KIND_PCM) this.pcm(payload, events);
      }
    }
    return events;
  }

  reset(): void {
    this.headerFill = 0;
    this.payload = null;
    this.payloadFill = 0;
    this.sps = null;
    this.pps = null;
    this.dirty = false;
    this.origin = null;
  }

  private video(payload: Uint8Array, events: MediaEvent[]): void {
    let slice = false;
    let idr = false;
    for (const nal of nalUnits(payload)) {
      const type = nalType(nal);
      if (type === 7) {
        if (!this.sps || !sameBytes(this.sps, nal)) {
          this.sps = nal.slice();
          this.dirty = true;
        }
      } else if (type === 8) {
        if (!this.pps || !sameBytes(this.pps, nal)) {
          this.pps = nal.slice();
          this.dirty = true;
        }
      } else if (type === 5) {
        slice = true;
        idr = true;
      } else if (type === 1) {
        slice = true;
      }
    }
    if (this.dirty && this.sps && this.pps) {
      const config = new Uint8Array(8 + this.sps.length + this.pps.length);
      config.set(START_CODE, 0);
      config.set(this.sps, 4);
      config.set(START_CODE, 4 + this.sps.length);
      config.set(this.pps, 8 + this.sps.length);
      events.push({ kind: 'video', config: true, keyFrame: false, pts: 0, rotation: 0, data: config });
      this.dirty = false;
    }
    if (!slice) return;
    const origin = (this.origin ??= this.pts);
    events.push({
      kind: 'video',
      config: false,
      keyFrame: idr,
      pts: Number(this.pts - origin),
      rotation: (this.argument & 3) as 0 | 1 | 2 | 3,
      data: payload,
    });
  }

  private pcm(payload: Uint8Array, events: MediaEvent[]): void {
    const channels = this.argument >>> 24;
    const sampleRate = this.argument & 0xff_ffff;
    const samples = payload.byteLength >> 2;
    if (!channels || !sampleRate || !samples) return;
    // `payload` adalah buffer milik parser sendiri (byteOffset 0, sudah sejajar 4 byte); host x64 = little-endian.
    events.push({ kind: 'pcm', sampleRate, channels, data: new Float32Array(payload.buffer, payload.byteOffset, samples) });
  }
}

/**
 * Server TCP localhost untuk helper native (`MIRRORLAB_MEDIA_PORT`). Hanya 1 koneksi aktif; parser baru per koneksi.
 * Event: 'media' (MediaEvent), 'error' (Error) — pemakai wajib memasang listener 'error'.
 */
export class MediaBridgeServer extends EventEmitter {
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private parser: MediaBridgeParser | null = null;

  /** Mulai listen di 127.0.0.1 port acak; resolve dengan port tersebut. */
  listen(): Promise<number> {
    const existing = this.server?.address();
    if (existing && typeof existing === 'object') return Promise.resolve(existing.port);
    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        server.on('error', (error) => this.emit('error', error));
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  /** Membuang state stream aktif (SPS/PPS, origin PTS) supaya sesi berikutnya mulai bersih. */
  resetSession(): void {
    this.parser?.reset();
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
    this.parser = null;
    this.server?.close();
    this.server = null;
  }

  private accept(socket: net.Socket): void {
    if (this.socket) {
      socket.destroy();
      return;
    }
    const parser = new MediaBridgeParser();
    this.socket = socket;
    this.parser = parser;
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => {
      let events: MediaEvent[];
      try {
        events = parser.push(chunk);
      } catch (error) {
        socket.destroy();
        this.emit('error', error);
        return;
      }
      for (const ev of events) {
        if (this.socket !== socket) return;
        this.emit('media', ev);
      }
    });
    socket.on('error', () => undefined); // 'close' selalu menyusul
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.parser = null;
    });
  }
}
