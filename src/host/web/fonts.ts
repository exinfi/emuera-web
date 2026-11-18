/**
 * Font registry (host-web tier): the faces the page knows about (game-embedded `font/*.ttf|otf`, user-imported,
 * bundled), registered with the browser by family name the way Emuera registers its private font collection,
 * plus the CSS stack for a requested family. No UI; shells render their own panel on `list()`.
 */
import { parseFont } from './fontinfo';
import { familyKey, resolveFamily } from '../screen';
import type { FontFile } from '../protocol';
import { FontStore, USER_FONT_CAP } from './fontstore';

export type FontSource = 'game' | 'user' | 'bundled';

export interface FontEntry {
  id: number;
  /** family name the face is registered under (GDI family name from the file, else the file name) */
  family: string;
  aliases: string[];
  weight: number;
  italic: boolean;
  source: FontSource;
  /** file name it came from */
  file: string;
  bytes: number;
  /** advance('A') / advance('あ'); 0.5 is what character-count layouts assume; null = unknown */
  ratio: number | null;
  data: ArrayBuffer;
  /** IndexedDB id for user fonts */
  storeId?: number;
}

/** where a font is used: the game's default font (the user override applies), a SETFONT/<font face> segment, or a tooltip */
export type FontRole = 'default' | 'segment' | 'tooltip';

/** the bundled metric-compatible font: BIZ UDGothic (SIL OFL), half-width 0.5 em, full-width 1 em */
export const BUNDLED_MONO = 'BIZ UDGothic';
/** family keys (see familyKey) of the Windows fonts that cannot be bundled: MS Gothic / MS Mincho, Latin and Japanese names */
const MS_GOTHIC = new Set(['msgothic', 'ｍｓゴシック', 'msゴシック']);
const MS_MINCHO = new Set(['msmincho', 'ｍｓ明朝', 'ms明朝']);

/** tail of every stack: what the page falls back to when no registered face matches */
export const FALLBACKS = '"MS Gothic", "Noto Sans Mono CJK JP", monospace';

export class FontRegistry {
  private seq = 0;
  private entries: FontEntry[] = [];
  private faces = new Map<number, FontFace>();
  /** family that replaces the game's default font (the config font name), or null for the game's own */
  override: string | null = null;
  /** map MS Gothic to the bundled BIZ UDGothic (identical half-/full-width metrics) so layouts match on every platform; turn off to use an installed MS Gothic */
  aliasMsGothic = true;
  constructor(private doc: Document = document) {}

  list(): readonly FontEntry[] {
    return this.entries;
  }
  /** unique registered family names */
  families(): string[] {
    return [...new Set(this.entries.map((e) => e.family))];
  }

  /** read a font file and add it (not usable until register()); null when it is not a font */
  async add(file: string, data: ArrayBuffer, source: FontSource): Promise<FontEntry | null> {
    const info = await parseFont(data);
    const stem = file.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
    if (!info && !/\.woff2?$/i.test(file)) return null; // woff2 cannot be read here; the browser may still load it under the file name
    const e: FontEntry = {
      id: ++this.seq,
      family: info?.family ?? stem,
      aliases: info?.aliases ?? [],
      weight: info?.weight ?? 400,
      italic: info?.italic ?? false,
      source,
      file,
      bytes: data.byteLength,
      ratio: info?.halfWidthRatio ?? null,
      data,
    };
    this.entries.push(e);
    return e;
  }

  /** register every added face with the browser's font set and wait for them to load */
  async register(): Promise<void> {
    const todo = this.entries.filter((e) => !this.faces.has(e.id));
    await Promise.all(
      todo.map(async (e) => {
        try {
          const face = new FontFace(e.family, e.data.slice(0), {
            weight: String(e.weight),
            style: e.italic ? 'italic' : 'normal',
          });
          await face.load();
          this.doc.fonts.add(face);
          this.faces.set(e.id, face);
        } catch (err) {
          console.warn('font ' + e.file + ' not usable', err);
        }
      }),
    );
  }

  remove(id: number) {
    const f = this.faces.get(id);
    if (f) {
      this.doc.fonts.delete(f);
      this.faces.delete(id);
    }
    this.entries = this.entries.filter((e) => e.id !== id);
  }
  removeSource(source: FontSource) {
    for (const e of this.entries.filter((x) => x.source === source)) this.remove(e.id);
  }

  /** the family a requested name refers to: an exact registered family (case, spaces, hyphens ignored), else the MS Gothic alias, else the name itself */
  resolve(name: string): string {
    const hit = resolveFamily(name, this.families());
    if (hit !== name) return hit;
    const k = familyKey(name),
      viaAlias = this.entries.find((e) => e.aliases.some((a) => familyKey(a) === k));
    if (viaAlias) return viaAlias.family;
    if (this.has(name)) return name;
    if (this.aliasMsGothic && MS_GOTHIC.has(familyKey(name)) && this.has(BUNDLED_MONO))
      return resolveFamily(BUNDLED_MONO, this.families());
    return name;
  }
  has(name: string): boolean {
    const k = familyKey(name);
    return this.entries.some((e) => familyKey(e.family) === k || e.aliases.some((a) => familyKey(a) === k));
  }

  /** CSS font-family list for a requested family. The override replaces the game's default font only. */
  stack(name: string, role: FontRole = 'segment'): string {
    const n = role === 'default' && this.override ? this.override : name;
    if (MS_MINCHO.has(familyKey(n)) && !this.has(n)) return `"${n}", "Noto Serif CJK JP", "Yu Mincho", serif`;
    // a requested font that is not installed falls back to the bundled monospace first, so missing glyphs and unknown names keep half-width = 0.5 em
    return `"${this.resolve(n)}", ${this.has(BUNDLED_MONO) ? `"${BUNDLED_MONO}", ` : ''}${FALLBACKS}`;
  }

  // ---- user fonts (IndexedDB) and bundled fonts
  /** add the user's stored fonts (call once at start-up, then register()) */
  async loadUser(store: FontStore): Promise<void> {
    for (const f of await store.list()) {
      const e = await this.add(f.file, f.data, 'user');
      if (e) e.storeId = f.id;
    }
  }
  /** import a font file the user picked: validated, size-capped, stored, added. Returns the entry or a reason. */
  async addUser(store: FontStore, file: string, data: ArrayBuffer): Promise<{ entry: FontEntry } | { error: string }> {
    const used = this.entries.filter((e) => e.source === 'user').reduce((n, e) => n + e.bytes, 0);
    if (used + data.byteLength > USER_FONT_CAP)
      return { error: `Fonts over the ${USER_FONT_CAP >> 20} MB limit; remove one first.` };
    const entry = await this.add(file, data, 'user');
    if (!entry) return { error: `${file} is not a font file I can read (TTF, OTF, WOFF or WOFF2).` };
    const id = await store.put(file, data);
    if (id === null) {
      this.remove(entry.id);
      return { error: 'Browser storage is unavailable, so the font could not be kept.' };
    }
    entry.storeId = id;
    await this.register();
    return { entry };
  }
  async removeUser(store: FontStore, id: number): Promise<void> {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    if (e.storeId !== undefined) await store.remove(e.storeId);
    this.remove(id);
  }

  /** the faces for the worker (it registers them for its own canvas text) */
  startFonts(): FontFile[] {
    return this.entries.map((e) => ({ family: e.family, weight: e.weight, italic: e.italic, data: e.data }));
  }
}
