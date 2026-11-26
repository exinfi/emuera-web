/** Game zip reader (host-web tier). Takes a File/Blob (not a path); no DOM access. */
import JSZip from 'jszip';
import { decodeText } from '../../engine/textdecode';
import type { ImageRef } from '../protocol';
import { loadThin, sweepHeads, sweepFull, type EntryRef } from './zipindex';
import { sniffSize } from '../../engine/runtime/imagestore';

/**
 * The zip reader. `true` (the default) uses the thin reader in zipindex.ts: it reads the central directory only, inflates one entry at a
 * time and holds no copy of the archive. `false` goes back to JSZip (same results, slower and heavier on a large game; lazy images need the thin reader and are ignored).
 */
export const THIN_ZIP = true;
type ZObj = any;
const openZip = async (blob: Bytes): Promise<{ files: Record<string, ZObj> }> =>
  THIN_ZIP
    ? loadThin(blob, { decodeFileName: decodeZipName })
    : ((await JSZip.loadAsync(blob, { decodeFileName: decodeZipName })) as unknown as { files: Record<string, ZObj> });

export interface GameFiles {
  erb: Record<string, string>;
  csv: Record<string, string>;
  rescsv: Record<string, string>;
  texts: Record<string, string>;
  images: Record<string, ArrayBuffer>;
  /** option `lazyImages`: images by reference (no image bytes are read at load; the worker reads a header for the size when first asked, and the bytes on first use). Then `images` holds none of them; `imageSources[ref.src]` is the zip each one lives in */
  imageRefs?: Record<string, ImageRef>;
  /** the zips that `imageRefs` point into (`ref.src` is an index into this list) */
  imageSources?: Bytes[];
  /** lower-cased path under sound/ -> blob */
  sounds: Map<string, Blob>;
  /** .ttf and .otf files under font/ (Emuera EM+EE loads these into its private font collection) */
  fonts: { path: string; data: ArrayBuffer }[];
  /** paths of files in the zip that were not loaded (outside the folders and types the loader takes, dev folders left out); the engine names them when a game asks for one */
  unloaded?: string[];
  /** the base game's own erb and csv, before any pack was merged: card identity is computed from these (the same objects as erb/csv when no pack is loaded) */
  base: { erb: Record<string, string | number>; csv: Record<string, string> };
  /** low memory loader only (`GameLoader` option `erbBytes`): ERB/ERH as raw file bytes instead of decoded strings (`erb` is then empty); the worker decodes them one file at a time */
  erbBytes?: Record<string, ArrayBuffer>;
}

export const SND_EXT = /\.(wav|ogg|oga|mp3|flac|m4a|aac|opus|wma|mid)$/i;
export const IMG_EXT = /\.(webp|png|jpe?g|gif|bmp)$/i;

export { decodeText };

/**
 * Zip entry names: UTF-8 when the flag is set (JSZip does that itself); a name without the flag is read as UTF-8 if the bytes are valid UTF-8,
 * else as Shift_JIS (zips made on Japanese Windows with older tools). Used for the game zip and for packs.
 */
export const decodeZipName = (b: Uint8Array): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return new TextDecoder('shift_jis').decode(b);
  }
};
/** every path is kept in composed form (NFC): a zip made on macOS stores Japanese names decomposed, and the game builds its folder names composed */
export const nfc = (s: string): string => s.normalize('NFC');

/** a single wrapper folder around erb/csv/resources is stripped (kept for callers that handle one path at a time; readGameZip uses detectRoot) */
export const stripWrapper = (name: string): string =>
  name.replace(/^[^/]+\/(?=(erb|csv|resources|dat|sound|font)\/)/i, '');

// ------------------------------------------------------------------ root detection
const GAME_MARKERS = ['erb', 'csv'];
export const PACK_MARKERS = ['erb', 'csv', 'resources', 'sound', 'font', 'dat'];
/** shown when a pack has none of the folders above: a pack has to be laid out like the game folder */
export const PACK_STRUCTURE_HELP =
  'A pack is laid out like the game folder: put the files in folders named erb/, csv/, resources/ (images), sound/, font/ or dat/, and zip it again.';
