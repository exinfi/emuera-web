/**
 * Character commands, following the original (ADDCHARA, ADDVOIDCHARA, DELCHARA, DELALLCHARA and `addChara` are at the end):
 * SWAPCHARA COPYCHARA ADDCOPYCHARA ADDSPCHARA ADDDEFCHARA SORTCHARA PICKUPCHARA CVARSET RESET_STAIN SAVECHARA LOADCHARA
 * plus the CHKCHARADATA function. Characters are `vm.store.charas`; their variables live in `Chara.vars` (lazy arrays).
 */
import type { Expr } from '../compiler/ast';
import { compareValues } from './compare';
import { COMMANDS } from './commands';
import { compile, toNum } from './eval';
import { def } from './funcs';
import { Chara } from './vars';
import { EmueraError, Value } from './value';
import type { VM } from './vm';
import { applyTemplate } from './charatemplates';
import { exprs } from './cmdargs';

export const MSG = {
  noSrc: 'Source of a copy character does not exist',
  noDst: 'Destination of a copy character does not exist',
  swap: 'Attempted to replace a registered character that does not exist',
  sortKey: 'Sort key reference is out of array',
  spOff:
    'SP character-related features are not available by default (Turn on "Allow SP Characters" compatibility option)',
  noTitle: 'This instruction cannot be used outside @SYSTEM_TITLE',
  refUndefined: 'Attempted to refer to an undefined character',
  undefinedChara: 'Attempted to create an undefined character',
  noFile: 'File name is not specified',
  badFile: 'Invalid character in the file name',
  differentGame: 'Attempted to load save data from a different game',
  differentVersion: 'Save data version is different',
  corrupted: 'Save data is corrupted',
};

// ------------------------------------------------------------------ helpers --
const charas = (vm: VM) => vm.store.charas;
const cloneArr = (a: Value[]) => a.slice();
/** CharacterData.CopyTo: every variable of `x` overwrites that of `y` (variables absent in x are at their defaults) */
export function copyChara(vm: VM, x: number, y: number) {
  const l = charas(vm);
  if (x < 0 || x >= l.length) throw new EmueraError(MSG.noSrc);
  if (y < 0 || y >= l.length) throw new EmueraError(MSG.noDst);
  if (x === y) return;
  const s = l[x],
    d = l[y];
  d.no = s.no;
  d.vars = new Map([...s.vars].map(([k, a]) => [k, cloneArr(a)]));
}
export function swapChara(vm: VM, x: number, y: number) {
  const l = charas(vm);
  if (x < 0 || x >= l.length || y < 0 || y >= l.length) throw new EmueraError(MSG.swap);
  if (x === y) return;
  [l[x], l[y]] = [l[y], l[x]];
}

const cmpKey = compareValues;

/** SortChara(sortkey, elem, order, fixMaster): TARGET/ASSI/MASTER follow their characters; MASTER stays in place when fixMaster */
export function sortChara(vm: VM, key: (c: Chara) => Value, descending: boolean, fixMaster: boolean) {
  const l = charas(vm);
  if (l.length <= 1) return;
  const at = (n: string) => Number(vm.global(n)[0]);
  const pick = (i: number) => (i >= 0 && i < l.length ? l[i] : undefined);
  const master = pick(at('MASTER')),
    target = pick(at('TARGET')),
    assi = pick(at('ASSI'));
  const order = new Map<Chara, number>(),
    keys = new Map<Chara, Value>();
  l.forEach((c, i) => {
    order.set(c, i);
    keys.set(c, key(c));
  });
  let list = l.slice();
  if (fixMaster && master) {
    if (l.length <= 2) return;
    list = list.filter((c) => c !== master);
  }
  list.sort((a, b) => {
    const r = cmpKey(keys.get(a)!, keys.get(b)!);
    return r !== 0 ? (descending ? -r : r) : order.get(a)! - order.get(b)!;
  });
  if (fixMaster && master) list.splice(at('MASTER'), 0, master);
  vm.store.charas = list;
  const idx = (c?: Chara) => (c ? list.indexOf(c) : undefined);
  if (master && !fixMaster) vm.global('MASTER')[0] = idx(master)!;
  if (target) vm.global('TARGET')[0] = idx(target)!;
  if (assi) vm.global('ASSI')[0] = idx(assi)!;
}

