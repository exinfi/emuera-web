/**
 * Resource packs / mods (host-web tier): extra zips merged over the game zip in list order (later wins on a clash).
 * A pack is scanned when it is added (zip directory only, nothing is extracted), listed with its files and what kind they are,
 * and kept in IndexedDB so the list and its order survive a reload. Packs are not tied to any game: one list, applied to whatever game is loaded next. No DOM.
 */
import JSZip from 'jszip';
import {
  classify,
  detectRoot,
  PACK_MARKERS,
  PACK_STRUCTURE_HELP,
  decodeZipName,
  nfc,
  relativeTo,
  decodeText,
  type Bytes,
  type FileKind,
  type Source,
} from './gamezip';

export interface PackFile {
  path: string;
  kind: FileKind;
  size: number;
}
export interface PackScan {
  root: string;
  note: string;
  /** text of the optional pack.txt at the pack root (user-supplied description), capped */ info?: string;
  files: PackFile[];
  counts: Record<FileKind, number>;
  hasCode: boolean;
  hasData: boolean;
  summary: string;
}
export interface PackMeta {
  id: string;
  name: string;
  size: number;
  enabled: boolean;
  added: string;
  scan: PackScan;
}

/** the optional description file at the pack root (the level that holds erb/, csv/, resources/) */
export const PACK_INFO_FILE = 'pack.txt';
const INFO_MAX = 20000;
export interface PackInfo {
  name?: string;
  author?: string;
  version?: string;
  game?: string;
  url?: string;
  description: string;
}
const INFO_KEYS: Record<string, keyof PackInfo> = {
  name: 'name',
  title: 'name',
  author: 'author',
  creator: 'author',
  by: 'author',
  version: 'version',
  game: 'game',
  for: 'game',
  url: 'url',
  link: 'url',
  description: 'description',
  desc: 'description',
};
/**
 * pack.txt is plain text. Lines of the form `Key: value` (Name, Author, Version, Game or For, URL, Description; any letter case, `:` or the full-width `：`) fill the fields;
 * every other line is part of the description, so a file with no keys at all is just a description. Nothing here can fail: unknown text is kept as description.
 */
export function parsePackInfo(text: string): PackInfo {
  const out: PackInfo = { description: '' };
  const desc: string[] = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r\n?|\n/)) {
    const m = /^\s*([A-Za-z]+)\s*[:：]\s*(.*)$/.exec(raw);
    const k = m ? INFO_KEYS[m[1].toLowerCase()] : undefined;
    if (m && k && k !== 'description' && !out[k]) out[k] = m[2].trim();
    else if (m && k === 'description') desc.push(m[2]);
    else desc.push(raw);
  }
  out.description = desc.join('\n').trim();
  return out;
}

const KINDS: FileKind[] = ['code', 'data', 'image', 'audio', 'font', 'text', 'ignored'];

/** "312 images; 4 ERB files, 1 CSV file" */
export function summarize(c: Record<FileKind, number>): string {
  const n = (k: number, one: string, many = one + 's') => `${k} ${k === 1 ? one : many}`;
  const parts: string[] = [];
  if (c.image) parts.push(n(c.image, 'image'));
  if (c.audio) parts.push(n(c.audio, 'sound'));
  if (c.font) parts.push(n(c.font, 'font'));
  if (c.text) parts.push(n(c.text, 'text file'));
  const code: string[] = [];
  if (c.code) code.push(n(c.code, 'ERB file'));
  if (c.data) code.push(n(c.data, 'CSV file'));
  const s = [parts.join(', '), code.join(', ')].filter(Boolean).join('; ');
  return (s || 'nothing the loader uses') + (c.ignored ? ` (${c.ignored} ignored)` : '');
}

/** read the zip directory and classify every file; throws when no pack root is found */
export async function scanPack(data: Bytes): Promise<PackScan> {
  const z = await JSZip.loadAsync(data, { decodeFileName: decodeZipName });
  const entries = Object.entries(z.files).filter(([, f]) => !f.dir);
  const r = detectRoot(
    entries.map(([n]) => n),
    PACK_MARKERS,
  );
  if (r.root === null)
    throw new Error(
      `none of erb/, csv/, resources/, sound/, font/ or dat/ found at the top level or inside a folder${r.folders.length ? ' (top-level folders: ' + r.folders.join(', ') + ')' : ''}. ${PACK_STRUCTURE_HELP}`,
    );
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<FileKind, number>;
  const files: PackFile[] = [];
  let info: string | undefined;
  for (const [name, f] of entries) {
    const rr = relativeTo(r.root, name);
    if (rr === null) continue;
    const rel = nfc(rr);
    const kind = classify(rel);
    if (rr.toLowerCase() === PACK_INFO_FILE) {
      // listed and readable, but not one of the files the loader uses, so not counted
      try {
        info = decodeText(await f.async('uint8array')).slice(0, INFO_MAX);
      } catch {
        /* unreadable: no description */
      }
      files.push({ path: rel, kind: 'text', size: Number((f as any)._data?.uncompressedSize) || 0 });
      continue;
    }
    counts[kind]++;
    files.push({ path: rel, kind, size: Number((f as any)._data?.uncompressedSize) || 0 });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    root: r.root,
    note: r.note,
    info,
    files,
    counts,
    hasCode: counts.code > 0,
    hasData: counts.data > 0,
    summary: summarize(counts),
  };
}

