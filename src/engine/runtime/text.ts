/** Width helpers: Emuera pads and measures in Shift-JIS bytes (LangManager.GetByteCountLang: a char that round-trips through CP932 counts its bytes, any other char becomes '?' = 1 byte). */
let sjis2: Set<number> | undefined;
/** every double-byte code point CP932 can encode (built once from the decoder: lead 0x81-0x9F/0xE0-0xFC, trail 0x40-0xFC) */
function doubleByteSet(): Set<number> {
  if (sjis2) return sjis2;
  const s = new Set<number>();
  try {
    const d = new TextDecoder('shift_jis');
    const b = new Uint8Array(2);
    for (let lead = 0x81; lead <= 0xfc; lead++) {
      if (lead > 0x9f && lead < 0xe0) continue;
      for (let trail = 0x40; trail <= 0xfc; trail++) {
        if (trail === 0x7f) continue;
        b[0] = lead;
        b[1] = trail;
        const t = d.decode(b);
        if (t.length === 1 && t !== '�') s.add(t.charCodeAt(0));
      }
    }
  } catch {
    /* no shift_jis decoder: every non-ASCII char counts 2 (old behaviour) */ s.add(-1);
  }
  return (sjis2 = s);
}
export function sjisWidth(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80 || (c >= 0xff61 && c <= 0xff9f)) {
      n += 1;
      continue;
    }
    const set = doubleByteSet();
    n += set.has(-1) || set.has(c) ? 2 : 1;
  }
  return n;
}
