import { describe, expect, it } from 'vitest';
import { l16ToFloat32, parseRtp } from '../src/main/ios/rtp';

describe('parseRtp', () => {
  it('pt 97 dengan CSRC, extension dan padding → payload benar', () => {
    const packet = new Uint8Array([
      0x80 | 0x20 | 0x10 | 0x01, // V=2, P=1, X=1, CC=1
      97, // M=0, PT=97
      0x12, 0x34, // sequence
      0xde, 0xad, 0xbe, 0xef, // timestamp
      0x00, 0x00, 0x00, 0x04, // SSRC
      0x00, 0x00, 0x00, 0x05, // CSRC
      0xbe, 0xde, 0x00, 0x01, // extension: profile, panjang 1 word
      0x10, 0x20, 0x30, 0x40, // data extension
      0x01, 0x02, 0x03, 0x04, // payload
      0x00, 0x00, 0x03, // padding 3 byte
    ]);
    const rtp = parseRtp(packet);
    expect(rtp).not.toBeNull();
    expect(rtp?.payloadType).toBe(97);
    expect(rtp?.sequence).toBe(0x1234);
    expect(rtp?.timestamp).toBe(0xdeadbeef);
    expect([...(rtp?.payload ?? [])]).toEqual([1, 2, 3, 4]);
  });

  it('versi bukan 2 → null', () => {
    expect(parseRtp(new Uint8Array(12))).toBeNull();
  });
});

describe('l16ToFloat32', () => {
  it('S16BE → float32', () => {
    const out = l16ToFloat32(new Uint8Array([0x7f, 0xff, 0x80, 0x00]));
    expect(out).toHaveLength(2);
    expect(out[0]).toBeCloseTo(0.99997, 5);
    expect(out[1]).toBe(-1);
  });
});
