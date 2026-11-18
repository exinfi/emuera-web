/**
 * Array-range functions, following the original:
 * SUMARRAY SUMCARRAY MATCH CMATCH FINDELEMENT FINDLASTELEMENT MAXARRAY MINARRAY MAXCARRAY MINCARRAY INRANGEARRAY INRANGECARRAY
 * NOSAMES ALLSAMES GETNUMB EXISTVAR ARRAYMSORT ARRAYMSORTEX VARSETEX.
 * Plain forms address the subscripted row of the variable (leading subscripts fixed, the last dimension ranged);
 * the C forms range over the characters with the remaining subscripts fixed.
 */
import { netRegex } from '../util/netregex';
import type { Expr } from '../compiler/ast';
import type { FuncDef } from '../compiler/types';
import { key } from '../util/key';
import { compile, compileArg, Frame, toNum } from './eval';
import { def, defRaw, refOf } from './funcs';
import * as V from './value';
import { EmueraError, Int, Value } from './value';
import type { VM } from './vm';
import { compareValues } from './compare';

const OOR = (fname: string, argNo: number, v: number, vname: string) =>
  new EmueraError(`The ${argNo} argument of "${fname}" instruction (${v}) is out of the range of the "${vname}" array`);
const cmp = compareValues;

/** non-character array range: [a,b) of the last dimension of the subscripted row */
function plainRange(vm: VM, args: Expr[], fn: FuncDef, first: number, fname: string, oneD = false) {
  const ref = refOf(args[0], fn, vm);
  const lo = args[first] ? compile(args[first], fn, vm) : null;
  const hi = args[first + 1] ? compile(args[first + 1], fn, vm) : null;
  return (fr: Frame) => {
    const { arr, off } = ref.locate(fr);
    const dims = ref.dimsOf(fr);
    const last = dims[dims.length - 1];
    const len = oneD ? dims[0] : last;
    const base = off - (off % last);
    const a = lo ? toNum(lo(fr)) : 0;
    const b = hi ? toNum(hi(fr)) : len;
    if (a < 0 || a > last) throw OOR(fname, first + 1, a, ref.meta.name);
    if (b < 0 || b > last) throw OOR(fname, first + 2, b, ref.meta.name);
    return { arr, base, a: base + a, b: base + b, lo: a, name: ref.meta.name };
  };
}

/** character range: per-character cell of a character variable with the non-character subscripts fixed */
function charaRange(vm: VM, args: Expr[], fn: FuncDef, first: number, fname: string) {
  const e = args[0];
  if (e.k !== 'var') throw new EmueraError(`${fname}: argument 1 is not a variable`);
  const m = vm.store.meta(e.name.toUpperCase());
  if (!m || !m.chara) throw new EmueraError(`${fname}: argument 1 is not a character variable (${e.name})`);
  const idx = e.idx.map((x: Expr) => compile(x, fn, vm));
  const lo = args[first] ? compile(args[first], fn, vm) : null;
  const hi = args[first + 1] ? compile(args[first + 1], fn, vm) : null;
  return (fr: Frame) => {
    const pos = idx.map((f: any) => {
      const x = f(fr);
      return typeof x === 'string' ? (vm.tables.nameToIndex(m.name, x) ?? -1) : toNum(x);
    });
    const rest = pos.length === m.rank + 1 ? pos.slice(1) : pos;
    const off = vm.store.offset(m, rest);
    const n = vm.store.charas.length;
    const a = lo ? toNum(lo(fr)) : 0;
    const b = hi ? toNum(hi(fr)) : n;
    if (a >= n || a < 0 || b > n || b < 0)
      throw new EmueraError(`${fname}: Specified out of range of character position(${a}～${b})`);
    const cell = (ci: number): Value => vm.store.charaArrRead(ci, m)[off];
    return { a, b, cell, isStr: m.isStr };
  };
}

