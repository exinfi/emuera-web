/** IndexedDB store for user-imported fonts (host-web tier). Global to the browser, not per game. Every call is safe when storage is unavailable. */
export interface StoredFont {
  id: number;
  file: string;
  data: ArrayBuffer;
  added: number;
}

/** total size cap for imported fonts */
export const USER_FONT_CAP = 64 * 1024 * 1024;

export class FontStore {
  constructor(private name = 'emuera-fonts') {}
  private db(): Promise<IDBDatabase> {
    return new Promise((res, rej) => {
      const r = indexedDB.open(this.name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('fonts', { keyPath: 'id', autoIncrement: true });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db();
    try {
      return await new Promise<T>((res, rej) => {
        const r = fn(db.transaction('fonts', mode).objectStore('fonts'));
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    } finally {
      db.close();
    }
  }
  async list(): Promise<StoredFont[]> {
    try {
      return await this.tx('readonly', (s) => s.getAll() as IDBRequest<StoredFont[]>);
    } catch {
      return [];
    }
  }
  async put(file: string, data: ArrayBuffer): Promise<number | null> {
    try {
      return Number(await this.tx('readwrite', (s) => s.add({ file, data, added: Date.now() })));
    } catch {
      return null;
    }
  }
  async remove(id: number): Promise<void> {
    try {
      await this.tx('readwrite', (s) => s.delete(id));
    } catch {
      /* ignore */
    }
  }
}
