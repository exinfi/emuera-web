/**
 * Browser storage for the translation feature: the translation zips and the per-game translation memory (translation tier, IndexedDB).
 * Opened only when used. Zips live in the 'pack' store under one key each: 'engine' (the engine zip), 'pack' (the original combined
 * zip, which is why that key is kept), and 'lang:<model id>' for a language zip. Installing a zip of the same kind replaces the old one.
 */
import { modelId, modelsOf, type TlManifest } from './pack';
import type { Memory } from './types';

export interface PackRecord {
  key: string;
  name: string;
  size: number;
  added: string;
  manifest: TlManifest;
  blob: Blob;
  /** false: the zip's files are not the known engine/model files (absent on zips stored before the check existed) */
  recognised?: boolean;
}

const idb = (): Promise<IDBDatabase> =>
  new Promise((ok, no) => {
    const r = indexedDB.open('emuera-web-translation', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('pack');
      db.createObjectStore('tm');
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

/** where a zip is stored: engine-only zips share one slot, a zip that carries both engine and models keeps the original slot, language zips are one slot per model set */
export function packKey(m: TlManifest): string {
  if (m.kind === 'translation-engine') return 'engine';
  if (m.engine) return 'pack';
  return 'lang:' + modelsOf(m).map(modelId).sort().join('+');
}

/** every stored zip, oldest first (a later zip wins when two offer the same model) */
export async function listPacks(): Promise<PackRecord[]> {
  const db = await idb();
  const os = db.transaction('pack').objectStore('pack');
  const [keys, vals] = await Promise.all([req(os.getAllKeys()), req(os.getAll())]);
  return (vals as Omit<PackRecord, 'key'>[])
    .map((v, i) => ({ ...v, key: String(keys[i]) }))
    .sort((a, b) => a.added.localeCompare(b.added));
}
export async function putPack(rec: PackRecord) {
  const db = await idb();
  const tx = db.transaction('pack', 'readwrite');
  const { key, ...rest } = rec;
  tx.objectStore('pack').put(rest, key);
  await done(tx);
}
export async function removeAllPacks() {
  const db = await idb();
  const tx = db.transaction('pack', 'readwrite');
  tx.objectStore('pack').clear();
  await done(tx);
}

const SEP = '\u0000';
/**
 * The saved translations of one game for one model. The key prefix is the game id; for any model other than the legacy ones below the model id
 * is added after a \u0002 separator. The legacy Japanese model keeps the original key shape, so everything saved before models were selectable is
 * still found, and a game's ja>en and ko>en memories can never be mixed up (nor can two model variants).
 */
/** the shipped Japanese model (variant cjk_icu_base) is what every earlier memory was made with, so it keeps the original keys as well */
const LEGACY_MODELS = new Set(['ja>en', 'ja>en:cjk_icu_base']);
const prefixOf = (gameId: string, model: string) => (LEGACY_MODELS.has(model) ? gameId : gameId + '\u0002' + model);
export async function openMemory(
  gameId: string,
  model = 'ja>en',
): Promise<Memory & { size(): number; clear(): Promise<void>; flush(): Promise<void> }> {
  const db = await idb();
  const prefix = prefixOf(gameId, model);
  const map = new Map<string, { tr: string; flagged: boolean }>();
  const range = IDBKeyRange.bound(prefix + SEP, prefix + '\u0001');
  const tx = db.transaction('tm');
  const os = tx.objectStore('tm');
  const [keys, vals] = await Promise.all([req(os.getAllKeys(range)), req(os.getAll(range))]);
  keys.forEach((k, i) => map.set(String(k).slice(prefix.length + 1), vals[i] as { tr: string; flagged: boolean }));
  let buf: [string, { tr: string; flagged: boolean }][] = [];
  let writing: Promise<void> = Promise.resolve();
  const flush = () => {
    const batch = buf;
    buf = [];
    if (!batch.length) return writing;
    writing = writing
      .then(async () => {
        const t = db.transaction('tm', 'readwrite');
        for (const [k, v] of batch) t.objectStore('tm').put(v, prefix + SEP + k);
        await done(t);
      })
      .catch(() => {});
    return writing;
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    get: (t) => map.get(t),
    put: (es) => {
      for (const e of es) {
        const v = { tr: e.tr, flagged: e.flagged };
        map.set(e.text, v);
        buf.push([e.text, v]);
      }
      if (!timer)
        timer = setTimeout(() => {
          timer = null;
          void flush();
        }, 2000);
    },
    size: () => map.size,
    flush,
    clear: async () => {
      map.clear();
      buf = [];
      const t = db.transaction('tm', 'readwrite');
      t.objectStore('tm').delete(range);
      await done(t);
    },
  };
}
