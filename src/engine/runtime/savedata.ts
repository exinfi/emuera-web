/** SAVEDATA / LOADDATA / DELDATA / CHKDATA / SAVEGLOBAL / LOADGLOBAL. Slots live in vm.saves; the host persists via vm.onPersist. */
import { COMMANDS } from './commands';
import { compile, toNum } from './eval';
import { def } from './funcs';
import { MSG, gameCode, gameVer, versionOk } from './charas';
import { EmueraError } from './value';
import { parseSaveText } from './vm';
import type { VM } from './vm';
import { exprs } from './cmdargs';

const slotKey = (n: number) => `save${n}`;

export function saveGlobalText(vm: VM): string {
  const out: [string, unknown][] = [];
  for (const [k, a] of vm.store.global) {
    const m = vm.store.meta(k);
    if (m && (k === 'GLOBAL' || k === 'GLOBALS' || m.user?.isGlobal)) out.push([k, a]);
  }
  return JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? { $b: v.toString() } : v));
}
export function loadGlobalText(vm: VM, text: string) {
  const d: [string, any[]][] = parseSaveText(text);
  for (const [k, a] of d) vm.store.global.set(k, a);
}

export const SAVE_AUTO = 99;
/** write a normal save slot; `text` is the header shown by the load screen (SAVEDATA_TEXT) */
export function saveSlot(vm: VM, i: number, text: string): boolean {
  const rec = { info: text, data: vm.snapshot(true) };
  vm.saves.set(slotKey(i), rec);
  vm.onPersist?.(slotKey(i), rec);
  return true;
}
export const slotExists = (vm: VM, i: number) => vm.saves.has(slotKey(i));
/** header text of a slot, undefined when the slot is empty */
export const slotInfo = (vm: VM, i: number): string | undefined => vm.saves.get(slotKey(i))?.info;
export function loadSlot(vm: VM, i: number) {
  const rec = vm.saves.get(slotKey(i));
  if (!rec) throw new EmueraError(`save slot ${i} does not exist`);
  vm.restore(rec.data, true);
  // saves written by early web builds carry no data tables: the game's databases (relations, items, ...) would be missing
  if (!rec.data.includes('"dts":'))
    vm.host.print(
      `[web interpreter] save slot ${i} was written by an older build and holds no data-table data (inventory/relationship databases); please start a new game and save again`,
    );
  vm.lastLoad = { no: i, text: rec.info, version: vm.lastLoad.version };
}

COMMANDS.SAVEDATA = (st, fn, vm) => {
  const [n, t] = exprs(st).map((e) => compile(e, fn, vm));
  return (fr) => {
    const i = toNum(n(fr));
    if (i < 0) throw new EmueraError(`SAVEDATA: the slot number must not be negative (${i})`);
    const info = t ? String(t(fr)) : '';
    if (info.includes('\n')) throw new EmueraError('SAVEDATA: the save text must not contain a line break');
    saveSlot(vm, i, info);
  };
};
COMMANDS.DELDATA = (st, fn, vm) => {
  const n = compile(exprs(st)[0], fn, vm);
  return (fr) => {
    const k = slotKey(toNum(n(fr)));
    vm.saves.delete(k);
    vm.onPersist?.(k, null);
  };
};

/** What checkRecord needs from a save, parsed once per record (the load screen checks every slot on each redraw; a save is tens of MB). */
const headers = new WeakMap<object, { data: string; h: { isArray: boolean; code?: unknown; ver?: unknown } | null }>();
function header(rec: { data: string }) {
  const c = headers.get(rec);
  if (c && c.data === rec.data) return c.h;
  let h: { isArray: boolean; code?: unknown; ver?: unknown } | null;
  try {
    const d = JSON.parse(rec.data);
    h = Array.isArray(d) ? { isArray: true } : { isArray: false, code: d.code, ver: d.ver };
  } catch {
    h = null;
  }
  headers.set(rec, { data: rec.data, h });
  return h;
}

/** VariableEvaluator.CheckDataByFilename: RESULTS = header or message, RESULT:1 = saved version; 0 OK, 1 not found, 2 other game, 3 other version, 4 broken */
function checkRecord(vm: VM, rec: { info: string; data: string } | undefined, withVersion: boolean): number {
  const res = vm.global('RESULTS'),
    r = vm.global('RESULT');
  if (!rec) {
    res[0] = '----';
    if (withVersion) r[1] = 0;
    return 1;
  }
  const d = header(rec);
  if (!d) {
    res[0] = MSG.corrupted;
    return 4;
  }
  if (d.isArray) {
    res[0] = rec.info;
    if (withVersion) r[1] = gameVer(vm);
    return 0;
  } // the GLOBAL file carries no header
  if (d.code !== undefined && d.code !== gameCode(vm)) {
    res[0] = MSG.differentGame;
    return 2;
  }
  const ver = Number(d.ver ?? 0);
  if (withVersion) r[1] = ver;
  if (!versionOk(vm, ver)) {
    res[0] = MSG.differentVersion;
    return 3;
  }
  res[0] = rec.info;
  return 0;
}
const slotArg = (name: string, v: unknown) => {
  const n = toNum(v as any);
  if (n < 0) throw new EmueraError(`${name}: argument 1 must not be negative (${n})`);
  if (n > 2147483647) throw new EmueraError(`${name}: argument 1 is too large (${n})`);
  return n;
};
def('CHKDATA', (vm, a) => checkRecord(vm, vm.saves.get(slotKey(slotArg('CHKDATA', a[0]))), true));
def('CHKGLOBALDATA', (vm, a) => {
  slotArg('CHKGLOBALDATA', a[0]);
  return checkRecord(vm, vm.saves.get('global'), true);
});
def('CHKVARDATA', (vm, a) => checkRecord(vm, vm.saves.get(`var_${String(a[0])}`), false));
const glob = (p: string) =>
  new RegExp(
    '^' +
      p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
    'i',
  );
const findFiles = (prefix: string) => (vm: VM, a: any[]) => {
  const re = glob(a.length ? String(a[0]) : '*');
  const names = [...vm.saves.keys()]
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length))
    .filter((n) => n && re.test(n));
  const res = vm.global('RESULTS');
  for (let i = 0; i < Math.min(names.length, res.length); i++) res[i] = names[i];
  return names.length;
};
def('FIND_VARDATA', findFiles('var_'));
def('FIND_CHARADATA', findFiles('chara_'));
def('SAVEGLOBAL', (vm) => {
  const rec = { info: '', data: saveGlobalText(vm) };
  vm.saves.set('global', rec);
  vm.onPersist?.('global', rec);
  return 1;
});
def('LOADGLOBAL', (vm) => {
  const rec = vm.saves.get('global');
  if (!rec) return 0;
  loadGlobalText(vm, rec.data);
  return 1;
});