// ---------------------------------------------------------------- sum -----
defRaw('SUMARRAY', (vm, args, fn) => {
  const rg = plainRange(vm, args, fn, 1, 'SUMARRAY');
  return (fr) => {
    const { arr, a, b } = rg(fr);
    let s: Int = 0;
    for (let i = a; i < b; i++) s = V.add(s, arr[i] as Int);
    return s;
  };
});
defRaw('SUMCARRAY', (vm, args, fn) => {
  const rg = charaRange(vm, args, fn, 1, 'SUMCARRAY');
  return (fr) => {
    const { a, b, cell } = rg(fr);
    let s: Int = 0;
    for (let i = a; i < b; i++) s = V.add(s, cell(i) as Int);
    return s;
  };
});

// -------------------------------------------------------------- match -----
const same = (x: Value, t: Value) => x === t || (t === '' && (x === '' || x == null));
function matchTypes(t: Value, x: Value, fname: string) {
  if (typeof t !== typeof x) throw new EmueraError(`${fname}: the type of argument 2 differs from argument 1`);
}
defRaw('MATCH', (vm, args, fn) => {
  const rg = plainRange(vm, args, fn, 2, 'MATCH', true);
  const val = compile(args[1], fn, vm);
  return (fr) => {
    const { arr, a, b } = rg(fr);
    const t = val(fr);
    let n = 0;
    if (a < b) matchTypes(t, arr[a], 'MATCH');
    if (t === '') {
      for (let i = a; i < b; i++) if (same(arr[i], t)) n++;
    } else {
      for (let i = a; i < b; i++) if (arr[i] === t) n++;
    }
    return n;
  };
});
defRaw('CMATCH', (vm, args, fn) => {
  const rg = charaRange(vm, args, fn, 2, 'CMATCH');
  const val = compile(args[1], fn, vm);
  return (fr) => {
    const { a, b, cell, isStr } = rg(fr);
    const t = val(fr);
    if (isStr !== (typeof t === 'string'))
      throw new EmueraError('CMATCH: the type of argument 2 differs from argument 1');
    let n = 0;
    for (let i = a; i < b; i++) if (same(cell(i), t)) n++;
    return n;
  };
});
const compileRegex = (src: string, fname: string) => {
  try {
    return netRegex(src);
  } catch (e) {
    throw new EmueraError(`${fname}: The 2 argument regex is invalid: ${(e as Error).message}`);
  }
};
function findElement(last: boolean) {
  const fname = last ? 'FINDLASTELEMENT' : 'FINDELEMENT';
  return (vm: VM, args: Expr[], fn: FuncDef) => {
    const rg = plainRange(vm, args, fn, 2, fname, true);
    const val = compile(args[1], fn, vm);
    const exact = args[4] ? compile(args[4], fn, vm) : null;
    return (fr: Frame) => {
      const { arr, lo, a, b } = rg(fr);
      const isExact = exact ? toNum(exact(fr)) !== 0 : false;
      const t = val(fr);
      const hit: (v: Value) => boolean =
        typeof t === 'string'
          ? (() => {
              const re = compileRegex(t, fname);
              return (v: Value) => {
                const s = (v as string) ?? '';
                const m = re.exec(s);
                return isExact ? !!m && m[0].length === s.length : !!m; // exact: the (leftmost) match must span the whole string
              };
            })()
          : (v: Value) => v === t;
      if (a >= b) return -1;
      if (last) {
        for (let i = b - 1; i >= a; i--) if (hit(arr[i])) return i - (a - lo);
      } else for (let i = a; i < b; i++) if (hit(arr[i])) return i - (a - lo);
      return -1;
    };
  };
}
defRaw('FINDELEMENT', findElement(false));
defRaw('FINDLASTELEMENT', findElement(true));

