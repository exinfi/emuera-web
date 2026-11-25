/**
 * A thin zip reader for the game loader (the default; `THIN_ZIP` in gamezip.ts switches back to JSZip).
 * It reads the end-of-central-directory record and the central directory only, and inflates an entry when asked.
 * Names: UTF-8 flag -> UTF-8; else the Info-ZIP Unicode Path extra field (0x7075) when its CRC matches; else `decodeFileName` (the loader's `decodeZipName`).
 * Sizes, CRC and offsets come from the central directory (data descriptors need no special handling). Zip64 is supported. Methods 0 (stored) and 8 (deflate) only.
 * The object shape (`files`, `dir`, `async`, `_data.uncompressedSize`) is what GameLoader uses from a zip, and is the same as JSZip's, so either reader can be used.
 */
import pako from 'pako';

export type Bytes = Blob | Uint8Array;
export interface ThinEntry {
  name: string;
  dir: boolean;
  method: number;
  flags: number;
  crc: number;
  _data: { compressedSize: number; uncompressedSize: number };
  offset: number;
  /** where the data lives (see EntryRef) */
  ref: EntryRef;
  async(type: 'uint8array' | 'arraybuffer' | 'string', opts?: { noWindow?: boolean }): Promise<any>;
  /** the first `n` bytes of the entry's content (inflates only as much as needed); reads through the read-ahead window, for a pass over entries in file order */
  head(n: number): Promise<Uint8Array>;
}
export class ZipError extends Error {}
/** where an entry's data lives in its zip: enough to read it later (plain data, so it can be posted to a worker together with the zip's Blob) */
export interface EntryRef {
  /** offset of the entry's local header */
  offset: number;
  csize: number;
  /** 0 stored, 8 deflate */
  method: number;
  /** length of the name in the central directory (a guess for the local header's, which is checked) */
  nameLen: number;
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export const crc32 = (b: Uint8Array): number => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const sizeOf = (b: Bytes) => ('size' in b ? b.size : b.byteLength);
/** a Blob is read through a read-ahead window: the loader walks entries in file order, so one slice serves many small entries (a file-backed Blob pays per slice call) */
const WINDOW = 8 * 1024 * 1024;
const windows = new WeakMap<Blob, { start: number; data: Uint8Array }>();
const slice = async (b: Bytes, start: number, end: number, win = true): Promise<Uint8Array> => {
  if (!('size' in b)) return b.subarray(start, end);
  if (!win) return new Uint8Array(await b.slice(start, end).arrayBuffer());
  const w = windows.get(b);
  if (w && start >= w.start && end <= w.start + w.data.length) return w.data.subarray(start - w.start, end - w.start);
  if (end - start >= WINDOW) return new Uint8Array(await b.slice(start, end).arrayBuffer());
  const to = Math.min(b.size, Math.max(end, start + WINDOW));
  const data = new Uint8Array(await b.slice(start, to).arrayBuffer());
  windows.set(b, { start, data });
  return data.subarray(0, end - start);
};

/** one entry's compressed bytes. `win` = read through the read-ahead window (a pass over entries in file order); otherwise one exact slice for header and data together (each slice of a file-backed Blob has a fixed cost) */
async function readRaw(src: Bytes, r: EntryRef, name: string, win: boolean): Promise<Uint8Array> {
  if (win) {
    const lh = await slice(src, r.offset, r.offset + 30);
    const lv = new DataView(lh.buffer, lh.byteOffset, lh.byteLength);
    if (lv.getUint32(0, true) !== 0x04034b50) throw new ZipError(`"${name}": bad local header`);
    const start = r.offset + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
    return slice(src, start, start + r.csize);
  }
  const first = await slice(src, r.offset, r.offset + 30 + r.nameLen + 256 + r.csize, false);
  const fv = new DataView(first.buffer, first.byteOffset, first.byteLength);
  if (first.length < 30 || fv.getUint32(0, true) !== 0x04034b50) throw new ZipError(`"${name}": bad local header`);
  const ds = 30 + fv.getUint16(26, true) + fv.getUint16(28, true);
  return ds + r.csize <= first.length
    ? first.subarray(ds, ds + r.csize)
    : slice(src, r.offset + ds, r.offset + ds + r.csize, false);
}
/** an entry's content as an ArrayBuffer, read from its zip (one exact slice; for reads in no particular order). Used by the worker to fetch a resource image on first use. */
export async function readEntryRef(src: Bytes, r: EntryRef, name = 'entry'): Promise<ArrayBuffer> {
  if (r.method !== 0 && r.method !== 8) throw new ZipError(`"${name}": unsupported compression method ${r.method}`);
  const raw = await readRaw(src, r, name, false);
  return exact(r.method === 0 ? raw : (pako.inflateRaw(raw) as Uint8Array));
}

/**
 * The first `n` bytes of many entries' content, read in ONE forward pass over the zip: slices of the read-ahead size taken in file order, each
 * entry's head cut out of the slice it falls in, the slice then dropped. A slice starts at the first entry not yet done, so reads only move
 * forward and skip what lies between. Few reads (a file-backed Blob pays per read, and on some devices far more for a small read at a scattered
 * place than for a large forward one), nothing kept but what `each` keeps. `each` gets undefined for an entry whose local header is not where
 * the central directory says, or whose method is not stored or deflate.
 */
export async function sweepHeads(
  src: Bytes,
  refs: EntryRef[],
  n: number,
  each: (i: number, head: Uint8Array | undefined) => void,
  onProgress?: (done: number, total: number) => void,
  sliceSize = WINDOW,
): Promise<{ reads: number; bytes: number }> {
  const order = refs.map((_, i) => i).sort((a, b) => refs[a].offset - refs[b].offset);
  const total = sizeOf(src);
  let k = 0,
    reads = 0,
    bytes = 0;
  const read = async (a: number, b: number) => {
    const d = 'size' in src ? new Uint8Array(await src.slice(a, b).arrayBuffer()) : src.subarray(a, b);
    reads++;
    bytes += d.length;
    return d;
  };
  const headOf = (r: EntryRef, raw: Uint8Array) => {
    if (n !== Infinity) return r.method === 0 ? raw.slice(0, n) : r.method === 8 ? inflatePrefix(raw, n) : undefined;
    try {
      return r.method === 0 ? raw.slice() : r.method === 8 ? (pako.inflateRaw(raw) as Uint8Array) : undefined;
    } catch {
      return undefined; // a damaged stream: the caller reports the file
    }
  };
  while (k < order.length) {
    const start = refs[order[k]].offset;
    const end = Math.min(total, start + sliceSize);
    const data = await read(start, end);
    const from = k;
    while (k < order.length) {
      const r = refs[order[k]];
      const lo = r.offset - start;
      if (lo + 30 > data.length) break;
      const dv = new DataView(data.buffer, data.byteOffset + lo, 30);
      if (dv.getUint32(0, true) !== 0x04034b50) {
        each(order[k++], undefined);
        continue;
      }
      const ds = lo + 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
      const want = Math.min(r.csize, r.method === 0 ? n : n + 2048);
      if (ds + want > data.length && end < total) break; // runs past this slice: the next slice starts at this entry
      each(order[k++], headOf(r, data.subarray(ds, Math.min(data.length, ds + want))));
    }
    if (k === from) {
      // the first entry's head is longer than a whole slice (only with a slice smaller than `n`): read exactly what it needs, still forward
      const r = refs[order[k]];
      const dv = data.length >= 30 ? new DataView(data.buffer, data.byteOffset, 30) : undefined;
      if (dv && dv.getUint32(0, true) === 0x04034b50) {
        const ds = 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
        const want = Math.min(r.csize, r.method === 0 ? n : n + 2048);
        const all = await read(start, Math.min(total, start + ds + want));
        each(order[k++], headOf(r, all.subarray(ds)));
      } else each(order[k++], undefined);
    }
    onProgress?.(k, order.length);
  }
  return { reads, bytes };
}

/** every entry's whole content, read in one forward pass (`sweepHeads` with no length limit); `each` gets undefined for an entry that cannot be read (bad header, damaged stream, unknown method) */
export const sweepFull = (
  src: Bytes,
  refs: EntryRef[],
  each: (i: number, bytes: Uint8Array | undefined) => void,
  onProgress?: (done: number, total: number) => void,
  sliceSize = WINDOW,
) => sweepHeads(src, refs, Infinity, each, onProgress, sliceSize);

/** the first `n` bytes a deflate stream's prefix inflates to (the prefix may be cut anywhere; whatever inflates before the cut is returned) */
function inflatePrefix(raw: Uint8Array, n: number): Uint8Array {
  const parts: Uint8Array[] = [];
  const inf = new pako.Inflate({ raw: true });
  inf.onData = (c: Uint8Array) => parts.push(c.slice());
  try {
    inf.push(raw, 2); // Z_SYNC_FLUSH: hand over what the prefix inflates to
  } catch {
    /* a cut stream is expected */
  }
  const out = new Uint8Array(parts.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const c of parts) {
    out.set(c, o);
    o += c.length;
  }
  return out.subarray(0, Math.min(out.length, n));
}

/** a synchronous slice, for the worker (the engine asks an image's size synchronously). A Blob needs `FileReaderSync` (workers only); without it, undefined. */
function sliceSync(b: Bytes, start: number, end: number): Uint8Array | undefined {
  if (!('size' in b)) return b.subarray(start, end);
  const FRS = (globalThis as { FileReaderSync?: new () => { readAsArrayBuffer(b: Blob): ArrayBuffer } }).FileReaderSync;
  if (!FRS) return undefined;
  return new Uint8Array(new FRS().readAsArrayBuffer(b.slice(start, end)));
}
/** an entry's compressed data, read synchronously with one slice for local header and data together (a second only if the local header's extra field is unusually long) */
function readRawSync(src: Bytes, r: EntryRef, want: number, name: string): Uint8Array | undefined {
  const first = sliceSync(src, r.offset, r.offset + 30 + r.nameLen + 256 + want);
  if (!first) return undefined;
  const fv = new DataView(first.buffer, first.byteOffset, first.byteLength);
  if (first.length < 30 || fv.getUint32(0, true) !== 0x04034b50) throw new ZipError(`"${name}": bad local header`);
  const ds = 30 + fv.getUint16(26, true) + fv.getUint16(28, true);
  return ds + want <= first.length || first.length < 30 + r.nameLen + 256 + want
    ? first.subarray(ds, ds + want)
    : sliceSync(src, r.offset + ds, r.offset + ds + want);
}
/** the first `n` bytes of an entry's content, read synchronously (the worker's header sniff for an image left in its zip: only these bytes are read, never the whole file). Undefined if the source cannot be read synchronously. */
export function readHeadSync(src: Bytes, r: EntryRef, n: number, name = 'entry'): Uint8Array | undefined {
  if (r.method !== 0 && r.method !== 8) throw new ZipError(`"${name}": unsupported compression method ${r.method}`);
  const raw = readRawSync(src, r, Math.min(r.csize, r.method === 0 ? n : Math.max(4 * n, 8192)), name);
  if (!raw) return undefined;
  return r.method === 0 ? raw.slice(0, n) : inflatePrefix(raw, n);
}
/** an entry's whole content, read synchronously (the rare fallback when a header does not hold the size). Undefined if the source cannot be read synchronously. */
export function readEntrySync(src: Bytes, r: EntryRef, name = 'entry'): Uint8Array | undefined {
  if (r.method !== 0 && r.method !== 8) throw new ZipError(`"${name}": unsupported compression method ${r.method}`);
  const raw = readRawSync(src, r, r.csize, name);
  if (!raw) return undefined;
  return r.method === 0 ? raw : (pako.inflateRaw(raw) as Uint8Array);
}

const exact = (u: Uint8Array): ArrayBuffer =>
  u.byteOffset === 0 && u.byteLength === u.buffer.byteLength
    ? (u.buffer as ArrayBuffer)
    : (u.slice().buffer as ArrayBuffer);

export async function loadThin(
  src: Bytes,
  opts: { decodeFileName?: (b: Uint8Array) => string; verifyCrc?: boolean } = {},
): Promise<{ files: Record<string, ThinEntry> }> {
  const size = sizeOf(src);
  if (size < 22) throw new ZipError('not a zip file (too small)');
  // ---- end of central directory (the last 22 bytes plus a comment of up to 65535 bytes)
  const tailLen = Math.min(size, 22 + 65535 + 20 + 56);
  const tail = await slice(src, size - tailLen, size);
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === 0x06054b50 && i + 22 + tv.getUint16(i + 20, true) <= tail.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('not a zip file (no end-of-central-directory record)');
  let total = tv.getUint16(eocd + 10, true),
    cdSize = tv.getUint32(eocd + 12, true),
    cdOff = tv.getUint32(eocd + 16, true);
  if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && tv.getUint32(loc, true) === 0x07064b50) {
      const z64At = Number(tv.getBigUint64(loc + 8, true));
      const z = await slice(src, z64At, z64At + 56);
      const zv = new DataView(z.buffer, z.byteOffset, z.byteLength);
      if (zv.getUint32(0, true) !== 0x06064b50) throw new ZipError('bad zip64 end-of-central-directory record');
      total = Number(zv.getBigUint64(32, true));
      cdSize = Number(zv.getBigUint64(40, true));
      cdOff = Number(zv.getBigUint64(48, true));
    }
  }
  // ---- central directory
  const cd = await slice(src, cdOff, cdOff + cdSize);
  const dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const files: Record<string, ThinEntry> = {};
  const u8 = new TextDecoder('utf-8');
  let p = 0;
  for (let n = 0; n < total && p + 46 <= cd.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new ZipError('corrupt central directory');
    const vmb = dv.getUint16(p + 4, true),
      flags = dv.getUint16(p + 8, true),
      method = dv.getUint16(p + 10, true),
      crc = dv.getUint32(p + 16, true);
    let csize = dv.getUint32(p + 20, true),
      usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true),
      extraLen = dv.getUint16(p + 30, true),
      commentLen = dv.getUint16(p + 32, true),
      ext = dv.getUint32(p + 38, true);
    let offset = dv.getUint32(p + 42, true);
    const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
    // extra fields: zip64 sizes (0x0001) and the Unicode Path (0x7075)
    let uniPath: string | undefined;
    for (let q = p + 46 + nameLen, end = q + extraLen; q + 4 <= end; ) {
      const id = dv.getUint16(q, true),
        len = dv.getUint16(q + 2, true);
      let r = q + 4;
      if (id === 0x0001) {
        if (usize === 0xffffffff) {
          usize = Number(dv.getBigUint64(r, true));
          r += 8;
        }
        if (csize === 0xffffffff) {
          csize = Number(dv.getBigUint64(r, true));
          r += 8;
        }
        if (offset === 0xffffffff) {
          offset = Number(dv.getBigUint64(r, true));
          r += 8;
        }
      } else if (id === 0x7075 && len >= 5 && dv.getUint8(r) === 1 && dv.getUint32(r + 1, true) === crc32(nameBytes)) {
        uniPath = u8.decode(cd.subarray(r + 5, q + 4 + len));
      }
      q += 4 + len;
    }
    let name: string;
    if (flags & 0x0800) name = u8.decode(nameBytes);
    else if (uniPath !== undefined) name = uniPath;
    else name = opts.decodeFileName ? opts.decodeFileName(nameBytes) : u8.decode(nameBytes);
    const host = vmb >> 8;
    let dir = false;
    if (host === 0) dir = !!(ext & 0x10);
    else if (host === 3) dir = !!((ext >>> 16) & 0x4000);
    if (!dir && name.endsWith('/')) dir = true;
    const e: ThinEntry = {
      name,
      dir,
      method,
      flags,
      crc,
      offset,
      ref: { offset, csize, method, nameLen },
      _data: { compressedSize: csize, uncompressedSize: usize },
      head: async (n) => {
        if (flags & 1 || (method !== 0 && method !== 8)) throw new ZipError(`"${name}": cannot read`);
        const lh = await slice(src, offset, offset + 30);
        const lv = new DataView(lh.buffer, lh.byteOffset, lh.byteLength);
        if (lv.getUint32(0, true) !== 0x04034b50) throw new ZipError(`"${name}": bad local header`);
        const start = offset + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
        if (method === 0) return (await slice(src, start, start + Math.min(csize, n))).slice();
        const raw = await slice(src, start, start + Math.min(csize, Math.max(4 * n, 8192)));
        return inflatePrefix(raw, n);
      },
      async: async (type, o) => {
        if (flags & 1) throw new ZipError(`"${name}" is encrypted`);
        if (method !== 0 && method !== 8) throw new ZipError(`"${name}": unsupported compression method ${method}`);
        const raw = await readRaw(src, { offset, csize, method, nameLen }, name, !o?.noWindow);
        const out = method === 0 ? raw : (pako.inflateRaw(raw) as Uint8Array);
        if (opts.verifyCrc && crc32(out) !== crc) throw new ZipError(`"${name}": CRC mismatch`);
        if (type === 'uint8array') return out;
        if (type === 'arraybuffer') return exact(out);
        return u8.decode(out);
      },
    };
    files[name] = e; // a repeated name keeps the later entry (as JSZip does)
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { files };
}
