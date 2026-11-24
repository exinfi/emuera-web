/** Functions over the virtual game folder and the text files games save: ENUMFILES, SAVETEXT, LOADTEXT, EXISTFILE. */
import { compile, toNum } from './eval';
import { def, defRaw, refOf, S } from './funcs';
import { Value } from './value';
import type { VM } from './vm';
import { configValue } from './config';

// ENUMFILES(dir [, pattern, subfolders [, outArray]]): EnumFilesMethod. The game folder is the virtual file list the host gave the VM
// (vm.gameFiles) plus the SAVETEXT files; paths come back relative to the game root with backslash separators, sorted case-insensitively
// (NTFS order); a missing/rooted dir or a bad pattern gives -1; `..\` is stripped from dir as in Utils.GetValidPath.
// The file list is normalised once per game (backslashes, folder index): a game can call ENUMFILES thousands of times in a loop
// (erablue's slot game once per character), and rebuilding the list per call took seconds.
interface FileIndex {
  src: string[];
  n: number;
  users: number;
  all: string[];
  byDir: Map<string, string[]>;
  dirs: Set<string>;
}
const fileIndex = (vm: VM): FileIndex => {
  const c = (vm as any)._fileIndex as FileIndex | undefined;
  if (c && c.src === vm.gameFiles && c.n === vm.gameFiles.length && c.users === vm.userFiles.version) return c;
  const all = [...vm.gameFiles, ...vm.userFiles].map((f) => f.replace(/\//g, '\\'));
  const byDir = new Map<string, string[]>(),
    dirs = new Set<string>();
  for (const f of all) {
    const sp = f.split('\\'),
      dir = sp.slice(0, -1);
    const k = dir.join('\\').toLowerCase();
    let l = byDir.get(k);
    if (!l) byDir.set(k, (l = []));
    l.push(f);
    for (let i = 1; i <= dir.length; i++) dirs.add(dir.slice(0, i).join('\\').toLowerCase());
  }
  const up = (x: string) => x.toUpperCase();
  for (const l of byDir.values()) l.sort((a, b) => (up(a) < up(b) ? -1 : up(a) > up(b) ? 1 : 0));
  const idx: FileIndex = { src: vm.gameFiles, n: vm.gameFiles.length, users: vm.userFiles.version, all, byDir, dirs };
  (vm as any)._fileIndex = idx;
  return idx;
};
const enumFiles = (vm: VM, dirArg: string, pattern: string, deep: boolean): string[] | null => {
  const dir = dirArg.replace(/\//g, '\\').replace(/\.\.\\/g, '');
  if (/^[\\]|^[A-Za-z]:/.test(dir)) return null;
  const parts = dir.split('\\').filter((x) => x && x !== '.');
  const prefix = parts.map((x) => x.toLowerCase());
  const key = prefix.join('\\');
  const ix = fileIndex(vm);
  if (prefix.length && !ix.dirs.has(key)) return null; // directory does not exist
  if (/[\\/]|\.\.$/.test(pattern)) return null;
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
    'i',
  );
  const up = (x: string) => x.toUpperCase();
  if (!deep) return (ix.byDir.get(key) ?? []).filter((f) => re.test(f.slice(f.lastIndexOf('\\') + 1)));
  const pre = key ? key + '\\' : '';
  return ix.all
    .filter((f) => {
      const lf = f.toLowerCase();
      return (!pre || lf.startsWith(pre)) && re.test(f.slice(f.lastIndexOf('\\') + 1));
    })
    .sort((a, b) => (up(a) < up(b) ? -1 : up(a) > up(b) ? 1 : 0));
};
defRaw('ENUMFILES', (vm, args, fn) => {
  const d = compile(args[0], fn, vm),
    pt = args[1] ? compile(args[1], fn, vm) : null,
    op = args[2] ? compile(args[2], fn, vm) : null;
  const out = args[3] ? refOf(args[3], fn, vm) : null;
  return (fr) => {
    const dirS = S(d(fr)),
      patS = pt ? S(pt(fr)) : '*',
      deepB = op ? toNum(op(fr)) !== 0 : false;
    const files = enumFiles(vm, dirS, patS, deepB);
    if (!files || !files.length) {
      vm.missedFile('ENUMFILES', dirS, true);
      vm.noteFileMiss(`ENUMFILES("${dirS}", "${patS}"${op ? `, ${deepB ? 1 : 0}` : ''}) -> ${files ? 0 : -1}`);
    }
    if (!files) return -1;
    let arr: Value[],
      off = 0;
    if (out) {
      const l = out.locate(fr);
      arr = l.arr;
      off = l.off;
    } else arr = vm.global('RESULTS');
    const n = Math.min(arr.length - off, files.length);
    for (let i = 0; i < n; i++) arr[off + i] = files[i];
    return n;
  };
});
// SAVETEXT(text, file, [forceSavDir, forceUTF8]) / LOADTEXT(file, [forceSavDir, forceUTF8]): `file` is a number (sav/txtNN.txt) or a path whose extension must be one of ValidExtension
const textKey = (vm: VM, f: Value | undefined, save: boolean): string | null => {
  if (typeof f !== 'string') {
    const n = Number(f ?? 0);
    if (n < 0 || n > 2147483647) return null;
    return `sav/txt${String(n).padStart(2, '0')}.txt`;
  }
  let p = tkey(f);
  const cv = configValue(vm.config, 'ValidExtension');
  const ok = (typeof cv === 'string' && cv ? cv.split(',') : ['txt']).map((e: string) => e.trim().toLowerCase());
  const m = /\.([^./]*)$/.exec(p);
  if (!m || !ok.includes(m[1])) {
    if (!save) return null;
    p = (m ? p.slice(0, m.index) : p) + '.txt';
  }
  return p;
};
def('SAVETEXT', (vm, a) => {
  const k = textKey(vm, a[1], true),
    t = S(a[0]);
  if (k === null) return 0;
  vm.textFiles.set(k, t);
  vm.userFiles.add(k);
  vm.onPersistFile?.(k, t);
  return 1;
});
def('LOADTEXT', (vm, a) => {
  const k = textKey(vm, a[0], false);
  if (k !== null && !vm.hasText(k)) vm.missedFile('LOADTEXT', typeof a[0] === 'string' ? a[0] : k);
  return k === null ? '' : (vm.getText(k) ?? '').replace(/\r/g, '');
});
const tkey = (p: string) => p.replace(/\\/g, '/').toLowerCase();
def('EXISTFILE', (vm, a) => {
  if (vm.gfx.exists(S(a[0])) || vm.hasText(tkey(S(a[0])))) return 1;
  vm.missedFile('EXISTFILE', S(a[0]));
  return 0;
});