/** PickUpChara: keep only the listed characters, in the listed order (duplicates and negatives dropped) */
export function pickUpChara(vm: VM, noList: number[]) {
  const l = () => charas(vm);
  const g = (n: string) => vm.global(n);
  const oldT = Number(g('TARGET')[0]),
    oldA = Number(g('ASSI')[0]),
    oldM = Number(g('MASTER')[0]);
  g('TARGET')[0] = -1;
  g('ASSI')[0] = -1;
  g('MASTER')[0] = -1;
  const pick: number[] = [];
  for (const n of noList) if (!pick.includes(n) && n >= 0) pick.push(n);
  for (let i = 0; i < pick.length; i++) {
    if (i !== pick[i]) {
      swapChara(vm, pick[i], i);
      const j = pick.indexOf(i);
      if (j > i) pick[j] = pick[i];
    }
    if (Number(g('TARGET')[0]) < 0 && pick[i] === oldT) g('TARGET')[0] = i;
    if (Number(g('ASSI')[0]) < 0 && pick[i] === oldA) g('ASSI')[0] = i;
    if (Number(g('MASTER')[0]) < 0 && pick[i] === oldM) g('MASTER')[0] = i;
  }
  if (pick.length < l().length) l().length = pick.length;
}

// ----------------------------------------------------------------- commands --
COMMANDS.SWAPCHARA = (st, fn, vm) => {
  const [a, b] = exprs(st).map((e) => compile(e, fn, vm));
  return (fr) => swapChara(vm, toNum(a(fr)), toNum(b(fr)));
};
COMMANDS.COPYCHARA = (st, fn, vm) => {
  const [a, b] = exprs(st).map((e) => compile(e, fn, vm));
  return (fr) => copyChara(vm, toNum(a(fr)), toNum(b(fr)));
};
COMMANDS.ADDCOPYCHARA = (st, fn, vm) => {
  const l = exprs(st).map((e) => compile(e, fn, vm));
  return (fr) => {
    for (const f of l) {
      const x = toNum(f(fr));
      if (x < 0 || x >= charas(vm).length) throw new EmueraError(MSG.noSrc);
      addChara(vm, 0, 'void');
      copyChara(vm, x, charas(vm).length - 1);
    }
  };
};
// GetCharacterTemplate_UseSp ignores its `sp` flag in this branch: the template is looked up by NO either way
COMMANDS.ADDSPCHARA = (st, fn, vm) => {
  const l = exprs(st).map((e) => compile(e, fn, vm));
  return (fr) => {
    if (!vm.config.compatiSPChara) throw new EmueraError(MSG.spOff);
    for (const f of l) {
      if (!vm.templates?.byNo(toNum(f(fr)))) throw new EmueraError(MSG.undefinedChara);
      addChara(vm, toNum(f(fr)));
    }
  };
};
COMMANDS.ADDDEFCHARA = (_st, fn, vm) => () => {
  if (fn.name.toUpperCase() !== 'SYSTEM_TITLE') throw new EmueraError(MSG.noTitle);
  addChara(vm, 0, 'csv');
  const d = Number(vm.tables.gameBase.get('DEFAULTCHARA') ?? -1);
  if (d > 0) addChara(vm, d, 'csv');
};

COMMANDS.PICKUPCHARA = (st, fn, vm) => {
  const es = exprs(st);
  const l = es.map((e) => compile(e, fn, vm));
  const exempt = es.map((e) => e.k === 'var' && ['MASTER', 'ASSI', 'TARGET'].includes(e.name.toUpperCase()));
  return (fr) => {
    const n = charas(vm).length;
    const list = l.map((f, i) => {
      const v = toNum(f(fr));
      if (!exempt[i] && (v < 0 || v >= n))
        throw new EmueraError(
          `Argument number ${i + 1} at the PICKUPCHARA instruction has been given a value outside of the character list range (${v})`,
        );
      return v;
    });
    pickUpChara(vm, list);
  };
};

/** resolves `CFLAG:3` / `TALENT:3:1` / `NAME` (character variable, element position only) to a per-character reader */
function charKey(e: Expr | undefined, fn: any, vm: VM): (fr: any) => (c: number) => Value {
  const v: Expr = e ?? { k: 'var', name: 'NO', idx: [] };
  if (v.k !== 'var') throw new EmueraError('SORTCHARA: argument 1 is not a variable');
  const m = vm.store.meta(v.name.toUpperCase());
  if (!m || !m.chara) throw new EmueraError(`SORTCHARA: argument 1 is not a character variable (${v.name})`);
  const idx = v.idx.map((x: Expr) => compile(x, fn, vm));
  return (fr) => {
    const raw = idx.map((f: any) => f(fr));
    const pos = raw.map((x: Value) => (typeof x === 'string' ? (vm.tables.nameToIndex(m.name, x) ?? -1) : toNum(x)));
    const sub = pos.slice(Math.max(0, pos.length - m.rank));
    return (ci: number) => {
      const a = vm.store.charaArr(ci, m);
      for (let d = 0; d < sub.length; d++) if (sub[d] < 0 || sub[d] >= m.dims[d]) throw new EmueraError(MSG.sortKey);
      return a[vm.store.offset(m, sub)];
    };
  };
}
COMMANDS.SORTCHARA = (st, fn, vm) => {
  const es = exprs(st);
  let desc = false;
  let keyE: Expr | undefined;
  const kw = (e?: Expr) => (e && e.k === 'var' && !e.idx.length ? e.name.toUpperCase() : '');
  if (es.length && (kw(es[0]) === 'FORWARD' || kw(es[0]) === 'BACK')) desc = kw(es[0]) === 'BACK';
  else {
    keyE = es[0];
    if (es[1]) desc = kw(es[1]) === 'BACK';
  }
  const key = charKey(keyE, fn, vm);
  return (fr) => {
    const rd = key(fr);
    const l = charas(vm);
    sortChara(vm, (c) => rd(l.indexOf(c)), desc, true);
  };
};

