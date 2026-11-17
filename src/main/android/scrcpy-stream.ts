// Parser stream scrcpy 5.0.1 (satu socket video atau audio), tanpa I/O. Semua big-endian.
// Acuan: Streamer.java dan DesktopConnection.java scrcpy tag v5.0.1.

export type ScrcpyEvent =
  | { type: 'device'; name: string }
  /** u32 BE; 0 = stream nonaktif, 1 = error di device */
  | { type: 'codec'; id: number }
  | { type: 'session'; width: number; height: number }
  | { type: 'packet'; config: boolean; keyFrame: boolean; pts: bigint; data: Uint8Array };

const DEVICE_NAME_LENGTH = 64;
const HEADER_LENGTH = 12;
const PTS_MASK = (1n << 61n) - 1n;

type Stage = 'device' | 'codec' | 'header' | 'payload' | 'ignore';

export class ScrcpyStreamParser {
  private stage: Stage;
  /** Chunk yang belum habis dibaca; `offset` menunjuk ke dalam chunks[0]. */
  private chunks: Uint8Array[] = [];
  private offset = 0;
  private available = 0;
  private packet: { config: boolean; keyFrame: boolean; pts: bigint; size: number } | null = null;

  constructor(opts: { deviceMeta: boolean }) {
    this.stage = opts.deviceMeta ? 'device' : 'codec';
  }

  push(chunk: Uint8Array): ScrcpyEvent[] {
    const events: ScrcpyEvent[] = [];
    if (this.stage === 'ignore' || chunk.length === 0) return events;
    this.chunks.push(chunk);
    this.available += chunk.length;

    for (;;) {
      if (this.stage === 'device') {
        if (this.available < DEVICE_NAME_LENGTH) break;
        const raw = this.take(DEVICE_NAME_LENGTH);
        const end = raw.indexOf(0);
        events.push({ type: 'device', name: new TextDecoder().decode(end < 0 ? raw : raw.subarray(0, end)) });
        this.stage = 'codec';
      } else if (this.stage === 'codec') {
        if (this.available < 4) break;
        const id = new DataView(this.take(4).buffer).getUint32(0);
        events.push({ type: 'codec', id });
        if (id === 0 || id === 1) {
          this.stage = 'ignore';
          this.chunks = [];
          this.offset = 0;
          this.available = 0;
          break;
        }
        this.stage = 'header';
      } else if (this.stage === 'header') {
        if (this.available < HEADER_LENGTH) break;
        const header = new DataView(this.take(HEADER_LENGTH).buffer);
        if (header.getUint8(0) & 0x80) {
          events.push({ type: 'session', width: header.getUint32(4), height: header.getUint32(8) });
        } else {
          const meta = header.getBigUint64(0);
          this.packet = {
            config: ((meta >> 62n) & 1n) === 1n,
            keyFrame: ((meta >> 61n) & 1n) === 1n,
            pts: meta & PTS_MASK,
            size: header.getUint32(8),
          };
          this.stage = 'payload';
        }
      } else if (this.stage === 'payload' && this.packet) {
        if (this.available < this.packet.size) break;
        const { config, keyFrame, pts, size } = this.packet;
        events.push({ type: 'packet', config, keyFrame, pts, data: this.take(size) });
        this.packet = null;
        this.stage = 'header';
      } else {
        break;
      }
    }
    return events;
  }

  /** Menyalin `n` byte terdepan ke buffer baru (tidak pernah alias ke buffer socket). */
  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let written = 0;
    while (written < n) {
      const chunk = this.chunks[0];
      const count = Math.min(n - written, chunk.length - this.offset);
      out.set(chunk.subarray(this.offset, this.offset + count), written);
      written += count;
      this.offset += count;
      if (this.offset === chunk.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    this.available -= n;
    return out;
  }
}
