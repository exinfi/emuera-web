/** MOBILE: builds the shell into one file, dist-play/play.html (the page + worker are inlined). */
import { build } from 'esbuild';
import fs from 'node:fs';
import { OPTION_DEFS } from '../src/host/protocol.ts';
import { RELEASE } from '../src/version.ts';

const buildStamp = () => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} UTC`;
};
const optionsHtml = OPTION_DEFS.filter((d) => !d.hidden)
  .map(
    (d) =>
      `<label title="${d.title}"><input type="checkbox" id="${d.id}"${d.default ? ' checked' : ''}> ${d.label}</label>`,
  )
  .join('');
// Fonts: the registry's bundled faces (BIZ UDGothic Regular+Bold no-kanji subsets, DotGothic16 subset; SIL OFL, 0.5/1.0 em metrics) travel inside the page.
const fontDir = 'public/assets/font/';
const bundled = [
  'BIZUDGothic-subset-Regular.woff',
  'BIZUDGothic-subset-Bold.woff',
  'DotGothic16-subset-Regular.woff',
].map((f) => ({ file: f, b64: fs.readFileSync(fontDir + f).toString('base64') }));
// The shell's own text face (the chrome, not the game log): BIZ UDPGothic Regular+Bold, Latin/kana/punctuation subsets without hinting. Registered by the page as a plain FontFace, outside the game FontRegistry.
const uiFonts = [
  { family: 'BIZ UDPGothic', weight: '400', file: 'BIZUDPGothic-subset-Regular.woff' },
  { family: 'BIZ UDPGothic', weight: '700', file: 'BIZUDPGothic-subset-Bold.woff' },
].map((f) => ({ family: f.family, weight: f.weight, b64: fs.readFileSync(fontDir + f.file).toString('base64') }));
const licenseNotes: [string, string][] = [
  [
    'BIZUDGothic-OFL.txt',
    'BIZ UDGothic and BIZ UDPGothic subsets (same copyright holder and licence): licensed under the SIL Open Font License 1.1:\n',
  ],
  ['DotGothic16-OFL.txt', 'DotGothic16 subset: licensed under the SIL Open Font License 1.1:\n'],
];
const licenses = licenseNotes
  .map(([f, note]) => note + (fs.existsSync(fontDir + f) ? fs.readFileSync(fontDir + f, 'utf8') : ''))
  .join('\n----\n')
  .replace(/--/g, '- -');
const common = { bundle: true, write: false, target: 'es2022', format: 'iife' as const, minify: true };
const w = await build({ ...common, entryPoints: ['src/play/worker.ts'] });
const p = await build({
  ...common,
  entryPoints: ['src/mobile/mobile.ts'],
  define: {
    WORKER_SRC: JSON.stringify(w.outputFiles[0].text),
    BUNDLED_FONTS: JSON.stringify(bundled),
    UI_FONTS: JSON.stringify(uiFonts),
  },
  platform: 'browser',
});
const js = p.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync('src/mobile/mobile.css', 'utf8');
const body = fs
  .readFileSync('src/mobile/shell.html', 'utf8')
  .replace('%%OPTIONS%%', optionsHtml)
  .replace('%%BUILD%%', `r${RELEASE}, build ${buildStamp()}`);
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>emuera web</title><meta name="viewport" content="width=device-width,initial-scale=1,minimum-scale=1,maximum-scale=1,viewport-fit=cover,interactive-widget=resizes-content"><meta name="theme-color" content="#050505"><style>${css}</style></head><!-- Bundled fonts (SIL OFL 1.1):
${licenses}
-->
<body>${body}<script>${js}</script></body></html>`;
fs.mkdirSync('dist-play', { recursive: true });
fs.writeFileSync('dist-play/play.html', html);
console.log('dist-play/play.html', (html.length / 1024).toFixed(0) + ' KB');
