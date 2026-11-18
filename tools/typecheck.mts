/**
 * Type check that cannot pass by accident. Plain `tsc --noEmit` reports only the missing `vite/client` library when that
 * type library is absent and then skips real checking, so this runs tsc with `--types node` and fails on any error.
 *   npm run typecheck
 */
import { spawnSync } from 'node:child_process';

const r = spawnSync('npx', ['tsc', '--noEmit', '--skipLibCheck', '--types', 'node'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
const out = (r.stdout ?? '') + (r.stderr ?? '');
const errs = out
  .split('\n')
  .map((l) => /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(l))
  .filter(Boolean) as RegExpExecArray[];
const global = out.split('\n').filter((l) => /^error TS\d+/.test(l));
const mine = errs;
for (const m of mine) console.log(`${m[1]}(${m[2]},${m[3]}): ${m[4]} ${m[5]}`);
for (const g of global) console.log(g);
if (r.error) {
  console.log('could not run tsc:', r.error.message);
  process.exit(2);
}
console.log(mine.length || global.length ? `${mine.length + global.length} type error(s)` : `type check clean`);
process.exit(mine.length || global.length ? 1 : 0);
