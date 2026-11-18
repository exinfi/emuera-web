/**
 * Memory cards: the save directory of a game, virtualised.
 * A card = manifest + files, stored in IndexedDB ("browser memory"), exported/imported as a zip, or mounted from a real folder.
 *   manifest.json        { format, name, gameId, gameTitle, gameVersion, build, engine, created, modified }
 *   sav/<key>.sav        snapshot text for slot <key> (save0, save1, ..., global)
 *   sav/<key>.info       the slot header shown by CHKDATA
 *   dat/<key>            files written with SAVETEXT
 * A card remembers which game made it. Loading it into another game/build is allowed, with a warning.
 */
import JSZip from 'jszip';
import { ENGINE_NAME } from '../version';

export interface CardMeta {
  format: 1;
  name: string;
  gameId: string;
  gameTitle: string;
  gameVersion: string;
  build: string;
  engine: string;
  created: string;
  modified: string;
}
export interface Card {
  id: string;
  meta: CardMeta;
  paths: Set<string>;
  dir?: any;
  where: 'browser' | 'folder' | 'zip';
}
export interface GameIdent {
  id: string;
  title: string;
  version: string;
  build: string;
}

export const ENGINE = ENGINE_NAME;

// ------------------------------------------------------------------ game identity
function fnv(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
/** `erb` maps each ERB path to its text, or to the text's length (low memory loader); only the lengths are used */
export function identify(
  csv: Record<string, string>,
  erb: Record<string, string | number>,
  zipName: string,
): GameIdent {
  const gb = Object.entries(csv).find(([p]) => /(^|\/)gamebase\.csv$/i.test(p))?.[1] ?? '';
  const get = (k: string) => new RegExp('^' + k + ',(.*)$', 'm').exec(gb.replace(/^﻿/, ''))?.[1]?.trim() ?? '';
  const title = get('タイトル') || zipName.replace(/\.zip$/i, '');
  const code = get('コード');
  const version = get('バージョン');
  const build = fnv(
    Object.entries(erb)
      .map(([p, t]) => p.toLowerCase() + ':' + (typeof t === 'number' ? t : t.length))
      .sort()
      .join('|'),
  );
  return { id: `${title}|${code}`, title, version, build };
}

// ------------------------------------------------------------------ IndexedDB
const idb = (): Promise<IDBDatabase> =>
  new Promise((ok, no) => {
    const r = indexedDB.open('emuera-web', 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('saves')) db.createObjectStore('saves'); // legacy (v1): `<zip name>|<key>`
      if (!db.objectStoreNames.contains('cards')) db.createObjectStore('cards');
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
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
export async function gz(text: string): Promise<Blob> {
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
}
export async function gunz(b: Blob): Promise<string> {
  return new Response(b.stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

/** a card that no game has claimed yet: made or imported before any game was open */
export const NO_GAME: GameIdent = { id: '', title: '', version: '', build: '' };
const newMeta = (g: GameIdent, name: string): CardMeta => ({
  format: 1,
  name,
  gameId: g.id,
  gameTitle: g.title,
  gameVersion: g.version,
  build: g.build,
  engine: ENGINE,
  created: new Date().toISOString(),
  modified: new Date().toISOString(),
});
const uid = () => crypto.randomUUID?.() ?? String(Math.random()).slice(2);

export async function listCards(): Promise<{ id: string; meta: CardMeta }[]> {
  const db = await idb();
  const st = db.transaction('cards').objectStore('cards');
  const keys = (await req(st.getAllKeys())) as string[];
  const out: { id: string; meta: CardMeta }[] = [];
  for (const k of keys) out.push({ id: k, meta: await req(st.get(k)) });
  return out;
}
async function pathsOf(id: string): Promise<Set<string>> {
  const db = await idb();
  const st = db.transaction('files').objectStore('files');
  const keys = (await req(st.getAllKeys())) as string[];
  return new Set(keys.filter((k) => k.startsWith(id + '|')).map((k) => k.slice(id.length + 1)));
}
export async function openCard(id: string): Promise<Card | null> {
  const db = await idb();
  const meta = await req(db.transaction('cards').objectStore('cards').get(id));
  if (!meta) return null;
  return { id, meta, paths: await pathsOf(id), where: 'browser' };
}
export async function createCard(g: GameIdent | null, name: string, id = uid()): Promise<Card> {
  const meta = newMeta(g ?? NO_GAME, name);
  const db = await idb();
  const tx = db.transaction('cards', 'readwrite');
  tx.objectStore('cards').put(meta, id);
  await done(tx);
  return { id, meta, paths: new Set(), where: 'browser' };
}
/** a card name the user typed: trimmed, never empty (null = refuse) */
export const cleanCardName = (s: string | null | undefined): string | null => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 80) : null;
};
/** the download name for an exported card: whitespace and characters unsafe in file names become `_`, other letters (Japanese too) stay */
export const cardFileName = (name: string) =>
  (name.replace(/[\s\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^[._]+|[._]+$/g, '') || 'card') + '.memcard.zip';
/** rename a card; only the name changes (id, game id and slots stay). A mounted folder keeps its folder name on disk and records the new name in its manifest.json. */
export async function saveMeta(c: Card) {
  c.meta.modified = new Date().toISOString();
  if (c.dir) {
    const w = await (await c.dir.getFileHandle('manifest.json', { create: true })).createWritable();
    await w.write(JSON.stringify(c.meta, null, 2));
    await w.close();
    return;
  }
  const db = await idb();
  const tx = db.transaction('cards', 'readwrite');
  tx.objectStore('cards').put(c.meta, c.id);
  await done(tx);
}
export async function renameCard(c: Card, name: string): Promise<boolean> {
  const n = cleanCardName(name);
  if (!n) return false;
  c.meta.name = n;
  await saveMeta(c);
  return true;
}
/** a card with no game id (made before any game was open) is claimed by the first game that loads it; returns true when it was */
export async function claimCard(c: Card, g: GameIdent): Promise<boolean> {
  if (c.meta.gameId) return false;
  c.meta.gameId = g.id;
  c.meta.gameTitle = g.title;
  c.meta.gameVersion = g.version;
  c.meta.build = g.build;
  await saveMeta(c);
  return true;
}
/** point a card at the game that is using it now (id, title, version, build); true when anything changed. Called when a save is written to the card, and for a card with no saves yet. */
export async function adoptCard(c: Card, g: GameIdent): Promise<boolean> {
  const m = c.meta;
  if (m.gameId === g.id && m.gameTitle === g.title && m.gameVersion === g.version && m.build === g.build) return false;
  m.gameId = g.id;
  m.gameTitle = g.title;
  m.gameVersion = g.version;
  m.build = g.build;
  await saveMeta(c);
  return true;
}
export async function deleteCard(id: string) {
  const db = await idb();
  const keys = [...(await pathsOf(id))];
  const tx = db.transaction(['cards', 'files'], 'readwrite');
  tx.objectStore('cards').delete(id);
  for (const p of keys) tx.objectStore('files').delete(id + '|' + p);
  await done(tx);
}

// ------------------------------------------------------------------ folder helpers (File System Access API)
async function dirFor(root: any, path: string, create: boolean): Promise<[any, string]> {
  const parts = path.split('/');
  const name = parts.pop()!;
  let d = root;
  for (const p of parts) d = await d.getDirectoryHandle(p, { create });
  return [d, name];
}
const safe = (p: string) =>
  p
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/');

export async function readFile(c: Card, path: string): Promise<string | null> {
  if (c.dir) {
    try {
      const [d, n] = await dirFor(c.dir, path, false);
      return await (await (await d.getFileHandle(n)).getFile()).text();
    } catch {
      return null;
    }
  }
  const db = await idb();
  const v = await req(
    db
      .transaction('files')
      .objectStore('files')
      .get(c.id + '|' + path),
  );
  return v ? gunz(v) : null;
}
/** write (text) or delete (null) one file; browser cards also bump `modified` */
export async function writeFile(c: Card, path: string, text: string | null) {
  path = safe(path);
  c.meta.modified = new Date().toISOString();
  if (text === null) c.paths.delete(path);
  else c.paths.add(path);
  if (c.dir) {
    const [d, n] = await dirFor(c.dir, path, text !== null).catch(() => [null, ''] as [any, string]);
    if (!d) return;
    if (text === null) {
      try {
        await d.removeEntry(n);
      } catch {
        /* absent */
      }
      return;
    }
    const w = await (await d.getFileHandle(n, { create: true })).createWritable();
    await w.write(text);
    await w.close();
    return;
  }
  const blob = text === null ? null : await gz(text); // compress before opening the transaction
  const db = await idb();
  const tx = db.transaction(['cards', 'files'], 'readwrite');
  if (blob) tx.objectStore('files').put(blob, c.id + '|' + path);
  else tx.objectStore('files').delete(c.id + '|' + path);
  tx.objectStore('cards').put(c.meta, c.id);
  await done(tx);
}

// ------------------------------------------------------------------ slots <-> files
export const slotPaths = (key: string) => [`sav/${key}.sav`, `sav/${key}.info`] as const;
export type Slots = Record<string, { info: string; data: string }>;
/** everything the engine needs from a card: slot records and SAVETEXT files */
export async function readAll(c: Card): Promise<{ saves: Slots; files: Record<string, string> }> {
  const saves: Slots = {},
    files: Record<string, string> = {};
  for (const p of c.paths) {
    let m: RegExpExecArray | null;
    if ((m = /^sav\/(.+)\.sav$/.exec(p))) {
      const data = await readFile(c, p);
      if (data === null) continue;
      saves[m[1]] = { info: (await readFile(c, `sav/${m[1]}.info`)) ?? '', data };
    } else if ((m = /^dat\/(.+)$/.exec(p))) files[m[1]] = (await readFile(c, p)) ?? '';
  }
  return { saves, files };
}

// ------------------------------------------------------------------ zip import / export
export async function exportZip(c: Card): Promise<Blob> {
  const z = new JSZip();
  z.file('manifest.json', JSON.stringify(c.meta, null, 2));
  for (const p of c.paths) {
    const t = await readFile(c, p);
    if (t !== null) z.file(p, t);
  }
  return z.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
const MAX_ENTRY = 512 * 1024 * 1024;
export async function importZip(file: File, g: GameIdent | null): Promise<Card> {
  const z = await JSZip.loadAsync(file);
  let meta: CardMeta | null = null;
  const mf = z.file('manifest.json');
  if (mf) {
    try {
      const m = JSON.parse(await mf.async('string'));
      if (m && typeof m === 'object')
        meta = {
          ...newMeta({ id: '', title: '', version: '', build: '' }, file.name.replace(/\.zip$/i, '')),
          ...m,
          format: 1,
        };
    } catch {
      /* no manifest */
    }
  }
  const card = await createCard(g, '');
  card.meta = meta ?? { ...newMeta({ id: '', title: '', version: '', build: '' }, file.name.replace(/\.zip$/i, '')) };
  card.meta.name ||= file.name.replace(/\.zip$/i, '');
  let n = 0;
  for (const [name, f] of Object.entries(z.files)) {
    if (f.dir) continue;
    const p = safe(name);
    if (!/^(sav\/[^/]+\.(sav|info)|dat\/.+)$/.test(p)) continue;
    const text = await f.async('string');
    if (text.length > MAX_ENTRY) continue;
    await writeFile(card, p, text);
    n++;
  }
  if (!n) {
    await deleteCard(card.id);
    throw new Error('no save files found in this zip');
  }
  card.meta.modified = new Date().toISOString();
  const db = await idb();
  const tx = db.transaction('cards', 'readwrite');
  tx.objectStore('cards').put(card.meta, card.id);
  await done(tx);
  return card;
}

// ------------------------------------------------------------------ mounted folder
export const canMountFolder = () => typeof (window as any).showDirectoryPicker === 'function';
export async function mountFolder(g: GameIdent | null): Promise<Card> {
  const root = await (window as any).showDirectoryPicker({ mode: 'readwrite', id: 'emuera-saves' });
  let meta: CardMeta | null = null;
  try {
    meta = JSON.parse(await (await (await root.getFileHandle('manifest.json')).getFile()).text());
  } catch {
    /* new folder */
  }
  const card: Card = {
    id: 'folder:' + root.name,
    meta: meta ?? newMeta(g ?? NO_GAME, root.name),
    paths: new Set(),
    dir: root,
    where: 'folder',
  };
  const walk = async (d: any, prefix: string) => {
    for await (const [name, h] of d.entries()) {
      if (h.kind === 'directory') {
        if (prefix === '' && (name === 'sav' || name === 'dat')) await walk(h, name + '/');
        else if (prefix) await walk(h, prefix + name + '/');
      } else if (prefix) card.paths.add(prefix + name);
    }
  };
  await walk(root, '');
  if (!meta) {
    const w = await (await root.getFileHandle('manifest.json', { create: true })).createWritable();
    await w.write(JSON.stringify(card.meta, null, 2));
    await w.close();
  }
  return card;
}

// ------------------------------------------------------------------ legacy (v1: saves keyed by zip name)
export async function importLegacy(zipName: string, card: Card): Promise<number> {
  let n = 0;
  try {
    const db = await idb();
    const st = db.transaction('saves').objectStore('saves');
    const keys = ((await req(st.getAllKeys())) as string[]).filter((k) => k.startsWith(zipName + '|'));
    const rows: [string, any][] = [];
    for (const k of keys) rows.push([k, await req(st.get(k))]);
    for (const [k, v] of rows) {
      const key = k.slice(zipName.length + 1);
      const [pd, pi] = slotPaths(key);
      await writeFile(card, pd, await gunz(v.blob));
      await writeFile(card, pi, v.info ?? '');
      n++;
    }
  } catch (e) {
    console.warn('legacy import failed', e);
  }
  return n;
}

export function mismatch(c: Card, g: GameIdent): string {
  if (c.meta.gameId && c.meta.gameId !== g.id)
    return `⚠ This card was made for "${c.meta.gameTitle}" (v${c.meta.gameVersion}), not "${g.title}". Loaded anyway; saves may not work.`;
  if (c.meta.build && c.meta.build !== g.build)
    return `Note: this card was made with a different build of ${g.title}${c.meta.gameVersion && c.meta.gameVersion !== g.version ? ` (v${c.meta.gameVersion})` : ''}; loaded anyway.`;
  return '';
}