export interface RootResult {
  root: string | null;
  note: string;
  folders: string[];
}
/**
 * Find the folder that holds the game: the shortest prefix with one of the marker folders directly under it (case-insensitive).
 * Equal depth: the prefix with the most .erb files under it; still equal: the first by name. `root` is '' for a zip whose top level is the game.
 * Names with backslashes are treated as slashes. Directory entries are ignored.
 */
export function detectRoot(names: string[], markers: string[] = GAME_MARKERS): RootResult {
  const found = new Map<string, { depth: number; erb: number }>();
  const tops = new Set<string>();
  for (const raw of names) {
    const parts = raw
      .replace(/\\/g, '/')
      .split('/')
      .filter((s) => s !== '');
    if (parts.length < 2) continue;
    if (tops.size < 6) tops.add(parts[0]);
    for (let i = 0; i < parts.length - 1; i++) {
      if (!markers.includes(parts[i].toLowerCase())) continue;
      const prefix = parts.slice(0, i).join('/');
      const e = found.get(prefix) ?? { depth: i, erb: 0 };
      if (parts[i].toLowerCase() === 'erb' && /\.erb$/i.test(parts[parts.length - 1])) e.erb++;
      found.set(prefix, e);
      break;
    }
  }
  const folders = [...tops];
  if (!found.size) return { root: null, note: '', folders };
  const all = [...found.entries()].sort(
    (a, b) => a[1].depth - b[1].depth || b[1].erb - a[1].erb || (a[0] < b[0] ? -1 : 1),
  );
  const best = all[0],
    tie = all.filter((x) => x[1].depth === best[1].depth);
  const note =
    tie.length > 1
      ? `Several game folders found at the same depth (${tie.map((x) => x[0] || '(top)').join(', ')}); using "${best[0] || '(top)'}" (most ERB files).`
      : '';
  return { root: best[0], note, folders };
}
/** path relative to the root, or null when the path is outside it */
export function relativeTo(root: string, name: string): string | null {
  const n = name.replace(/\\/g, '/');
  if (!root) return n;
  return n.startsWith(root + '/') ? n.slice(root.length + 1) : null;
}

