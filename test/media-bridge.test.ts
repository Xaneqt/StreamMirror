import { describe, expect, it } from 'vitest';
import { MediaBridgeParser } from '../src/main/ios/media-bridge';
import type { MediaEvent } from '../src/shared/types';

const SC = [0, 0, 0, 1];
const SPS = [0x67, 0x42, 0xe0, 0x1f, 0x8d, 0x68, 0x05, 0x00, 0x5b, 0xa1];
const PPS = [0x68, 0xce, 0x3c, 0x80];
const IDR = [0x65, 0x88, 0x84, 0x00, 0x33, 0xff, 0x12];
const NON_IDR = [0x41, 0x9a, 0x02, 0x04, 0x07];

function frame(kind: number, argument: number, pts: bigint, payload: Uint8Array, magic = 'MLB1'): Uint8Array {
  const out = new Uint8Array(24 + payload.length);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(magic), 0);
  view.setUint32(4, payload.length, true);
  view.setUint32(8, kind, true);
  view.setUint32(12, argument, true);
  view.setBigUint64(16, pts, true);
  out.set(payload, 24);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Potong `data` di batas acak (LCG ber-seed supaya test deterministik). */
function split(data: Uint8Array, seed: number): Uint8Array[] {
  const parts: Uint8Array[] = [];
  let state = seed;
  let at = 0;
  while (at < data.length) {
    state = (state * 1103515245 + 12345) >>> 0;
    const n = 1 + (state % 17);
    parts.push(data.slice(at, at + n));
    at += n;
  }
  return parts;
}

describe('MediaBridgeParser', () => {
  const key = new Uint8Array([...SC, ...SPS, ...SC, ...PPS, ...SC, ...IDR]);
  const delta = new Uint8Array([...SC, ...NON_IDR]);
  const stream = concat([frame(1, 1, 1_000_000n, key), frame(1, 1, 1_033_333n, delta)]);

  for (const seed of [1, 7, 42, 1234, 99991]) {
    it(`video: config, key, delta dengan pts relatif (seed ${seed})`, () => {
      const parser = new MediaBridgeParser();
      const events: MediaEvent[] = [];
      for (const part of split(stream, seed)) events.push(...parser.push(part));
      expect(events).toHaveLength(3);
      const [config, keyEv, deltaEv] = events;
      expect(config).toMatchObject({ kind: 'video', config: true, keyFrame: false, pts: 0, rotation: 0 });
      expect(config.kind === 'video' && [...config.data]).toEqual([...SC, ...SPS, ...SC, ...PPS]);
      expect(keyEv).toMatchObject({ kind: 'video', config: false, keyFrame: true, pts: 0, rotation: 1 });
      expect(keyEv.kind === 'video' && [...keyEv.data]).toEqual([...key]);
      expect(deltaEv).toMatchObject({ kind: 'video', config: false, keyFrame: false, pts: 33_333, rotation: 1 });
      expect(deltaEv.kind === 'video' && [...deltaEv.data]).toEqual([...delta]);
    });
  }

  it('pcm: channels dan sampleRate dari argument', () => {
    const samples = new Float32Array([0.5, -0.25, 1, -1]);
    const payload = new Uint8Array(samples.buffer);
    const parser = new MediaBridgeParser();
    // Byte pengisi di depan supaya chunk input tidak sejajar 4 byte.
    const chunk = concat([new Uint8Array(3), frame(2, (2 << 24) | 48000, 5n, payload)]).subarray(3);
    const events = parser.push(chunk);
    expect(events).toHaveLength(1);
    const [ev] = events;
    expect(ev).toMatchObject({ kind: 'pcm', channels: 2, sampleRate: 48000 });
    expect(ev.kind === 'pcm' && [...ev.data]).toEqual([0.5, -0.25, 1, -1]);
  });

  it('magic salah → throw', () => {
    const parser = new MediaBridgeParser();
    expect(() => parser.push(frame(1, 0, 0n, delta, 'XLB1'))).toThrow();
  });
});
