/**
 * Font file reader (host-web tier, pure: no DOM, runs in Node and browsers).
 * Reads just enough of an sfnt (TrueType/OpenType, or WOFF1) to register it by family name the way Emuera
 * does and to check the half-width metric: family names, weight/italic, and the advance widths of 'A' and 'あ'.
 * WOFF2 is not read (needs Brotli); callers fall back to the file name for those.
 */
export interface FontInfo {
  /** GDI family name (name id 1): what Emuera's `ff.Name == fontname` compares */
  family: string;
  /** other names the font answers to (typographic family id 16, full name id 4) */
  aliases: string[];
  subfamily: string;
  weight: number;
  italic: boolean;
  unitsPerEm: number;
  /** advance('A') / advance('あ'); 0.5 means half-width = 0.5 em; null when a glyph is missing */
  halfWidthRatio: number | null;
  format: 'ttf' | 'otf' | 'woff';
}

import { familyKey } from '../screen';
export { familyKey };

type Tables = Map<string, DataView>;

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

async function readTables(buf: ArrayBuffer): Promise<{ tables: Tables; format: FontInfo['format'] } | null> {
  const dv = new DataView(buf);
  if (buf.byteLength < 12) return null;
  const sig = dv.getUint32(0);
  const tables: Tables = new Map();
  if (sig === 0x774f4646) {
    // 'wOFF'
    const n = dv.getUint16(12);
    for (let i = 0; i < n; i++) {
      const o = 44 + i * 20;
      const tag = String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
      const off = dv.getUint32(o + 4),
        comp = dv.getUint32(o + 8),
        orig = dv.getUint32(o + 12);
      if (off + comp > buf.byteLength) return null;
      let bytes: Uint8Array = new Uint8Array(buf, off, comp);
      if (comp < orig) bytes = await inflate(bytes);
      tables.set(tag, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    }
    const flavor = dv.getUint32(4);
    return { tables, format: flavor === 0x4f54544f ? 'otf' : 'woff' };
  }
  let base = 0;
  if (sig === 0x74746366) base = dv.getUint32(12); // 'ttcf': first font of the collection
  const s = dv.getUint32(base);
  if (s !== 0x00010000 && s !== 0x74727565 && s !== 0x4f54544f) return null; // 1.0, 'true', 'OTTO'
  const n = dv.getUint16(base + 4);
  for (let i = 0; i < n; i++) {
    const o = base + 12 + i * 16;
    const tag = String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    const off = dv.getUint32(o + 8),
      len = dv.getUint32(o + 12);
    if (off + len > buf.byteLength) return null;
    tables.set(tag, new DataView(buf, off, len));
  }
  return { tables, format: s === 0x4f54544f ? 'otf' : 'ttf' };
}

function names(t: DataView): Map<number, string> {
  const out = new Map<number, string>(),
    rank = new Map<number, number>();
  const count = t.getUint16(2),
    strOff = t.getUint16(4);
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 12;
    const plat = t.getUint16(o),
      lang = t.getUint16(o + 4),
      id = t.getUint16(o + 6),
      len = t.getUint16(o + 8),
      off = t.getUint16(o + 10);
    // prefer Windows/English, then any Windows name, then Macintosh
    const r = plat === 3 ? (lang === 0x409 ? 3 : 2) : plat === 1 ? 1 : 0;
    if (!r || (rank.get(id) ?? 0) >= r) continue;
    let s = '';
    if (plat === 3) for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(t.getUint16(strOff + off + k));
    else for (let k = 0; k < len; k++) s += String.fromCharCode(t.getUint8(strOff + off + k));
    out.set(id, s);
    rank.set(id, r);
  }
  return out;
}

/** glyph id for a code point through the cmap (formats 4 and 12) */
function glyphOf(cmap: DataView, cp: number): number {
  const n = cmap.getUint16(2);
  const subs: { plat: number; enc: number; off: number }[] = [];
  for (let i = 0; i < n; i++)
    subs.push({ plat: cmap.getUint16(4 + i * 8), enc: cmap.getUint16(6 + i * 8), off: cmap.getUint32(8 + i * 8) });
  subs.sort((a, b) => Number(b.enc === 10 || b.enc === 4) - Number(a.enc === 10 || a.enc === 4)); // prefer full-Unicode subtables
  for (const s of subs) {
    if (!(s.plat === 0 || (s.plat === 3 && (s.enc === 1 || s.enc === 10)))) continue;
    const fmt = cmap.getUint16(s.off);
    if (fmt === 12) {
      const g = cmap.getUint32(s.off + 12);
      for (let i = 0; i < g; i++) {
        const o = s.off + 16 + i * 12,
          a = cmap.getUint32(o),
          b = cmap.getUint32(o + 4);
        if (cp >= a && cp <= b) return cmap.getUint32(o + 8) + (cp - a);
      }
    } else if (fmt === 4) {
      const segX2 = cmap.getUint16(s.off + 6),
        ends = s.off + 14,
        starts = ends + segX2 + 2,
        deltas = starts + segX2,
        ranges = deltas + segX2;
      for (let i = 0; i < segX2 / 2; i++) {
        const end = cmap.getUint16(ends + i * 2);
        if (cp > end) continue;
        const start = cmap.getUint16(starts + i * 2);
        if (cp < start) break;
        const ro = cmap.getUint16(ranges + i * 2),
          delta = cmap.getInt16(deltas + i * 2);
        if (ro === 0) return (cp + delta) & 0xffff;
        const gi = cmap.getUint16(ranges + i * 2 + ro + (cp - start) * 2);
        return gi ? (gi + delta) & 0xffff : 0;
      }
    }
  }
  return 0;
}

function advance(hmtx: DataView, numH: number, gid: number): number {
  const i = Math.min(gid, numH - 1);
  return hmtx.getUint16(i * 4);
}

/** read a font file; null when it is not a font this reader understands (including WOFF2) */
export async function parseFont(buf: ArrayBuffer): Promise<FontInfo | null> {
  let r: Awaited<ReturnType<typeof readTables>>;
  try {
    r = await readTables(buf);
  } catch {
    return null;
  }
  if (!r) return null;
  const { tables: t, format } = r;
  const name = t.get('name'),
    head = t.get('head');
  if (!name || !head) return null;
  try {
    const nm = names(name);
    const family = nm.get(1) ?? nm.get(16) ?? nm.get(4);
    if (!family) return null;
    const aliases = [nm.get(16), nm.get(4)].filter((x): x is string => !!x && x !== family);
    const os2 = t.get('OS/2');
    const mac = head.getUint16(44);
    const weight = os2 ? os2.getUint16(4) : mac & 1 ? 700 : 400;
    const italic = os2 ? !!(os2.getUint16(62) & 1) : !!(mac & 2);
    const unitsPerEm = head.getUint16(18);
    let ratio: number | null = null;
    const cmap = t.get('cmap'),
      hmtx = t.get('hmtx'),
      hhea = t.get('hhea');
    if (cmap && hmtx && hhea) {
      const numH = hhea.getUint16(34);
      const ga = glyphOf(cmap, 0x41),
        gk = glyphOf(cmap, 0x3042) || glyphOf(cmap, 0x4e00);
      if (ga && gk) {
        const k = advance(hmtx, numH, gk);
        if (k > 0) ratio = Math.round((advance(hmtx, numH, ga) / k) * 1000) / 1000;
      }
    }
    return { family, aliases, subfamily: nm.get(2) ?? '', weight, italic, unitsPerEm, halfWidthRatio: ratio, format };
  } catch {
    return null;
  }
}
