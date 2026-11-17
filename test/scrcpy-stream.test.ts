import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '.', getPath: () => '.' } }));

import { ScrcpyStreamParser, type ScrcpyEvent } from '../src/main/android/scrcpy-stream';
import { buildServerArgs } from '../src/main/android/session';
import { DEFAULT_SETTINGS } from '../src/shared/types';

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function packet(flags: bigint, pts: bigint, payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(12);
  const view = new DataView(header.buffer);
  view.setBigUint64(0, flags | pts);
  view.setUint32(8, payload.length);
  return concat(header, payload);
}

const CONFIG = 1n << 62n;
const KEY = 1n << 61n;

describe('ScrcpyStreamParser', () => {
  it('(a) stream video sintetis: per 1 byte dan satu chunk menghasilkan event identik', () => {
    const name = new Uint8Array(64);
    name.set(new TextEncoder().encode('SM-A566B'));
    const session = new Uint8Array(12);
    session[0] = 0x80;
    new DataView(session.buffer).setUint32(4, 1080);
    new DataView(session.buffer).setUint32(8, 2340);
    const spsPps = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80]);
    const idr = new Uint8Array([0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00, 0x33]);
    const stream = concat(
      name,
      new TextEncoder().encode('h264'),
      session,
      packet(CONFIG, 0n, spsPps),
      packet(KEY, 16666n, idr),
    );

    const expected: ScrcpyEvent[] = [
      { type: 'device', name: 'SM-A566B' },
      { type: 'codec', id: 0x68323634 },
      { type: 'session', width: 1080, height: 2340 },
      { type: 'packet', config: true, keyFrame: false, pts: 0n, data: spsPps },
      { type: 'packet', config: false, keyFrame: true, pts: 16666n, data: idr },
    ];

    const whole = new ScrcpyStreamParser({ deviceMeta: true }).push(stream.slice());
    expect(whole).toEqual(expected);

    const byteParser = new ScrcpyStreamParser({ deviceMeta: true });
    const perByte: ScrcpyEvent[] = [];
    for (let i = 0; i < stream.length; i++) perByte.push(...byteParser.push(stream.slice(i, i + 1)));
    expect(perByte).toEqual(whole);
  });

  it('(b) codec id 0 → satu event codec id 0', () => {
    const parser = new ScrcpyStreamParser({ deviceMeta: false });
    const events = parser.push(concat(u32(0), packet(KEY, 1n, new Uint8Array([1, 2, 3]))));
    expect(events).toEqual([{ type: 'codec', id: 0 }]);
    expect(parser.push(new Uint8Array(32))).toEqual([]);
  });
});

describe('buildServerArgs', () => {
  it('(c) audio_source digital saja, tidak pernah mic', () => {
    const output = buildServerArgs({ ...DEFAULT_SETTINGS.android, keepPhoneAudio: false }, '0000abcd');
    expect(output).toContain('audio_source=output');
    expect(output.some((a) => a.startsWith('audio_dup'))).toBe(false);

    const playback = buildServerArgs({ ...DEFAULT_SETTINGS.android, keepPhoneAudio: true }, '0000abcd');
    expect(playback).toContain('audio_source=playback');
    expect(playback).toContain('audio_dup=true');

    for (const args of [output, playback]) {
      expect(args.some((a) => a.includes('mic'))).toBe(false);
    }
  });
});