COMMANDS.CVARSET = (st, fn, vm) => {
  const es = exprs(st);
  const v = es[0];
  if (!v || v.k !== 'var') throw new EmueraError('CVARSET: variable expected');
  const m = vm.store.meta(v.name.toUpperCase());
  // an omitted or empty value/start/end is "not given": the value defaults to 0 or "" by the variable's type (SP_CVAR_SET_ArgumentBuilder)
  const opt = (e?: Expr) => (e && !(e.k === 'var' && e.name === '__EMPTY__') ? compile(e, fn, vm) : null);
  const ix = compile(es[1] ?? { k: 'int', v: 0 }, fn, vm),
    val = opt(es[2]),
    s0 = opt(es[3]),
    e0 = opt(es[4]);
  return (fr) => {
    const n = charas(vm).length;
    if (!m || !m.chara)
      throw new EmueraError(
        `A variable that is not a character variable "${v.name}" has been passed to CVARSET instruction`,
      );
    const index = ix(fr);
    let start = 0,
      end = n;
    if (s0) {
      start = toNum(s0(fr));
      if (start < 0 || start >= n)
        throw new EmueraError(`4 argument of CVARSET instruction (${start}) is out of character range`);
    }
    if (e0) {
      end = toNum(e0(fr));
      if (end < 0 || end > n)
        throw new EmueraError(`5 argument of CVARSET instruction (${start}) is out of character range`);
    }
    if (start > end) [start, end] = [end, start];
    if (m.konst) throw new EmueraError(`Assignment to constant variable ${m.name}`);
    const value = val ? val(fr) : m.isStr ? '' : 0;
    if (m.isStr !== (typeof value === 'string'))
      throw new EmueraError(
        `${m.name}: cannot assign ${typeof value === 'string' ? 'string' : 'integer'} to ${m.isStr ? 'string' : 'integer'} variable`,
      );
    if (m.calc || n === 0) return;
    let off = 0;
    if (m.rank === 1) {
      if (typeof index === 'string') {
        const t = vm.tables.nameToIndex(m.name, index);
        if (t === undefined) throw new EmueraError(`${m.name}: unknown name "${index}"`);
        off = t;
      } else off = toNum(index);
      if (off < 0 || off >= m.dims[0])
        throw new EmueraError(
          `Character array variable "${m.name}" at the 2 argument (${off}) is out of range of the array`,
        );
    } else if (m.rank > 1) throw new EmueraError(`CVARSET: ${m.name} is not a 0/1-dimensional character variable`);
    for (let i = start; i < end; i++) vm.store.charaArr(i, m)[off] = value;
  };
};

COMMANDS.RESET_STAIN = (st, fn, vm) => {
  const a = compile(exprs(st)[0], fn, vm);
  return (fr) => {
    const no = toNum(a(fr));
    if (no < 0 || no >= charas(vm).length) throw new EmueraError(MSG.refUndefined);
    vm.setDefaultStain(no);
  };
};

