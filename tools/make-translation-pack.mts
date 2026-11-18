/**
 * Builds translation zips for the page's optional translation feature (drop the results on the page).
 *
 * The page needs two things: the translation ENGINE (Bergamot, 3 files) and one or more MODELS (3 files each, Mozilla format).
 * They can be one zip or separate zips; separate is better, so the engine is added once and each language is a small zip.
 *
 *   engine zip:    tsx tools/make-translation-pack.mts engine <dir> <out.zip> [--licenses <dir>]
 *                  <dir> holds translator-worker.js, bergamot-translator-worker.js, bergamot-translator-worker.wasm
 *   language zip:  tsx tools/make-translation-pack.mts lang <dir> <out.zip> [--from ko] [--to en] [--variant x] [--name "..."] [--licenses <dir>] [--engine <dir>]
 *                  <dir> holds the three decompressed Mozilla files of ONE pair, as downloaded (the .zst unpacked):
 *                    model.<pair>.intgemm.alphas.bin, lex.50.50.<pair>.s2t.bin, vocab.<pair>.spm
 *                    (or srcvocab.<pair>.spm + trgvocab.<pair>.spm), where <pair> is e.g. koen.
 *                  --from/--to default to the two halves of <pair>; use --from zh-Hans to label Simplified Chinese.
 *                  --engine adds the engine to the same zip, making a single self-contained pack.
 *
 * Shortcut with no tool: zip the three Mozilla files yourself with no manifest. The page recognises them by file name and treats the zip
 * as a language zip (it still needs the engine zip). The tool is for when you want a proper manifest, checksums or licence files inside.
 * --licenses <dir>: every file in that directory is copied into the zip and listed (e.g. LICENSE-MPL-2.0.txt, NOTICE.txt).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { sniffMozilla, type TlManifest } from '../src/translate/pack.ts';

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : undefined;
};
const [mode, dir, out] = args;
if (!['engine', 'lang'].includes(mode ?? '') || !dir || !out) {
  console.error(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(1);
}

const zip = new JSZip();
const sha: Record<string, string> = {};
const add = (zipPath: string, file: string) => {
  const b = fs.readFileSync(file);
  sha[zipPath] = crypto.createHash('sha256').update(b).digest('hex');
  zip.file(zipPath, b, { compression: 'DEFLATE', compressionOptions: { level: 6 } });
};
const need = (d: string, n: string) => {
  const f = path.join(d, n);
  if (!fs.existsSync(f)) throw new Error(`${d} has no ${n}`);
  return f;
};
const engineSpec = (d: string) => {
  for (const n of ['translator-worker.js', 'bergamot-translator-worker.js', 'bergamot-translator-worker.wasm'])
    add('engine/' + n, need(d, n));
  return {
    name: 'bergamot-translator',
    worker: 'engine/translator-worker.js',
    glue: 'engine/bergamot-translator-worker.js',
    wasm: 'engine/bergamot-translator-worker.wasm',
  };
};
const licenses: string[] = [];
const lic = opt('licenses');
if (lic)
  for (const n of fs.readdirSync(lic)) {
    zip.file(n, fs.readFileSync(path.join(lic, n)));
    licenses.push(n);
  }

let m: TlManifest;
if (mode === 'engine') {
  m = {
    format: 1,
    kind: 'translation-engine',
    name: opt('name') ?? 'Translation engine (Bergamot)',
    engine: engineSpec(dir),
  };
} else {
  const names = fs.readdirSync(dir);
  const sn = sniffMozilla(names);
  if (!sn)
    throw new Error(
      `${dir} does not hold a complete set of decompressed Mozilla files (model.<pair>.intgemm*.bin, lex.*.<pair>.s2t.bin, vocab.<pair>.spm)`,
    );
  const sm = sn.models![0];
  const pair = sm.model.slice(6, 10);
  const from = opt('from') ?? sm.from,
    to = opt('to') ?? sm.to;
  const dst = `models/${from}-${to}/`;
  for (const f of [sm.model, sm.shortlist, ...sm.vocabs]) add(dst + f, path.join(dir, f));
  m = {
    format: 1,
    kind: 'translation-pack',
    name: opt('name') ?? `${from} to ${to} (Mozilla ${pair} model)`,
    models: [
      {
        from,
        to,
        ...(opt('variant') ? { variant: opt('variant') } : {}),
        model: dst + sm.model,
        shortlist: dst + sm.shortlist,
        vocabs: sm.vocabs.map((v) => dst + v),
      },
    ],
  };
  if (opt('engine')) m.engine = engineSpec(opt('engine')!);
}
m.sha256 = sha;
if (licenses.length) m.licenses = licenses;
zip.file('translation.json', JSON.stringify(m, null, 1));
fs.writeFileSync(out, await zip.generateAsync({ type: 'nodebuffer' }));
console.log(`${out}: ${m.kind}, ${(fs.statSync(out).size / 1048576).toFixed(1)} MB, ${Object.keys(sha).length} files`);