// ----------------------------------------------------------- max / min -----
function maxMin(isMax: boolean, chara: boolean) {
  const fname = `${isMax ? 'MAX' : 'MIN'}${chara ? 'C' : ''}ARRAY`;
  return (vm: VM, args: Expr[], fn: FuncDef) => {
    if (!chara) {
      const rg = plainRange(vm, args, fn, 1, fname, true);
      return (fr: Frame) => {
        const { arr, a, b } = rg(fr);
        let r = arr[a] as Int;
        for (let i = a + 1; i < b; i++) {
          const v = arr[i] as Int;
          if (isMax ? v > r : v < r) r = v;
        }
        return r;
      };
    }
    const rg = charaRange(vm, args, fn, 1, fname);
    return (fr: Frame) => {
      const { a, b, cell } = rg(fr);
      let r = cell(a) as Int;
      for (let i = a + 1; i < b; i++) {
        const v = cell(i) as Int;
        if (isMax ? v > r : v < r) r = v;
      }
      return r;
    };
  };
}
defRaw('MAXARRAY', maxMin(true, false));
defRaw('MINARRAY', maxMin(false, false));
defRaw('MAXCARRAY', maxMin(true, true));
defRaw('MINCARRAY', maxMin(false, true));

// INRANGEARRAY(var, min, max [, start, end]): counts min <= v < max (the upper bound is exclusive, unlike INRANGE)
defRaw('INRANGEARRAY', (vm, args, fn) => {
  const rg = plainRange(vm, args, fn, 3, 'INRANGEARRAY', true);
  const lo = compile(args[1], fn, vm),
    hi = compile(args[2], fn, vm);
  return (fr) => {
    const mn = lo(fr) as Int,
      mx = hi(fr) as Int;
    const { arr, a, b } = rg(fr);
    let n = 0;
    for (let i = a; i < b; i++) {
      const v = arr[i] as Int;
      if (v >= mn && v < mx) n++;
    }
    return n;
  };
});
defRaw('INRANGECARRAY', (vm, args, fn) => {
  const rg = charaRange(vm, args, fn, 3, 'INRANGECARRAY');
  const lo = compile(args[1], fn, vm),
    hi = compile(args[2], fn, vm);
  return (fr) => {
    const mn = lo(fr) as Int,
      mx = hi(fr) as Int;
    const { a, b, cell } = rg(fr);
    let n = 0;
    for (let i = a; i < b; i++) {
      const v = cell(i) as Int;
      if (v >= mn && v < mx) n++;
    }
    return n;
  };
});

// -------------------------------------------------------- value groups -----
def('NOSAMES', (_, a) => {
  if (!a.length) return 1;
  return new Set(a.map((x) => (typeof x === 'bigint' ? (Number(x) === Number.MAX_SAFE_INTEGER ? x : Number(x)) : x)))
    .size === a.length
    ? 1
    : 0;
});
def('ALLSAMES', (_, a) => {
  for (let i = 1; i < a.length; i++) if (a[i] !== a[0]) return 0;
  return 1;
});

// ----------------------------------------------------------- variables -----
const varByName = (vm: VM, name: string) => vm.store.meta(key(name.trim()));
/** the variable a name denotes inside function `fn`: its own #DIM variables first (GetVariableToken(name, null, allowPrivate: true)), then globals */
const metaIn = (vm: VM, fn: FuncDef, name: string) => {
  const k = key(name.trim());
  const d = fn.vars.get(k);
  if (d)
    return {
      name: d.name,
      isStr: d.isStr,
      rank: d.dims.length,
      konst: d.isConst,
      calc: false,
      chara: false,
      dims: d.dims,
    };
  return varByName(vm, name);
};
/** GETNUMB(varname, name): index of `name` in the CSV name table of the variable named by the string */
defRaw('GETNUMB', (vm, ex, fn) => {
  const a0 = compile(ex[0], fn, vm),
    a1 = compile(ex[1], fn, vm);
  return (fr) => {
    const vn = String(a0(fr));
    const m = metaIn(vm, fn, vn);
    if (!m) throw new EmueraError(`GETNUMB argument 1 ("${vn}") is not a variable name`);
    const w = String(a1(fr));
    return vm.tables.userTable(m.name, 0)?.byName.get(w) ?? vm.tables.nameToIndex(m.name, w) ?? -1;
  };
});
/** EXISTVAR(name): bit0 integer, bit1 string, bit2 constant, bit3 2-D, bit4 3-D; 0 when no such variable */
defRaw('EXISTVAR', (vm, ex, fn) => {
  const a0 = compile(ex[0], fn, vm);
  return (fr) => {
    const m = metaIn(vm, fn, String(a0(fr)));
    if (!m) return 0;
    return (m.isStr ? 2 : 1) | (m.konst ? 4 : 0) | (m.rank === 2 ? 8 : 0) | (m.rank === 3 ? 16 : 0);
  };
});

