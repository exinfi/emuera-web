/** MOBILE: finds the bundled files by name. bundlegame.NAME.zip (one), bundlesave.NAME.zip (bundlecard.NAME.zip is an alias) and bundlepack.NAME.zip (any number); translation*.zip (the translation engine and language zips, any number, engine first); sorted alphabetically with numbers in numeric order (pack2 before pack10). A leading `auto.` (auto.bundlepack.NAME.zip, auto.translation-ja-en.zip) marks a file the page loads by itself when it opens (`auto: true` in the manifest; the name has the prefix removed). */
export interface BundleItem {
  file: string;
  name: string;
  auto?: boolean;
  size?: number;
}
export interface BundleScan {
  game: BundleItem | null;
  saves: BundleItem[];
  packs: BundleItem[];
  translation: BundleItem[];
  ignoredGames: string[];
}
const cmp = (a: BundleItem, b: BundleItem) =>
  a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' });
export function scanBundle(files: string[]): BundleScan {
  const g: BundleItem[] = [],
    saves: BundleItem[] = [],
    packs: BundleItem[] = [],
    tl: BundleItem[] = [];
  for (const f of files) {
    const au = /^auto\./i.test(f),
      n = au ? f.slice(5) : f,
      mark = au ? { auto: true } : {};
    const t = /^(translation[^/]*)\.zip$/i.exec(n);
    if (t) {
      tl.push({ file: f, name: t[1], ...mark });
      continue;
    } // the translation model pack: found by its name (auto.: the page installs it, it never switches translation on)
    const m = /^bundle(game|save|card|pack)\.(.+)\.zip$/i.exec(n);
    if (!m) continue;
    (m[1].toLowerCase() === 'game' ? g : /^(save|card)$/i.test(m[1]) ? saves : packs).push({
      file: f,
      name: m[2],
      ...mark,
    });
  }
  g.sort((a, b) => Number(!!b.auto) - Number(!!a.auto) || cmp(a, b)); // an auto. game wins if there are several
  saves.sort(cmp);
  packs.sort(cmp);
  tl.sort((a, b) => Number(/engine/i.test(b.name)) - Number(/engine/i.test(a.name)) || cmp(a, b)); // the engine zip first, then the languages
  return { game: g[0] ?? null, saves, packs, translation: tl, ignoredGames: g.slice(1).map((x) => x.file) };
}