// -------------------------------------------------------- SAVECHARA / LOADCHARA --
const jsonOut = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? { $b: x.toString() } : x));
const jsonIn = (t: string) => JSON.parse(t, (_k, x) => (x && typeof x === 'object' && '$b' in x ? BigInt(x.$b) : x));
const fileKey = (name: string) => `chara_${name}`;
const checkName = (name: string): string | undefined =>
  !name ? MSG.noFile : /[\\/:*?"<>|\0]/.test(name) ? MSG.badFile : undefined;
export const gameCode = (vm: VM) => String(vm.tables.gameBase.get('GAMECODE') ?? '0');
export const gameVer = (vm: VM) => Number(vm.tables.gameBase.get('VERSION') ?? 0) || 0;
/** CheckVersion: the saved version is accepted when it is >= the minimum version the game allows (ALLOWVERSION), else it must equal VERSION */
export const versionOk = (vm: VM, v: number) => {
  const cur = gameVer(vm),
    allow = vm.tables.gameBase.get('ALLOWVERSION');
  return v === cur || (allow !== undefined && Number(allow) > 0 && v >= Number(allow) && v <= cur);
};

COMMANDS.SAVECHARA = (st, fn, vm) => {
  const l = exprs(st).map((e) => compile(e, fn, vm));
  return (fr) => {
    const name = String(l[0](fr)),
      msg = String(l[1](fr));
    const err = checkName(name);
    if (err) throw new EmueraError(err);
    const n = charas(vm).length;
    const list: number[] = [];
    for (let i = 2; i < l.length; i++) {
      const v = toNum(l[i](fr));
      if (v < 0) throw new EmueraError(`SAVECHARA: argument ${i + 1} is negative (${v})`);
      if (v >= n)
        throw new EmueraError(
          `The value of the ${i + 1} SAVECHARA argument exceeds the range of character registration number`,
        );
      if (list.includes(v))
        throw new EmueraError(`Identical character registration number (${v}) has been specified more than once`);
      list.push(v);
    }
    const data = jsonOut({
      type: 'chara',
      code: gameCode(vm),
      ver: gameVer(vm),
      charas: list.map((i) => ({ no: charas(vm)[i].no, vars: [...charas(vm)[i].vars] })),
    });
    const rec = { info: msg, data };
    vm.saves.set(fileKey(name), rec);
    vm.onPersist?.(fileKey(name), rec);
  };
};

COMMANDS.LOADCHARA = (st, fn, vm) => {
  const f = compile(exprs(st)[0], fn, vm);
  return (fr) => {
    const name = String(f(fr));
    vm.global('RESULT')[0] = 0;
    const rec = vm.saves.get(fileKey(name));
    if (!rec) return;
    let d: any;
    try {
      d = jsonIn(rec.data);
    } catch {
      return;
    }
    if (d.type !== 'chara' || d.code !== gameCode(vm) || !versionOk(vm, Number(d.ver))) return;
    const add = (d.charas as { no: number; vars: [string, Value[]][] }[]).map((c) => {
      const ch = new Chara(c.no);
      ch.vars = new Map(c.vars);
      return ch;
    });
    charas(vm).push(...add);
    vm.global('RESULT')[0] = 1;
  };
};

/** CHKCHARADATA(name): 0 loadable, 1 no file, 2 other game, 3 other version, 4 broken; RESULTS = header text or an error text */
def('CHKCHARADATA', (vm, a) => {
  const name = String(a[0]);
  const res = vm.global('RESULTS');
  const rec = vm.saves.get(fileKey(name));
  if (!rec) {
    res[0] = '----';
    return 1;
  }
  let d: any;
  try {
    d = jsonIn(rec.data);
  } catch {
    res[0] = MSG.corrupted;
    return 4;
  }
  if (d.type !== 'chara') {
    res[0] = MSG.corrupted;
    return 4;
  }
  if (d.code !== gameCode(vm)) {
    res[0] = MSG.differentGame;
    return 2;
  }
  if (!versionOk(vm, Number(d.ver))) {
    res[0] = MSG.differentVersion;
    return 3;
  }
  res[0] = rec.info;
  return 0;
});
// ------------------------------------------------------------- characters --
export function addChara(vm: import('./vm').VM, no: number, mode: 'no' | 'csv' | 'void' = 'no'): number {
  let t;
  if (mode === 'no') {
    t = vm.templates?.byNo(no);
    if (!t) throw new EmueraError('ADDCHARA: character template is not defined');
  } else if (mode === 'csv') t = vm.templates?.byCsvNo(no);
  const c = new Chara(t?.no ?? 0);
  vm.store.charas.push(c);
  const i = vm.store.charas.length - 1;
  applyTemplate(vm, i, t);
  return i;
}
COMMANDS.ADDVOIDCHARA = (_s, _f, vm) => () => {
  addChara(vm, 0, 'void');
};
COMMANDS.ADDCHARA = (st, fn, vm) => {
  const l = exprs(st).map((e) => compile(e, fn, vm));
  return (fr) => {
    for (const f of l) addChara(vm, toNum(f(fr)));
  };
};
COMMANDS.DELCHARA = (st, fn, vm) => {
  const l = exprs(st).map((e) => compile(e, fn, vm));
  return (fr) => {
    const idx = l.map((f) => toNum(f(fr))).sort((a, b) => b - a);
    for (const i of idx) {
      if (i < 0 || i >= vm.store.charas.length) throw new EmueraError(`DELCHARA: character ${i} out of range`);
      vm.store.charas.splice(i, 1);
    }
  };
};
COMMANDS.DELALLCHARA = (_s, _f, vm) => () => {
  vm.store.charas.length = 0;
};
