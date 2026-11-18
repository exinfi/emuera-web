/** Drag and drop: a game zip, a memory card zip, native .sav files, pack zips and fonts, in any mix. */
import JSZip from 'jszip';
import { detectRoot, decodeZipName } from '../host/web/gamezip';

export type DropKind = 'game' | 'card' | 'native' | 'pack' | 'translation' | 'font' | 'unknown';
export type NativeFinder = (f: File) => Promise<unknown[]>;

/** what a dropped file is: fonts and .sav by extension/signature, zips by content (game root, native saves, card layout) */
export async function classifyDrop(f: File, nativeIn: NativeFinder): Promise<DropKind> {
  if (/\.(ttf|otf|woff2?)$/i.test(f.name)) return 'font';
  if (/\.sav$/i.test(f.name)) return (await nativeIn(f)).length ? 'native' : 'unknown';
  if (!/\.zip$/i.test(f.name)) return 'unknown';
  if (/^translation/i.test(f.name)) return 'translation'; // by name, without opening the zip (the model pack is not a game or a resource pack)
  try {
    const names = Object.keys((await JSZip.loadAsync(f, { decodeFileName: decodeZipName })).files); // reads the directory only
    // a game has code or data (erb/ or csv/); a zip holding only resources/, sound/ or font/ folders is a pack whatever its name (dat/ is left out: a memory card also holds one)
    const root = detectRoot(names).root;
    if (root !== null && names.some((n) => /(^|\/)(erb|csv)\/[^/]/i.test(n))) return 'game';
    if (root !== null || detectRoot(names, ['resources', 'sound', 'font']).root !== null) return 'pack';
    if (names.some((n) => /\.sav$/i.test(n)) && (await nativeIn(f)).length) return 'native';
    if (names.some((n) => /(^|\/)(sav|dat)\//i.test(n) || /(^|\/)manifest\.json$/i.test(n))) return 'card';
  } catch {
    /* not a readable zip */
  }
  return 'unknown';
}

export interface DropDeps {
  say(t: string): void;
  hasGame(): boolean;
  nativeIn: NativeFinder;
  addFonts(fs: File[]): Promise<void>;
  addPacks(fs: File[]): Promise<{ added: number }>;
  addTranslation(f: File): Promise<string>;
  loadGame(f: File): Promise<void>;
  insertCard(f: File): Promise<void>;
  offerNative(f: File): Promise<void>;
}

export async function ingest(files: File[], d: DropDeps) {
  const by: Record<DropKind, File[]> = {
    game: [],
    card: [],
    native: [],
    pack: [],
    translation: [],
    font: [],
    unknown: [],
  };
  for (const f of files) by[await classifyDrop(f, d.nativeIn)].push(f);
  const said: string[] = [];
  if (by.unknown.length) said.push(`not recognised: ${by.unknown.map((f) => f.name).join(', ')}`);
  if (by.font.length) {
    await d.addFonts(by.font);
    said.push(`${by.font.length} font(s) added`);
  }
  if (by.pack.length) {
    const r = await d.addPacks(by.pack);
    said.push(`${r.added} pack(s) added`);
  }
  for (const f of by.translation) {
    try {
      said.push(`translation pack added: ${await d.addTranslation(f)}`);
    } catch (err) {
      said.push(`${f.name}: ${(err as Error).message}`);
    }
  }
  const card = by.card[0],
    game = by.game[0];
  if (by.card.length > 1) said.push(`only the first card used (${card.name})`);
  if (by.game.length > 1) said.push(`only the first game used (${game.name})`);
  // before any game is open a card waits and the next game takes it; with a game running the card is swapped in after the new game loads
  let cardDone = false;
  const cardNow = async () => {
    cardDone = true;
    await d.insertCard(card);
    said.push(`card ${card.name} inserted`);
  };
  if (card && !d.hasGame()) await cardNow();
  if (game) {
    await d.loadGame(game);
    said.push(`game ${game.name} loaded`);
  }
  if (card && !cardDone) await cardNow();
  // native saves wait for a game (dropped together with one, they are offered after it is open); a game zip that ships saves of its own is offered too
  const natives = [...by.native];
  if (game && (await d.nativeIn(game)).length) natives.push(game);
  for (const f of natives) await d.offerNative(f);
  if (said.length) d.say('Drop: ' + said.join('; ') + '.');
}

export function attachDrop(d: DropDeps) {
  const ov = document.getElementById('dropov')!;
  let depth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    ov.hidden = false;
  });
  document.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) ov.hidden = true;
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    ov.hidden = true;
    void ingest([...e.dataTransfer!.files], d).catch((err) => d.say('Drop failed: ' + err));
  });
}
