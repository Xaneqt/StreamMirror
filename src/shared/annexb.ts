/**
 * Memecah byte stream H.264 Annex B di start code `00 00 01` / `00 00 00 01`.
 * Menghasilkan tiap NAL tanpa start code (view ke buffer asal, bukan salinan).
 */
export function* nalUnits(data: Uint8Array): Generator<Uint8Array> {
  const n = data.length;
  let start = -1;
  let i = 0;
  while (i + 2 < n) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        // Nol sebelum start code milik start code 4-byte / trailing_zero_8bits, bukan milik NAL.
        while (end > start && data[end - 1] === 0) end--;
        if (end > start) yield data.subarray(start, end);
      }
      start = i + 3;
      i += 3;
    } else {
      i++;
    }
  }
  if (start >= 0) {
    let end = n;
    while (end > start && data[end - 1] === 0) end--;
    if (end > start) yield data.subarray(start, end);
  }
}

/** Tipe NAL H.264 (5 bit bawah byte header). */
export const nalType = (nal: Uint8Array): number => nal[0] & 0x1f;
