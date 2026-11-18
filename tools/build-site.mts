/** MOBILE: builds the deployable static site into site/ (what Vercel serves): the mobile shell as index.html, plus the optional bundled files in site/bundled/.
 *  Bundled files live in bundled-assets/ and are found by name: bundlegame.NAME.zip (at most one), bundlesave.NAME.zip (alias bundlecard.NAME.zip) and bundlepack.NAME.zip (any number); translation*.zip (the translation engine and language zips, any number) are also copied.
 *  A static host cannot list a folder, so the build writes site/bundled/bundle.json (game, saves, packs; names sorted alphabetically, numbers in order) for the page to read.
 *  A leading "auto." on a file name (auto.bundlegame.NAME.zip, auto.bundlepack.NAME.zip, auto.bundlesave.NAME.zip, auto.translation-ja-en.zip) marks it for loading when the page opens ("auto": true on its manifest entry); the manifest also carries each file's size. Translation is installed, never switched on. */
import fs from 'node:fs';
import { scanBundle } from './lib/bundle.ts';
await import('./build-mobile.mts'); // writes dist-play/play.html
fs.rmSync('site', { recursive: true, force: true });
fs.mkdirSync('site/bundled', { recursive: true });
fs.copyFileSync('dist-play/play.html', 'site/index.html');
const sc = scanBundle(fs.existsSync('bundled-assets') ? fs.readdirSync('bundled-assets') : []);
if (sc.ignoredGames.length)
  console.warn(
    `WARNING: more than one bundlegame.* file; only one game is bundled. Using ${sc.game!.file}; ignoring ${sc.ignoredGames.join(', ')}`,
  );
const copied = [...(sc.game ? [sc.game] : []), ...sc.saves, ...sc.packs, ...sc.translation];
const sized = <T extends { file: string } | null>(it: T): T =>
  it ? { ...it, size: fs.statSync(`bundled-assets/${it.file}`).size } : it;
for (const it of copied) fs.copyFileSync(`bundled-assets/${it.file}`, `site/bundled/${it.file}`);
if (copied.length)
  fs.writeFileSync(
    'site/bundled/bundle.json',
    JSON.stringify(
      {
        game: sized(sc.game),
        saves: sc.saves.map(sized),
        packs: sc.packs.map(sized),
        translation: sc.translation.map(sized),
      },
      null,
      1,
    ),
  );
console.log(
  'site/index.html' +
    (copied.length
      ? ` + site/bundled/bundle.json (game: ${sc.game ? sc.game.file : 'none'}; ${sc.saves.length} save(s); ${sc.packs.length} pack(s)${sc.translation.length ? '; translation: ' + sc.translation.map((t) => t.file).join(', ') : ''})`
      : ' (no bundle* files in bundled-assets: the page works without bundled buttons)'),
);
