/**
 * npm test [-- <selector>... ] [-t <name pattern>] [--changed [<git ref>]] [--list]
 *
 * Tests live in tests/<area>/<topic>.test.ts; the areas and the source paths they cover are in tests/areas.json.
 * A selector is an area (`engine`), a topic (`engine/language`) or a file path. No selector runs everything.
 * `--changed` picks the areas whose source paths differ from the git ref (default HEAD, including uncommitted work).
 * No browser, no network, nothing written to disk.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

type Areas = Record<string, { about: string; sources: string[] }>;
const areas: Areas = JSON.parse(fs.readFileSync('tests/areas.json', 'utf8'));
const areaDirs = fs
  .readdirSync('tests', { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const filesIn = (area: string) =>
  fs
    .readdirSync(path.join('tests', area))
    .filter((f) => f.endsWith('.test.ts'))
    .sort()
    .map((f) => `tests/${area}/${f}`);

const argv = process.argv.slice(2);
const selectors: string[] = [];
let pattern: string | undefined;
let changed: string | undefined;
let list = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-t' || a === '--test-name-pattern') pattern = argv[++i];
  else if (a === '--list') list = true;
  else if (a === '--changed')
    changed = argv[i + 1] && !argv[i + 1].startsWith('-') && !areas[argv[i + 1]] ? argv[++i] : 'HEAD';
  else selectors.push(a);
}

const problems = areaDirs.filter((a) => !areas[a]).map((a) => `tests/${a} is not listed in tests/areas.json`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(2);
}

if (list) {
  for (const a of areaDirs)
    console.log(`${a.padEnd(8)} ${String(filesIn(a).length).padStart(2)} file(s)  ${areas[a].about}`);
  process.exit(0);
}

let files: string[] = [];
if (changed !== undefined) {
  const g = spawnSync('git', ['diff', '--name-only', changed], { encoding: 'utf8' });
  if (g.status !== 0) {
    console.error('git diff failed; run the areas by name instead');
    process.exit(2);
  }
  const touched = g.stdout.split('\n').filter(Boolean);
  const hit = areaDirs.filter((a) => areas[a].sources.some((s) => touched.some((t) => t.startsWith(s))));
  const testsTouched = touched.filter((t) => /^tests\/[^/]+\/.+\.test\.ts$/.test(t));
  console.log(
    hit.length
      ? `areas for the changes since ${changed}: ${hit.join(', ')}`
      : `no area's sources changed since ${changed}`,
  );
  files.push(...hit.flatMap(filesIn), ...testsTouched.filter((t) => fs.existsSync(t)));
}
for (const s of selectors) {
  if (areaDirs.includes(s)) files.push(...filesIn(s));
  else if (fs.existsSync(`tests/${s}.test.ts`)) files.push(`tests/${s}.test.ts`);
  else if (fs.existsSync(s)) files.push(s);
  else {
    console.error(`unknown selector "${s}" (areas: ${areaDirs.join(', ')}; or a topic such as engine/language)`);
    process.exit(2);
  }
}
if (changed === undefined && selectors.length === 0) files = areaDirs.flatMap(filesIn);
files = [...new Set(files)];
if (files.length === 0) process.exit(0);

const args = ['--import', 'tsx', '--test'];
if (pattern) args.push('--test-name-pattern', pattern);
const r = spawnSync(process.execPath, [...args, ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
