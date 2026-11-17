export interface RtpPacket {
  payloadType: number;
  sequence: number;
  timestamp: number;
  /** View ke buffer asal (bukan salinan). */
  payload: Uint8Array;
}

/** Parse paket RTP versi 2 (RFC 3550): hormati CSRC count, header extension, dan padding. Tidak valid → null. */
export function parseRtp(b: Uint8Array): RtpPacket | null {
  if (b.length < 12 || b[0] >> 6 !== 2) return null;
  let offset = 12 + (b[0] & 0x0f) * 4;
  if (offset > b.length) return null;
  if (b[0] & 0x10) {
    if (offset + 4 > b.length) return null;
    offset += 4 + ((b[offset + 2] << 8) | b[offset + 3]) * 4;
    if (offset > b.length) return null;
  }
  let end = b.length;
  if (b[0] & 0x20) {
    const padding = b[end - 1];
    if (padding === 0 || end - padding < offset) return null;
    end -= padding;
  }
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { payloadType: b[1] & 0x7f, sequence: view.getUint16(2), timestamp: view.getUint32(4), payload: b.subarray(offset, end) };
}

/** PCM L16 (S16 big-endian) → float32 (`/32768`). */
export function l16ToFloat32(payload: Uint8Array): Float32Array {
  const out = new Float32Array(payload.length >> 1);
  for (let i = 0; i < out.length; i++) {
    const v = (payload[2 * i] << 8) | payload[2 * i + 1];
    out[i] = ((v << 16) >> 16) / 32768;
  }
  return out;
}
