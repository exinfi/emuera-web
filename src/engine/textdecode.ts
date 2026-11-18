/** Text file decoding shared by the page loader and the worker (the experimental loader decodes ERB in the worker). Moved verbatim from host-web/gamezip.ts. */

/** UTF-32 (with BOM already skipped) to a string; TextDecoder has no UTF-32 */
const utf32 = (b: Uint8Array, le: boolean): string => {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let s = '';
  for (let i = 0; i + 4 <= b.length; i += 4) {
    const c = dv.getUint32(i, le);
    s += c <= 0x10ffff ? String.fromCodePoint(c) : '\ufffd';
  }
  return s;
};
/**
 * Emuera's EncodingHandler: a BOM decides (UTF-8, UTF-16 LE/BE, UTF-32 LE/BE); otherwise UTF-8 when the bytes are valid UTF-8, else Shift_JIS.
 * A UTF-8 BOM settles it as UTF-8 (a file with stray U+FFFD already in it must not be re-read as Shift_JIS). The BOM itself is dropped.
 */
export const decodeText = (b: Uint8Array): string => {
  const at = (...v: number[]) => b.length >= v.length && v.every((x, i) => b[i] === x);
  if (at(0xef, 0xbb, 0xbf)) return new TextDecoder('utf-8').decode(b);
  if (at(0xff, 0xfe, 0, 0)) return utf32(b.subarray(4), true);
  if (at(0, 0, 0xfe, 0xff)) return utf32(b.subarray(4), false);
  if (at(0xff, 0xfe)) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (at(0xfe, 0xff)) return new TextDecoder('utf-16be').decode(b.subarray(2));
  const u = new TextDecoder('utf-8').decode(b);
  return u.includes('�') ? new TextDecoder('shift_jis').decode(b) : u;
};