// ------------------------------------------------------------ multisort -----
/** reorder the first dimension of a flat array by `order` (rows = product of the remaining dimensions) */
function reorder(arr: Value[], dims: number[], order: number[]): boolean {
  if (dims[0] < order.length) return false;
  const row = dims.slice(1).reduce((p, q) => p * q, 1);
  const clone = arr.slice();
  for (let i = 0; i < order.length; i++) for (let x = 0; x < row; x++) arr[i * row + x] = clone[order[i] * row + x];
  return true;
}
function sortOrder(arr: Value[], count: number, ascending: boolean, stopAtEmpty: boolean): number[] | null {
  const list: { k: Value; i: number }[] = [];
  for (let i = 0; i < count; i++) {
    const v = arr[i];
    if (stopAtEmpty && (v === 0 || v === 0n || v === '' || v == null)) break;
    list.push({ k: v, i });
  }
  list.sort((p, q) => (ascending ? 1 : -1) * cmp(p.k, q.k));
  return list.map((x) => x.i);
}
defRaw('ARRAYMSORT', (vm, args, fn) => {
  const refs = args.map((e) => refOf(e, fn, vm));
  return (fr) => {
    const k = refs[0];
    const karr = k.locate(fr).arr;
    const order = sortOrder(karr, k.dimsOf(fr)[0], true, true)!;
    for (const r of refs) {
      const { arr } = r.locate(fr);
      if (!reorder(arr, r.dimsOf(fr), order)) return 0;
    }
    return 1;
  };
});
defRaw('ARRAYMSORTEX', (vm, args, fn) => {
  const first = args[0];
  const firstRef = first.k === 'var' ? refOf(first, fn, vm) : null;
  const firstName = firstRef ? null : compile(first, fn, vm);
  const list = refOf(args[1], fn, vm);
  const asc = args[2] ? compile(args[2], fn, vm) : null;
  const fixed = args[3] ? compile(args[3], fn, vm) : null;
  return (fr) => {
    const ascending = !asc || toNum(asc(fr)) !== 0;
    const fixedLen = fixed ? toNum(fixed(fr)) : -1;
    if (fixedLen === 0) return 0;
    // names resolve like GETVAR text: globals, CSV names and the calling function's own #DIM variables
    const target = (nm: string) => {
      let r;
      try {
        r = runtimeVar(vm, fn, nm);
      } catch {
        throw new EmueraError(`ARRAYMSORTEX:${nm} is not variable`);
      }
      const m = r.meta;
      if (m.calc || m.konst) throw new EmueraError(`ARRAYMSORTEX:${nm} is not variable`);
      if (m.chara) throw new EmueraError(`ARRAYMSORTEX:${nm} is character variable`);
      if (m.rank < 1) throw new EmueraError(`ARRAYMSORTEX:${nm} is not an array`);
      return r;
    };
    let karr: Value[];
    let kdims: number[];
    if (firstRef) {
      karr = firstRef.locate(fr).arr;
      kdims = firstRef.dimsOf(fr);
    } else {
      const r = target(String(firstName!(fr)));
      karr = r.locate(fr).arr;
      kdims = r.dimsOf(fr);
    }
    if (kdims.length !== 1) throw new EmueraError('ARRAYMSORTEX:The 1 argument is not a one-dimensional variable');
    const len = fixedLen > 0 ? Math.min(fixedLen, karr.length) : karr.length;
    const lst: { k: Value; i: number }[] = [];
    for (let i = 0; i < len; i++) {
      const v = karr[i];
      if (fixedLen === -1 && (v === 0 || v === 0n)) break;
      if (fixedLen === -1 && v === '') return 0;
      lst.push({ k: v, i });
    }
    lst.sort((p, q) => (ascending ? 1 : -1) * cmp(p.k, q.k));
    const order = lst.map((x) => x.i);
    const names = list.locate(fr).arr.slice(0, list.dimsOf(fr)[0]).map(String);
    for (const nm of names) {
      const r = target(nm);
      if (!reorder(r.locate(fr).arr, r.dimsOf(fr), order)) return 0;
    }
    return 1;
  };
});