/** text of one file inside a pack (for the read-only viewer); only the loader's text-like kinds */
export async function readPackText(data: Bytes, scan: PackScan, path: string): Promise<string | null> {
  const f = scan.files.find((x) => x.path === path);
  if (!f || !['code', 'data', 'text'].includes(f.kind)) return null;
  const z = await JSZip.loadAsync(data, { decodeFileName: decodeZipName });
  const names = Object.keys(z.files).filter((n) => {
    const x = relativeTo(scan.root, n);
    return x !== null && nfc(x) === path;
  });
  const e = names.length ? z.file(names[0]) : null;
  return e ? decodeText(await e.async('uint8array')) : null;
}

// ------------------------------------------------------------------ storage
const idb = (): Promise<IDBDatabase> =>
  new Promise((ok, no) => {
    const r = indexedDB.open('emuera-web-packs', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('meta');
      db.createObjectStore('blobs');
      db.createObjectStore('order');
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((ok, no) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
const done = (tx: IDBTransaction) =>
  new Promise<void>((ok, no) => {
    tx.oncomplete = () => ok();
    tx.onerror = () => no(tx.error);
    tx.onabort = () => no(tx.error);
  });
const uid = () => crypto.randomUUID?.() ?? String(Math.random()).slice(2);

const ORDER = 'all'; // one global load order
/** the packs in load order (first = loaded first, later ones override it) */
export async function listPacks(): Promise<PackMeta[]> {
  const db = await idb();
  const tx = db.transaction(['meta', 'order'], 'readwrite');
  const os = tx.objectStore('order');
  let order = (await req(os.get(ORDER))) as string[] | undefined;
  if (!order) {
    // an earlier version kept one list per game: fold those into the single list, once
    order = [];
    for (const k of (await req(os.getAllKeys())) as string[])
      for (const id of ((await req(os.get(k))) as string[]) ?? []) if (!order.includes(id)) order.push(id);
    os.put(order, ORDER);
  }
  const out: PackMeta[] = [];
  for (const id of order) {
    const m = (await req(tx.objectStore('meta').get(id))) as PackMeta | undefined;
    if (m) out.push(m);
  }
  return out;
}
async function saveOrder(ids: string[]) {
  const db = await idb();
  const tx = db.transaction('order', 'readwrite');
  tx.objectStore('order').put(ids, ORDER);
  await done(tx);
}
export async function addPack(file: File): Promise<PackMeta> {
  const scan = await scanPack(file); // throws before anything is stored
  const meta: PackMeta = {
    id: uid(),
    name: file.name,
    size: file.size,
    enabled: true,
    added: new Date().toISOString(),
    scan,
  };
  const db = await idb();
  const tx = db.transaction(['meta', 'blobs'], 'readwrite');
  tx.objectStore('meta').put(meta, meta.id);
  tx.objectStore('blobs').put(file, meta.id);
  await done(tx);
  await saveOrder([...(await listPacks()).map((p) => p.id).filter((i) => i !== meta.id), meta.id]);
  return meta;
}
export async function removePack(id: string) {
  const db = await idb();
  const tx = db.transaction(['meta', 'blobs'], 'readwrite');
  tx.objectStore('meta').delete(id);
  tx.objectStore('blobs').delete(id);
  await done(tx);
  await saveOrder((await listPacks()).map((p) => p.id).filter((i) => i !== id));
}
export async function setEnabled(id: string, enabled: boolean) {
  const db = await idb();
  const tx = db.transaction('meta', 'readwrite');
  const st = tx.objectStore('meta');
  const m = (await req(st.get(id))) as PackMeta | undefined;
  if (m) st.put({ ...m, enabled }, id);
  await done(tx);
}
/** move a pack one place up (-1) or down (+1) in the load order */
export async function movePack(id: string, delta: -1 | 1) {
  const ids = (await listPacks()).map((p) => p.id);
  const i = ids.indexOf(id),
    j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await saveOrder(ids);
}
export async function packBlob(id: string): Promise<Blob | null> {
  const db = await idb();
  return ((await req(db.transaction('blobs').objectStore('blobs').get(id))) as Blob | undefined) ?? null;
}
/** the enabled packs as loader sources, in load order */
export async function activeSources(): Promise<Source[]> {
  const out: Source[] = [];
  for (const p of await listPacks()) {
    if (!p.enabled) continue;
    const b = await packBlob(p.id);
    if (b) out.push({ name: p.name, blob: b });
  }
  return out;
}