// ------------------------------------------------------------------ classification (also used by the pack list)
export type FileKind = 'code' | 'data' | 'image' | 'audio' | 'font' | 'text' | 'ignored';
/** what the loader does with a path relative to the game root */
export function classify(rel: string): FileKind {
  if (/^erb\//i.test(rel) && /\.(erb|erh)$/i.test(rel)) return 'code';
  if ((/^csv\//i.test(rel) && /\.(csv|erd|config)$/i.test(rel)) || /\.erd$/i.test(rel)) return 'data';
  if (/^resources\//i.test(rel) && /\.csv$/i.test(rel)) return 'data';
  if (/^emuera\.config$/i.test(rel)) return 'data'; // the user config next to the exe: read between _default.config and _fixed.config (ConfigData.LoadConfig)
  if (/^setting\.json$/i.test(rel)) return 'data'; // Emuera.NET game config (selects the engine profile)
  if (/^font\//i.test(rel) && /\.(ttf|otf)$/i.test(rel)) return 'font';
  if (/^sound\//i.test(rel) && SND_EXT.test(rel)) return 'audio';
  if (/^resources\//i.test(rel) && IMG_EXT.test(rel)) return 'image';
  if (/^(dat|erb|csv|resources)\//i.test(rel) && /\.txt$/i.test(rel)) return 'text';
  // LOADTEXT reads any file whose extension the game's config lists (LOADTEXTとSAVETEXTで使える拡張子); the config is not known here, so the usual
  // data extensions under dat/ are kept. AnonTW loads its dat/schema.xml + dat/bbas_dataset.xml through LOADTEXT + DT_FROMXML.
  if (/^dat\//i.test(rel) && /\.(xml|json|ini|tsv|csv|html?)$/i.test(rel)) return 'text';
  return 'ignored';
}

/** one zip in the load order: the game itself first, then packs top to bottom */
export type Bytes = Blob | Uint8Array;
const sizeOf = (b: Bytes) => ('size' in b ? b.size : b.byteLength);
export interface Source {
  name: string;
  blob: Bytes;
  markers?: string[];
}

export class NoGameError extends Error {}

const CAP = 200;
/** extra files a game can read at run time: text-like (LOADTEXT) or images; executables, archives, documents are never taken */
const EXTRA_EXT = /\.(txt|xml|json|ini|tsv|csv|html?|webp|png|jpe?g|gif|bmp)$/i;
/** top-level folders that are developer material, not game data, even when a literal happens to mention them */
const EXTRA_DENY = /^(\.|#|docs?$|backups?$|bak$|old$|src$|source$|tools?$|patch(es)?$)/i;
/** budget for those extra files (bytes read) */
const EXTRA_CAP = 20 * 1024 * 1024;
/** most skipped names kept for the note */
const SKIPPED_CAP = 20000;
/** a string literal that starts with a folder name: `"Folder/file.ext"`, `@"Folder/%X%.webp"` or `"Folder/"` */
const REF_RE = /["']([^"'\\/%{}\s,;:()<>]{1,40})[\\/](?:["']|[^"'\n]{0,120}?\.[A-Za-z0-9]{2,5}["'])/g;
/**
 * Builds one file set from the game zip and then packs. Sources apply in the order they are added and a later source overwrites an
 * earlier one on any path clash (paths compare case-insensitively). `log` receives the source list and every clash (first CAP).
 * The first source added is the game: its erb/csv are snapshotted as `files.base` (card identity), so packs can be chosen per game after the game is read.
 */
export class GameLoader {
  readonly files: GameFiles = {
    erb: {},
    csv: {},
    rescsv: {},
    texts: {},
    images: {},
    sounds: new Map(),
    fonts: [],
    base: { erb: {}, csv: {} },
  };
  private owner = new Map<string, string>(); // lower-cased "<table>:<path>" -> source that supplied the winning copy
  private clashes = 0;
  /** the exact key each loaded file is stored under, by `table:lower-cased path`: an override removes the earlier copy with one lookup instead of a walk over the table */
  private keyOf = new Map<string, string>();
  private n = 0;
  /** low memory loader: keep ERB/ERH as bytes (see GameFiles.erbBytes); each file is decoded once here only to learn its string length, which card identity needs */
  private readonly bytesMode: boolean;
  private readonly lazyImages: boolean;
  /** where an image's data is, from the central directory alone: no image bytes are read at load (the worker reads a header when the game first asks the size) */
  private makeRef(f: ZObj, ext: string, srcIndex: number): ImageRef {
    return { src: srcIndex, ...f.ref, ext, size: f._data.uncompressedSize };
  }
  private erbLen: Record<string, number> = {};
  /** files `classify` ignored but whose extension a game can read at run time (text-like or image), by lower-cased path; the entry is kept, not read */
  private pending = new Map<string, { rel: string; f: ZObj; src: string; si: number }>();
  /** lower-cased first folder names that string literals in the game's code point into (`"dat/x.xml"`, `@"Folder/%N%.webp"`, `"Folder/"`) */
  private refs = new Set<string>();
  private extraBytes = 0;
  /** every skipped file outside developer folders, by lower-cased path (capped), for the engine's "asked for a file that was not loaded" note */
  private skipped = new Map<string, string>();
  /** option `xrefs` (default on): also load the files the fixed folders do not cover. With the thin reader every text-like one is taken (`registerExtras`); without it the game's code is scanned for folder names and the files in them are loaded within a size budget (`loadReferenced`). When off those files are only listed so a miss can be explained */
  private readonly scanReferences: boolean;
  /** `scanReferences` with the thin reader: every text-like file outside the usual folders is read in one forward pass over its zip while loading (no folder guess, no size cap) */
  private readonly sweepTexts: boolean;
  /** what the extra file check took, for the debug list (`extrasSummary`) */
  private readonly xs = {
    folders: new Map<string, number>(),
    texts: 0,
    bytes: 0,
    reads: 0,
    imgRef: 0,
    imgNow: 0,
    unreadable: 0,
    denied: 0,
    capSkipped: 0,
    notNamed: 0,
  };
  /** the zip of each source, by source index (the text sweep reads from it) */
  private blobs: Bytes[] = [];
  constructor(
    private log?: (line: string) => void,
    opts: { erbBytes?: boolean; scanReferences?: boolean; lazyImages?: boolean } = {},
  ) {
    this.lazyImages = THIN_ZIP && !!opts.lazyImages;
    this.sweepTexts = THIN_ZIP && !!opts.scanReferences;
    if (this.lazyImages) this.files.imageRefs = {};
    if (this.lazyImages) this.files.imageSources = [];
    this.bytesMode = !!opts.erbBytes;
    this.scanReferences = !!opts.scanReferences;
    if (this.bytesMode) this.files.erbBytes = {};
  }

  async add(src: Source, onProgress?: (done: number, total: number) => void): Promise<void> {
    const out = this.files,
      si = this.n++;
    const z = await openZip(src.blob);
    this.blobs[si] = src.blob;
    if (this.lazyImages) this.files.imageSources![si] = src.blob;
    const entries = Object.entries(z.files).filter(([, f]) => !f.dir);
    const r = detectRoot(
      entries.map(([n]) => n),
      src.markers ?? (si === 0 ? GAME_MARKERS : PACK_MARKERS),
    );
    if (r.root === null) {
      const seen = r.folders.length ? ` Top-level folders found: ${r.folders.join(', ')}.` : '';
      throw new NoGameError(
        si === 0
          ? `No game found in "${src.name}": expected an ERB/ or CSV/ folder at the top level or inside a folder.${seen}`
          : `Pack "${src.name}" has none of erb/, csv/, resources/, sound/, font/ or dat/ at the top level or inside a folder.${seen} ${PACK_STRUCTURE_HELP}`,
      );
    }
    if (r.note) this.log?.(`${src.name}: ${r.note}`);
    this.log?.(
      `source ${si}: ${src.name} (${(sizeOf(src.blob) / 1048576).toFixed(1)} MB, ${entries.length} files, root "${r.root || '/'}")`,
    );
    let i = 0;
    for (const [name, f] of entries) {
      if (++i % 400 === 0) {
        onProgress?.(i, entries.length);
        await new Promise((res) => setTimeout(res));
      }
      const rr = relativeTo(r.root, name);
      if (rr === null) continue;
      const rel = nfc(rr);
      const kind = classify(rel);
      if (kind === 'ignored') {
        const top = rel.indexOf('/') > 0 ? rel.slice(0, rel.indexOf('/')).toLowerCase() : '';
        if (EXTRA_DENY.test(top) && EXTRA_EXT.test(rel)) this.xs.denied++;
        if (!EXTRA_DENY.test(top) && this.skipped.size < SKIPPED_CAP)
          this.skipped.set(rel.toLowerCase().replace(/\\/g, '/'), rel);
        // a file at the zip's top level (FLconfig.xml next to the exe) counts too, but only on the thin path, where reading it costs one slice of the sweep
        if ((top || this.sweepTexts) && EXTRA_EXT.test(rel) && !EXTRA_DENY.test(top))
          this.pending.set(rel.toLowerCase(), { rel, f, src: src.name, si });
        continue;
      }
      const lc = rel.toLowerCase();
      const table =
        kind === 'audio'
          ? 'a'
          : kind === 'font'
            ? 'f'
            : kind === 'image'
              ? 'i'
              : kind === 'text'
                ? 't'
                : kind === 'code'
                  ? 'e'
                  : /^resources\//i.test(rel)
                    ? 'r'
                    : 'c';
      const k = table + ':' + lc;
      const prev = this.owner.get(k);
      if (prev !== undefined) {
        this.clashes++;
        if (this.clashes <= CAP) this.log?.(`${rel}: overridden ${prev} -> ${src.name}`);
        dropEarlier(out, table, lc, this.keyOf.get(k)); // the earlier copy may differ only in case
        if (table === 'e') for (const p of Object.keys(this.erbLen)) if (p.toLowerCase() === lc) delete this.erbLen[p];
      }
      this.owner.set(k, src.name);
      this.keyOf.set(k, rel);
      if (table === 'e' && this.bytesMode) {
        const ab = await f.async('arraybuffer');
        const t = decodeText(new Uint8Array(ab));
        this.erbLen[rel] = t.length;
        this.scanRefs(t);
        out.erbBytes![rel] = ab;
      } else if (table === 'e') {
        const t = decodeText(await f.async('uint8array'));
        this.scanRefs(t);
        out.erb[rel] = t;
      } else if (table === 'r') out.rescsv[rel] = decodeText(await f.async('uint8array'));
      else if (table === 'c') out.csv[rel] = decodeText(await f.async('uint8array'));
      else if (table === 'f') out.fonts.push({ path: rel, data: await f.async('arraybuffer') });
      else if (table === 'a')
        out.sounds.set(rel.slice(6).replace(/\\/g, '/').toLowerCase(), new Blob([await f.async('arraybuffer')]));
      else if (table === 'i') {
        if (this.lazyImages) out.imageRefs![rel] = this.makeRef(f, rel.split('.').pop()!.toLowerCase(), si);
        else out.images[rel] = await f.async('arraybuffer');
      } else out.texts[rel.replace(/\\/g, '/')] = decodeText(await f.async('uint8array'));
    }
    await this.loadReferenced(onProgress);
    if (si === 0) out.base = { erb: this.bytesMode ? { ...this.erbLen } : { ...out.erb }, csv: { ...out.csv } };
  }
  /** note the folders string literals in this code name; only folders that also exist in a zip matter, which removes the noise of dialogue that merely contains a slash */
  private scanRefs(code: string): void {
    if (!this.scanReferences || this.sweepTexts) return; // the sweep takes every such file, so the folder guess is not needed
    for (const m of code.matchAll(REF_RE)) this.refs.add(nfc(m[1]).toLowerCase());
  }
  /**
   * The thin-reader form of `loadReferenced` (option `xrefs`). Every text-like file outside the usual folders (developer folders already left
   * out) is read in one forward pass over its zip and decoded into `texts`: no folder guess and no size cap, and the game's LOADTEXT, EXISTFILE and
   * ENUMFILES find them like any loaded file. Reading in file order means a few large reads however many files there are (a small read at a
   * scattered place is very slow on some phones). Images among them follow the image option: by reference when images are read on demand, else read
   * now (within the old cap).
   */
  private async registerExtras(onProgress?: (done: number, total: number) => void): Promise<void> {
    const out = this.files,
      taken = new Map<string, number>();
    const texts: { key: string; ref: EntryRef; si: number; rel: string }[] = [];
    let eagerImgs = 0;
    for (const [lc, e] of [...this.pending]) {
      const isImg = IMG_EXT.test(e.rel);
      const size = (e.f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
      const rel = nfc(e.rel);
      const slash = e.rel.indexOf('/');
      const top = slash > 0 ? nfc(e.rel.slice(0, slash)).toLowerCase() : ''; // '' = a file at the top of the zip
      if (isImg && !this.lazyImages) {
        // images are not lazy here: read now, within the cap
        if (this.extraBytes + size > EXTRA_CAP) continue;
        const k = 'i:' + lc,
          prev = this.owner.get(k);
        if (prev !== undefined) dropEarlier(out, 'i', lc, this.keyOf.get(k));
        const ab = await e.f.async('arraybuffer');
        this.extraBytes += ab.byteLength;
        out.images[rel] = ab;
        this.owner.set(k, e.src);
        this.keyOf.set(k, rel);
        eagerImgs++;
      } else {
        const table = isImg ? 'i' : 't',
          k = table + ':' + lc,
          prev = this.owner.get(k);
        if (prev !== undefined) dropEarlier(out, table, lc, this.keyOf.get(k));
        this.owner.set(k, e.src);
        if (isImg) {
          this.keyOf.set(k, rel);
          out.imageRefs![rel] = this.makeRef(e.f, rel.split('.').pop()!.toLowerCase(), e.si);
        } else {
          const key = rel.replace(/\\/g, '/');
          this.keyOf.set(k, key);
          texts.push({ key, ref: e.f.ref, si: e.si, rel });
        }
      }
      this.pending.delete(lc);
      this.skipped.delete(lc.replace(/\\/g, '/'));
      taken.set(top, (taken.get(top) ?? 0) + 1);
    }
    // the text files, one forward pass per zip
    let bytes = 0,
      done = 0,
      reads = 0;
    const unreadable: string[] = [];
    const bySrc = new Map<number, typeof texts>();
    for (const t of texts) (bySrc.get(t.si) ?? bySrc.set(t.si, []).get(t.si)!).push(t);
    for (const [si, list] of bySrc) {
      const st = await sweepFull(
        this.blobs[si],
        list.map((t) => t.ref),
        (i, data) => {
          if (data) {
            out.texts[list[i].key] = decodeText(data);
            bytes += data.length;
          } else unreadable.push(list[i].rel);
        },
        (n) => onProgress?.(done + n, texts.length),
      );
      done += list.length;
      reads += st.reads;
    }
    const xs = this.xs;
    for (const [f, n] of taken) xs.folders.set(f, (xs.folders.get(f) ?? 0) + n);
    xs.texts += texts.length - unreadable.length;
    xs.bytes += bytes;
    xs.reads += reads;
    xs.imgNow += eagerImgs;
    xs.imgRef += [...taken.values()].reduce((a, b) => a + b, 0) - texts.length - eagerImgs;
    xs.unreadable += unreadable.length;
    if (taken.size)
      this.log?.(
        `extra files outside the usual folders: ${[...taken].map(([f, n]) => `${f ? f + '/' : '(top level)'} (${n})`).join(', ')}${texts.length ? `; ${texts.length} text file(s), ${(bytes / 1048576).toFixed(1)} MB read in ${reads} read(s)` : ''}${eagerImgs ? `; ${eagerImgs} image(s) read now` : ''}`,
      );
    if (unreadable.length)
      this.log?.(
        `${unreadable.length} text file(s) could not be read from the zip and were left out: ${unreadable.slice(0, 5).join(', ')}${unreadable.length > 5 ? ', ...' : ''}`,
      );
  }
  /**
   * Files outside the fixed folders that the game's own code points at (a LOADTEXT / image path literal naming that top-level folder) are
   * loaded too: text-like files into `texts`, images into `images`. Reads stop at EXTRA_CAP bytes, and the log says what was taken and
   * what was left. Folders never named by the code (docs/, patch archives, tools) stay unread. Paths a game builds entirely at run time
   * cannot be seen here; those are the misses to handle per game.
   */
  private async loadReferenced(onProgress?: (done: number, total: number) => void): Promise<void> {
    if (!this.scanReferences || !this.pending.size) return;
    if (this.sweepTexts) return this.registerExtras(onProgress);
    const out = this.files,
      taken = new Map<string, number>();
    let skippedCap = 0,
      left = 0;
    for (const [lc, e] of [...this.pending]) {
      const top = nfc(e.rel.slice(0, e.rel.indexOf('/'))).toLowerCase();
      if (!this.refs.has(top)) {
        left++;
        continue;
      }
      const size = (e.f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
      if (this.extraBytes + size > EXTRA_CAP) {
        skippedCap++;
        continue;
      }
      const isImg = IMG_EXT.test(e.rel);
      const rel = nfc(e.rel),
        table = isImg ? 'i' : 't',
        k = table + ':' + lc;
      const prev = this.owner.get(k);
      if (prev !== undefined) dropEarlier(out, table, lc, this.keyOf.get(k));
      this.owner.set(k, e.src);
      this.keyOf.set(k, isImg ? rel : rel.replace(/\\/g, '/'));
      if (isImg) {
        const ab = await e.f.async('arraybuffer');
        this.extraBytes += ab.byteLength;
        out.images[rel] = ab;
        this.xs.imgNow++;
      } else {
        const u = await e.f.async('uint8array');
        this.extraBytes += u.byteLength;
        this.xs.texts++;
        this.xs.bytes += u.byteLength;
        out.texts[rel.replace(/\\/g, '/')] = decodeText(u);
      }
      this.pending.delete(lc);
      this.skipped.delete(lc.replace(/\\/g, '/'));
      taken.set(top, (taken.get(top) ?? 0) + 1);
    }
    for (const [f, n] of taken) this.xs.folders.set(f, (this.xs.folders.get(f) ?? 0) + n);
    this.xs.capSkipped += skippedCap;
    this.xs.notNamed += left;
    if (taken.size)
      this.log?.(
        `referenced files outside the usual folders: ${[...taken].map(([f, n]) => `${f}/ (${n})`).join(', ')}, ${(this.extraBytes / 1024).toFixed(0)} KB${skippedCap ? `; ${skippedCap} more skipped at the ${EXTRA_CAP >> 20} MB limit` : ''}`,
      );
    else if (skippedCap) this.log?.(`${skippedCap} referenced file(s) skipped at the ${EXTRA_CAP >> 20} MB limit`);
    if (left) this.log?.(`${left} readable file(s) in folders the game's code never names were not loaded`);
  }
  /**
   * One line for the debug list about the extra file check (option `xrefs`), or undefined when the option is off: how many text files and
   * images were taken and from which folders, what the read cost, and what was left out. Call after the last `add`.
   */
  extrasSummary(): string | undefined {
    if (!this.scanReferences) return undefined;
    const x = this.xs,
      mb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
    const n = x.texts + x.imgRef + x.imgNow;
    const parts: string[] = [];
    if (!n && !x.unreadable) parts.push('none found outside the usual folders');
    else {
      const what: string[] = [];
      if (x.texts) what.push(`${x.texts} text file(s), ${mb(x.bytes)}${x.reads ? ` in ${x.reads} read(s)` : ''}`);
      if (x.imgRef) what.push(`${x.imgRef} image(s) left in the zip`);
      if (x.imgNow) what.push(`${x.imgNow} image(s) read now`);
      parts.push(what.join(', '));
      if (x.folders.size)
        parts.push(`by folder: ${[...x.folders].map(([f, c]) => `${f ? f + '/' : '(top level)'} ${c}`).join(', ')}`);
    }
    if (x.unreadable) parts.push(`${x.unreadable} unreadable (left out)`);
    if (x.denied) parts.push(`${x.denied} file(s) in docs, backup, tool or similar folders skipped`);
    if (x.capSkipped) parts.push(`${x.capSkipped} skipped at the ${EXTRA_CAP >> 20} MB limit`);
    if (x.notNamed) parts.push(`${x.notNamed} in folders the game's code never names not loaded`);
    return `Extra files: ${parts.join('; ')}`;
  }
  /** closes the log with the override total; call once after the last source */
  /**
   * Option `lazyImages`: the width and height of every image left in its zip, read in one forward pass per zip (`sweepHeads`) and stored in
   * its `ImageRef`, so the engine never reads a file to learn a size. Call after the last `add`, before `finish`. Image bytes are not kept.
   */
  async sweepImageSizes(onProgress?: (done: number, total: number) => void): Promise<SweepStats> {
    const t0 = performance.now();
    const out: SweepStats = { images: 0, sized: 0, reads: 0, bytes: 0, ms: 0 };
    const refs = this.files.imageRefs,
      srcs = this.files.imageSources;
    if (!refs || !srcs) return out;
    const bySrc = new Map<number, ImageRef[]>();
    for (const r of Object.values(refs)) {
      if (r.dim || !srcs[r.src]) continue;
      let l = bySrc.get(r.src);
      if (!l) bySrc.set(r.src, (l = []));
      l.push(r);
    }
    for (const l of bySrc.values()) out.images += l.length;
    let before = 0;
    for (const [si, list] of bySrc) {
      const st = await sweepHeads(
        srcs[si],
        list,
        16384,
        (i, head) => {
          const d = head && sniffSize(head);
          if (d) {
            list[i].dim = d;
            out.sized++;
          }
        },
        (n) => onProgress?.(before + n, out.images),
      );
      before += list.length;
      out.reads += st.reads;
      out.bytes += st.bytes;
    }
    out.ms = performance.now() - t0;
    if (out.images)
      this.log?.(
        `image sizes: ${out.sized} of ${out.images} read in one pass (${out.reads} reads, ${(out.bytes / 1048576).toFixed(0)} MB)${out.sized < out.images ? '; the rest are read when first asked' : ''}`,
      );
    return out;
  }
  finish(): GameFiles {
    if (this.clashes > CAP)
      this.log?.(`... ${this.clashes - CAP} more overrides not listed (${this.clashes} in total)`);
    else if (this.clashes) this.log?.(`${this.clashes} override(s) in total`);
    else if (this.n > 1) this.log?.('no path was provided by more than one source');
    this.files.unloaded = [...this.skipped.keys()];
    return this.files;
  }
}

/** game zip plus optional packs in one call */
/** what `GameLoader.sweepImageSizes` did */
export interface SweepStats {
  images: number;
  sized: number;
  reads: number;
  bytes: number;
  ms: number;
}

export async function readGameZip(
  file: Bytes,
  onProgress?: (done: number, total: number) => void,
  packs: Source[] = [],
  log?: (line: string) => void,
  gameName = 'game',
): Promise<GameFiles> {
  const l = new GameLoader(log);
  await l.add({ name: gameName, blob: file }, onProgress);
  for (const p of packs) await l.add(p, onProgress);
  return l.finish();
}

/** a path supplied again by a later source: delete the earlier entry from whichever table holds it (`key` = the key it was stored under, when known; else the table is searched for a key that differs only in case) */
function dropEarlier(out: GameFiles, table: string, lc: string, key?: string) {
  const kill = (t: Record<string, unknown>) => {
    // the key it was stored under, recorded when it was added
    if (key !== undefined) delete t[key];
    else for (const p of Object.keys(t)) if (p.toLowerCase() === lc) delete t[p];
  };
  if (table === 'e') {
    kill(out.erb);
    if (out.erbBytes) kill(out.erbBytes);
  } else if (table === 'c') kill(out.csv);
  else if (table === 'r') kill(out.rescsv);
  else if (table === 't') {
    kill(out.texts);
  } else if (table === 'i') {
    kill(out.images);
    if (out.imageRefs) kill(out.imageRefs);
  } else if (table === 'a') out.sounds.delete(lc.slice(6).replace(/\\/g, '/'));
  else if (table === 'f') out.fonts = out.fonts.filter((f) => f.path.toLowerCase() !== lc);
}