// VARSETEX(name, [value, setAllDims, start, end]): the variable is given as text ("ARR:1:2"); quirks of the original are kept
import { byName, runtimeVar } from './varbyname';
defRaw('VARSETEX', (vm, ex, fn) => {
  const cs = ex.map((e) => (e ? compileArg(e, fn, vm) : () => undefined as unknown as Value));
  return (fr) => {
    const a = cs.map((c) => c(fr));
    const name = String(a[0]);
    let r: { arr: Value[]; off: number; meta: any; dims?: number[] };
    try {
      const rr = runtimeVar(vm, fn, name);
      const l = rr.locate(fr);
      r = { arr: l.arr, off: l.off, meta: rr.meta, dims: rr.dimsOf(fr) };
    } catch {
      r = byName(vm, name);
    } // the function's own #DIM variables too
    const m = r.meta;
    if (m.konst) throw new EmueraError(`${name} is not a variable`);
    const all = a[2] === undefined ? true : toNum(a[2]) !== 0;
    const start = a[3] === undefined ? 0 : toNum(a[3]);
    const d = r.dims ?? m.dims;
    const end = a[4] !== undefined ? toNum(a[4]) : m.rank === 1 ? d[0] : m.rank === 2 ? d[1] : 0;
    let val: Value = m.isStr ? '' : 0;
    if (a[1] !== undefined) {
      if (m.isStr !== (typeof a[1] === 'string'))
        throw new EmueraError(
          m.isStr
            ? `Attempted to assign an integer to a string variable ${name}`
            : `Attempted to assign a string to an integer variable ${name}`,
        );
      val = a[1];
    }
    const arr = r.arr,
      off = r.off;
    if (m.rank <= 1) {
      for (let i = start; i < end && i < arr.length; i++) arr[i] = val;
      return 1;
    }
    if (m.rank === 2) {
      const i1 = Math.floor(off / d[1]),
        i2 = off % d[1];
      if (!m.isStr && all) {
        for (let j = 0; j < d[0]; j++) for (let i = Math.max(start, i2); i < end; i++) arr[j * d[1] + i] = val;
      } else for (let i = Math.max(start, i2); i < end; i++) arr[i1 * d[1] + i] = val;
      return 1;
    }
    const i1 = Math.floor(off / (d[1] * d[2])),
      i2 = Math.floor(off / d[2]) % d[1],
      i3 = off % d[2];
    if (!m.isStr && all) {
      for (let k = 0; k < d[0]; k++)
        for (let j = 0; j < d[1]; j++)
          for (let i = Math.max(start, i3); i < end; i++) arr[(k * d[1] + j) * d[2] + i] = val;
    } else for (let i = Math.max(start, i3); i < end; i++) arr[(i2 * d[1] + i1) * d[2] + i] = val; // array[idx2, idx1, i] as in the original
    return 1;
  };
});
