/** Builtin expression functions. `run` gets evaluated args; `raw` gets the Expr args (array/variable arguments). */
import { netRegex } from '../util/netregex';
import type { Expr } from '../compiler/ast';
import type { FuncDef } from '../compiler/types';
import { key } from '../util/key';
import { asInt, asStr, compile, Fn, Frame, resolveRef, toNum } from './eval';
import { builtinVarNames } from './vars';
import * as V from './value';
import { EmueraError, Int, Value } from './value';
import { sjisWidth } from './text';
import { configValue } from './config';
import type { VM } from './vm';
import { DataTable, typeFromArg } from './datatable';

export interface BuiltinFn {
  run: (vm: VM, args: Value[], fr: Frame) => Value;
  raw?: (vm: VM, args: Expr[], fn: FuncDef) => Fn;
}
export const FUNCS: Record<string, BuiltinFn> = {};
export const def = (name: string, run: BuiltinFn['run']) => {
  FUNCS[name] = { run };
};
export const defRaw = (name: string, raw: NonNullable<BuiltinFn['raw']>) => {
  FUNCS[name] = { run: () => 0, raw };
};

export const I = (v: Value | undefined, what = 'value'): Int => asInt(v ?? 0, what);
export const S = (v: Value | undefined, what = 'value'): string => asStr(v ?? '', what);

// ---------------------------------------------------------------- math ------
def('MAX', (_, a) => {
  if (a.length === 2) {
    const x = asInt(a[0]),
      y = asInt(a[1]);
    return y > x ? y : x;
  }
  return a.map((x) => asInt(x)).reduce((p, q) => (q > p ? q : p));
});
def('MIN', (_, a) => {
  if (a.length === 2) {
    const x = asInt(a[0]),
      y = asInt(a[1]);
    return y < x ? y : x;
  }
  return a.map((x) => asInt(x)).reduce((p, q) => (q < p ? q : p));
});
def('ABS', (_, a) => {
  const x = I(a[0], 'ABS');
  return x < 0 ? V.neg(x) : x;
});
def('LIMIT', (_, a) => {
  const [x, lo, hi] = a.map((v) => asInt(v));
  return x < lo ? lo : x > hi ? hi : x;
});
def('INRANGE', (_, a) => {
  const x = asInt(a[0]),
    lo = asInt(a[1]),
    hi = asInt(a[2]);
  return x >= lo && x <= hi ? 1 : 0;
});
def('SIGN', (_, a) => V.cmp(I(a[0], 'SIGN'), 0));
/** (long)double with the original's NaN / infinity / int64-range checks (PowerMethod, LogMethod, ExpMethod) */
const dblToInt = (name: string, d: number): Int => {
  if (Number.isNaN(d)) throw new EmueraError(`${name}: the result is not a number`);
  if (!Number.isFinite(d)) throw new EmueraError(`${name}: the result is infinite`);
  if (d >= 9223372036854775807 || d <= -9223372036854775808)
    throw new EmueraError(`${name}: the result (${d}) is out of the range of a 64-bit integer`);
  const t = Math.trunc(d);
  return Number.isSafeInteger(t) ? t + 0 : V.norm(BigInt(t));
};
export { dblToInt };
def('POWER', (_, a) => dblToInt('POWER', Math.pow(toNum(I(a[0], 'POWER')), toNum(I(a[1], 'POWER'))))); // Math.Pow: a negative exponent gives 0 for |x| > 1
const needNonNeg = (name: string, x: Int) => {
  if (V.cmp(x, 0) < 0) throw new EmueraError(`${name}: argument 1 is negative (${x})`);
};
def('SQRT', (_, a) => {
  const x = I(a[0], 'SQRT');
  needNonNeg('SQRT', x);
  return Math.floor(Math.sqrt(toNum(x)));
});
def('CBRT', (_, a) => {
  const x = I(a[0], 'CBRT');
  needNonNeg('CBRT', x);
  return Math.trunc(Math.pow(toNum(x), 1 / 3));
});
const logFn = (name: string, f: (x: number) => number) =>
  def(name, (_, a) => {
    const x = I(a[0], name);
    if (V.cmp(x, 0) <= 0) throw new EmueraError(`${name}: argument 1 must be more than 0 (${x})`);
    return dblToInt(name, f(toNum(x)));
  });
logFn('LOG', Math.log);
logFn('LOG10', Math.log10);
def('EXPONENT', (_, a) => dblToInt('EXPONENT', Math.exp(toNum(I(a[0], 'EXPONENT')))));
def('GETBIT', (_, a) => {
  const x = a[0],
    n = a[1];
  if (typeof x === 'number' && typeof n === 'number' && n >= 0 && n < 53) return Math.floor(x / 2 ** n) & 1;
  return V.bitAnd(V.shr(I(x, 'GETBIT'), I(n, 'GETBIT')), 1);
});
def('RAND', (vm, a) => {
  if (a.length === 1) return vm.randInt(I(a[0], 'RAND'));
  const lo = I(a[0], 'RAND'),
    hi = I(a[1], 'RAND');
  return V.add(lo, vm.randInt(V.sub(hi, lo)));
});

// -------------------------------------------------------------- strings -----
def('STRLENS', (_, a) => sjisWidth(S(a[0], 'STRLENS')));
def('STRLENSU', (_, a) => S(a[0], 'STRLENSU').length);
def('TOSTR', (_, a) => {
  const v = I(a[0], 'TOSTR');
  if (a.length < 2) return String(v);
  return formatNumber(v, S(a[1], 'TOSTR'));
});
/** .NET numeric format strings: D/X standard forms and custom 0 # , patterns with literals. */
export function formatNumber(v: Int, fmt: string): string {
  if (fmt === '') return String(v);
  const neg = v < 0;
  const abs = BigInt(neg ? V.neg(v) : v);
  const sign = neg ? '-' : '';
  const nf = /^([NnFf])(\d*)$/.exec(fmt);
  if (nf) {
    const d = nf[2] ? Number(nf[2]) : 2;
    let s = abs.toString();
    if (nf[1].toLowerCase() === 'n') s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return sign + s + (d ? '.' + '0'.repeat(d) : '');
  }
  const m = /^([DdXx])(\d*)$/.exec(fmt);
  if (m) {
    const n = m[2] ? Number(m[2]) : 0;
    let s = abs.toString(m[1].toLowerCase() === 'x' ? 16 : 10);
    if (m[1] === 'X') s = s.toUpperCase();
    return sign + s.padStart(n, '0');
  }
  const dot = fmt.indexOf('.');
  const intFmt = dot < 0 ? fmt : fmt.slice(0, dot);
  const fracFmt = dot < 0 ? '' : fmt.slice(dot + 1);
  const isPh = (c: string) => c === '0' || c === '#';
  const fracPh = [...fracFmt].filter(isPh);
  const fdigits = fracPh.length;
  // trailing commas at the end of the integer section scale the number down by 1000 each
  const scaleN = /,+$/.exec(intFmt)?.[0].length ?? 0;
  const body = scaleN ? intFmt.slice(0, intFmt.length - scaleN) : intFmt;
  const den = 1000n ** BigInt(scaleN);
  const num = abs * 10n ** BigInt(fdigits);
  const q = scaleN || fdigits ? (num * 2n + den) / (2n * den) : abs;
  const unit = 10n ** BigInt(fdigits);
  const ipart = q / unit,
    fpart = q % unit;
  const phs = [...body].filter(isPh).length;
  if (phs === 0 && fdigits === 0) return fmt;
  const digits = String(ipart);
  const grouping = [...body].some(
    (c, i) => c === ',' && [...body].slice(0, i).some(isPh) && [...body].slice(i).some(isPh),
  );
  const extra = Math.max(0, digits.length - phs);
  const ds = digits.padStart(phs, ' ');
  let di = 0,
    seen = false,
    out = '';
  for (const c of body) {
    if (isPh(c)) {
      let d = di === 0 ? ds.slice(0, extra + 1) : ds[extra + di];
      di++;
      if (d.trim() === '') d = c === '0' ? '0' : '';
      else if (c === '#' && !seen && /^0+$/.test(d) && ipart === 0n) d = '';
      if (d !== '') seen = true;
      out += d;
    } else if (c !== ',') out += c;
  }
  if (grouping) out = out.replace(/\d+/, (n) => n.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  if (fdigits || fracFmt) {
    let fs = String(fpart).padStart(fdigits, '0');
    let k = 0,
      fo = '';
    for (const c of fracFmt) {
      if (isPh(c)) {
        fo += fs[k++];
      } else fo += c;
    }
    // '#' placeholders drop trailing zeros
    const lastZero = [...fracFmt].lastIndexOf('0');
    void lastZero;
    out += '.' + fo;
  }
  return sign + out;
}
def('TOINT', (_, a) => V.parseIntLoose(S(a[0], 'TOINT')));
def('ISNUMERIC', (_, a) => V.bool(/^\s*[+-]?\d+\s*$/.test(S(a[0], 'ISNUMERIC'))));
def('TOUPPER', (_, a) => S(a[0], 'TOUPPER').toUpperCase());
def('TOLOWER', (_, a) => S(a[0], 'TOLOWER').toLowerCase());
def('TOHALF', (_, a) =>
  S(a[0], 'TOHALF')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' '),
);
def('TOFULL', (_, a) =>
  S(a[0], 'TOFULL')
    .replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))
    .replace(/ /g, '　'),
);
const rx = (p: string, flags = 'g') => {
  try {
    return netRegex(p, flags);
  } catch {
    throw new EmueraError(`invalid regular expression: ${p}`);
  }
};
def('REPLACE', (_, a) => {
  const s = S(a[0], 'REPLACE'),
    p = S(a[1], 'REPLACE'),
    r = S(a[2], 'REPLACE');
  return a[3] !== undefined && toNum(a[3]) === 1 ? s.split(p).join(r) : s.replace(rx(p), r.replace(/\$(\d+)/g, '$$$1'));
});
def('UNICODE', (_, a) => String.fromCodePoint(toNum(a[0])));
def('CHARATU', (_, a) => {
  const s = [...S(a[0], 'CHARATU')];
  const i = toNum(a[1]);
  return s[i] ?? '';
});
def('STRCOUNT', (_, a) => {
  const m = S(a[0], 'STRCOUNT').match(rx(S(a[1], 'STRCOUNT')));
  return m ? m.length : 0;
});
def('STRFINDU', (_, a) => S(a[0], 'STRFINDU').indexOf(S(a[1], 'STRFINDU'), a[2] === undefined ? 0 : toNum(a[2])));
def('STRFIND', (_, a) => {
  // byte positions (Shift-JIS), like SUBSTRING
  const s = S(a[0], 'STRFIND'),
    t = S(a[1], 'STRFIND');
  const from = a[2] === undefined ? 0 : toNum(a[2]);
  let start = 0,
    pos = 0;
  while (start < s.length && pos < from) {
    pos += sjisWidth(s[start]);
    start++;
  }
  const i = s.indexOf(t, start);
  return i < 0 ? -1 : sjisWidth(s.slice(0, i));
});
def('ESCAPE', (_, a) => S(a[0], 'ESCAPE').replace(/[\\*+?|{[()^$.#\s]/g, '\\$&'));

function sjisSlice(s: string, start: number, len: number): string {
  // position/length in Shift-JIS bytes; a split full-width char rounds to the next position
  const chars = [...s];
  let pos = 0,
    out = '',
    i = 0;
  while (i < chars.length && pos < start) {
    pos += sjisWidth(chars[i]);
    i++;
  }
  if (len < 0) return chars.slice(i).join('');
  let taken = 0;
  while (i < chars.length && taken < len) {
    const w = sjisWidth(chars[i]);
    out += chars[i];
    taken += w;
    i++;
  }
  return out;
}
def('SUBSTRING', (_, a) => sjisSlice(S(a[0], 'SUBSTRING'), toNum(a[1]), a[2] === undefined ? -1 : toNum(a[2])));
def('SUBSTRINGU', (_, a) => {
  const c = [...S(a[0], 'SUBSTRINGU')],
    st = toNum(a[1]),
    n = a[2] === undefined ? -1 : toNum(a[2]);
  return n < 0 ? c.slice(st).join('') : c.slice(st, st + n).join('');
});

// --------------------------------------------------------------- arrays -----
export const refOf = (e: Expr | undefined, fn: FuncDef, vm: VM) => {
  if (!e || e.k !== 'var' || e.name === '__EMPTY__') throw new EmueraError('variable expected');
  return resolveRef(e, fn, vm);
};
defRaw('VARSIZE', (vm, args, fn) => {
  const nameFn = compile(args[0], fn, vm);
  const dim = args[1] ? compile(args[1], fn, vm) : null;
  return (fr) => {
    const n = key(asStr(nameFn(fr), 'VARSIZE'));
    const bound = fr.refs?.get(n); // a #DIM REF parameter reports the size of the array it is bound to
    const m = bound
      ? { dims: bound.dims.length ? bound.dims : [bound.arr.length - bound.off] }
      : fr.fn.vars.get(n)
        ? { dims: fr.fn.vars.get(n)!.dims }
        : vm.store.meta(n);
    if (!m) throw new EmueraError(`VARSIZE: unknown variable ${n}`);
    let d = dim ? toNum(dim(fr)) : 0;
    // VARSIZEの次元指定をERD機能に合わせる (VarsizeDimConfig): the dimension argument counts from 1, like the @N of ERD files
    if (d > 0 && configValue(vm.config, 'VarsizeDimConfig') === 1) d--;
    if (d < 0 || d >= m.dims.length)
      throw new EmueraError(
        m.dims.length === 0
          ? `Attempted to get the size of a non-array character variable "${n}"`
          : `Attempted to get the size of the non-existing dimension of an array variable "${n}"`,
      );
    return m.dims[d];
  };
});
defRaw('GETNUM', (vm, args, fn) => {
  const v = args[0];
  const nm = compile(args[1], fn, vm);
  const dim = args[2] ? compile(args[2], fn, vm) : null;
  return (fr) => {
    const name = v.k === 'var' ? v.name : '';
    const word = asStr(nm(fr), 'GETNUM');
    const d = dim ? toNum(dim(fr)) : 1; // GETNUM(var, name [, dimension]): the dimension is 1-based, as in VAR@N.ERD
    const up = key(name);
    const user = vm.prog.globals.get(up);
    if (user || (!vm.store.meta(up)?.calc && vm.tables.userTable(name, d - 1))) {
      const t = vm.tables.userTable(name, d - 1);
      return t?.byName.get(word) ?? -1;
    }
    return vm.tables.nameToIndex(name, word) ?? -1;
  };
});
// ----------------------------------------------------------------- misc -----
// ISDEFINED(name): is there a #DEFINE macro of that name
def('ISDEFINED', (vm, a) =>
  V.bool((vm.prog.macros ?? []).some((m) => m.toUpperCase() === S(a[0], 'ISDEFINED').toUpperCase())),
);
def('EXISTFUNCTION', (vm, a) => {
  const f = vm.findFunc(S(a[0], 'EXISTFUNCTION'));
  return !f ? 0 : f.method === 'int' ? 2 : f.method === 'str' ? 3 : 1;
});
/** .NET DateTime.Now.ToString("yyyy/MM/dd HH:mm:ss") (local time) */
export const nowText = (d = new Date()) =>
  `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
export const nowNumber = (d = new Date()) =>
  Number(
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}${String(d.getMilliseconds()).padStart(3, '0')}`,
  );
// DateTime.Now.Ticks counts 100 ns since 0001-01-01 in local time
const ticksMs = () => Date.now() - new Date().getTimezoneOffset() * 60000 + 62135596800000;
def('GETTIME', () => nowNumber());
def('GETTIMES', () => nowText());
def('GETMILLISECOND', () => ticksMs());
def('GETSECOND', () => Math.floor(ticksMs() / 1000));
void key;

defRaw('STRJOIN', (vm, args, fn) => {
  const ref = refOf(args[0], fn, vm);
  const sep = args[1] ? compile(args[1], fn, vm) : null;
  const st = args[2] ? compile(args[2], fn, vm) : null;
  const cnt = args[3] ? compile(args[3], fn, vm) : null;
  return (fr) => {
    const { arr, off } = ref.locate(fr);
    const jd = ref.dimsOf(fr),
      last = jd[jd.length - 1];
    const base = off - (off % last);
    const a = st ? toNum(st(fr)) : 0;
    const n = cnt ? toNum(cnt(fr)) : last - a;
    // JoinMethod: a negative count is an error, then IsArrayRangeValid(index1, index1 + count) wants both within [0, size] of the last dimension
    const nm = ref.meta.name;
    if (n < 0) throw new EmueraError(`STRJOIN: Specified negative value(${n}) to the 4 argument`);
    if (a < 0 || a > last)
      throw new EmueraError(`The 2 argument of "STRJOIN" instruction (${a}) is out of the range of the "${nm}" array`);
    if (a + n < 0 || a + n > last)
      throw new EmueraError(
        `The 3 argument of "STRJOIN" instruction (${a + n}) is out of the range of the "${nm}" array`,
      );
    return arr
      .slice(base + a, base + a + n)
      .map(String)
      .join(sep ? asStr(sep(fr)) : ',');
  };
});
def('LINEISEMPTY', (vm) => {
  const h = vm.host as unknown as { lineIsEmpty?: () => boolean };
  return h.lineIsEmpty ? V.bool(h.lineIsEmpty()) : 1;
});
function findChara(vm: VM, args: Expr[], fn: FuncDef, rev: boolean): Fn {
  const ref = refOf(args[0], fn, vm);
  const val = compile(args[1], fn, vm);
  const lo = args[2] ? compile(args[2], fn, vm) : null;
  const hi = args[3] ? compile(args[3], fn, vm) : null;
  return (fr) => {
    const tgt = vm.global('TARGET');
    const saved = tgt[0];
    const n = vm.store.charas.length;
    const a = lo ? toNum(lo(fr)) : 0,
      b = hi ? toNum(hi(fr)) : n;
    const want = val(fr);
    try {
      for (let k = 0; k < b - a; k++) {
        const i = rev ? b - 1 - k : a + k;
        tgt[0] = i;
        if (ref.get(fr) === want) return i;
      }
    } finally {
      tgt[0] = saved;
    }
    return -1;
  };
}
defRaw('FINDCHARA', (vm, args, fn) => findChara(vm, args, fn, false));
defRaw('FINDLASTCHARA', (vm, args, fn) => findChara(vm, args, fn, true));

// ------------------------------------------------------------------ MAP_* ---
// Emuera.EM associative arrays (Dictionary<string,string>); cleared by RESETDATA.
const mapOf = (vm: VM, n: Value | undefined) => vm.maps.get(S(n, 'MAP'));
def('MAP_CREATE', (vm, a) => {
  const n = S(a[0], 'MAP_CREATE');
  if (vm.maps.has(n)) return 0;
  vm.maps.set(n, new Map());
  return 1;
});
def('MAP_EXIST', (vm, a) => V.bool(vm.maps.has(S(a[0], 'MAP_EXIST'))));
def('MAP_RELEASE', (vm, a) => {
  vm.maps.delete(S(a[0], 'MAP_RELEASE'));
  return 1;
});
def('MAP_GET', (vm, a) => mapOf(vm, a[0])?.get(S(a[1], 'MAP_GET')) ?? '');
def('MAP_HAS', (vm, a) => {
  const m = mapOf(vm, a[0]);
  return m ? V.bool(m.has(S(a[1], 'MAP_HAS'))) : -1;
});
def('MAP_SET', (vm, a) => {
  const m = mapOf(vm, a[0]);
  if (!m) return -1;
  const k = S(a[1], 'MAP_SET');
  m.set(k, S(a[2], 'MAP_SET'));
  return 1;
});
def('MAP_REMOVE', (vm, a) => {
  const m = mapOf(vm, a[0]);
  if (!m) return -1;
  m.delete(S(a[1], 'MAP_REMOVE'));
  return 1;
});
def('MAP_SIZE', (vm, a) => mapOf(vm, a[0])?.size ?? -1);
def('MAP_CLEAR', (vm, a) => {
  const m = mapOf(vm, a[0]);
  if (!m) return -1;
  m.clear();
  return 1;
});
defRaw('MAP_GETKEYS', (vm, args, fn) => {
  const name = compile(args[0], fn, vm);
  const second = args[1];
  const isRef = second?.k === 'var' && !!resolveSafe(second, fn, vm);
  const outRef = isRef ? refOf(second, fn, vm) : null;
  const flag = args[isRef ? 2 : 1] ? compile(args[isRef ? 2 : 1], fn, vm) : null;
  return (fr) => {
    const m = mapOf(vm, name(fr));
    if (!m) return '';
    const keys = [...m.keys()];
    if (!flag) return keys.join(',');
    // flag forms (original MapGetStrMethod): flag 0 -> '' without touching anything; else fill the array, RESULT = key count
    if (toNum(flag(fr)) === 0) return '';
    let arr: Value[];
    let off = 0;
    if (outRef) {
      const l = outRef.locate(fr);
      arr = l.arr as Value[];
      off = l.off;
    } else arr = vm.global('RESULTS') as Value[];
    for (let i = 0; i < keys.length && off + i < arr.length; i++) arr[off + i] = keys[i];
    vm.global('RESULT')[0] = keys.length;
    return outRef ? '' : String((vm.global('RESULTS') as Value[])[0] ?? '');
  };
});
function resolveSafe(e: Expr & { k: 'var' }, fn: FuncDef, vm: VM) {
  try {
    return resolveRef(e, fn, vm);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ DT_* ----
type Args = ((fr: Frame) => Value)[];
const dtRaw = (name: string, body: (vm: VM, a: Args, fr: Frame, ex: Expr[], fn: FuncDef) => Value) =>
  defRaw(name, (vm, ex, fn) => {
    // an omitted argument (`F(a, , b)`) is an absent entry, as with `OmitStart` argument lists in the original
    const a: Args = ex.map((e) =>
      !e || (e.k === 'var' && e.name === '__EMPTY__') ? (undefined as unknown as Args[number]) : compile(e, fn, vm),
    );
    return (fr) => body(vm, a, fr, ex, fn);
  });
const dtOf = (vm: VM, a: Args, fr: Frame) => vm.dts.get(S(a[0](fr), 'DT'));
const arrRef = (vm: VM, e: Expr, fn: FuncDef, fr: Frame) => {
  const r = refOf(e, fn, vm);
  const { arr, off } = r.locate(fr);
  return { arr, off, last: r.dimsOf(fr)[r.dimsOf(fr).length - 1], isStr: r.meta.isStr };
};

dtRaw('DT_CREATE', (vm, a, fr) => {
  const n = S(a[0](fr));
  if (vm.dts.has(n)) return 0;
  vm.dts.set(n, new DataTable());
  return 1;
});
dtRaw('DT_EXIST', (vm, a, fr) => V.bool(vm.dts.has(S(a[0](fr)))));
dtRaw('DT_RELEASE', (vm, a, fr) => {
  vm.dts.delete(S(a[0](fr)));
  return 1;
});
dtRaw('DT_CLEAR', (vm, a, fr) => {
  const t = dtOf(vm, a, fr);
  if (!t) return -1;
  t.rows.length = 0;
  return 1;
});
dtRaw('DT_NOCASE', (vm, a, fr) => {
  const t = dtOf(vm, a, fr);
  if (!t) return -1;
  t.caseSensitive = a[1] ? toNum(a[1](fr)) === 0 : true;
  return 1;
});
dtRaw('DT_COLUMN_ADD', (vm, a, fr) => {
  const t = dtOf(vm, a, fr);
  if (!t) return -1;
  const type = a[2] ? typeFromArg(a[2](fr)) : undefined;
  if (a[2] && type === undefined) throw new EmueraError('DT_COLUMN_ADD: unsupported type');
  return t.addColumn(S(a[1](fr)), type, a[3] ? toNum(a[3](fr)) !== 0 : true) ? 1 : 0;
});
dtRaw('DT_COLUMN_EXIST', (vm, a, fr) => {
  const t = dtOf(vm, a, fr);
  if (!t) return -1;
  const i = t.colIndex(S(a[1](fr)));
  return i < 0 ? 0 : t.typeNum(i);
});
dtRaw('DT_COLUMN_REMOVE', (vm, a, fr) => {
  const t = dtOf(vm, a, fr);
  if (!t) return -1;
  return t.removeColumn(S(a[1](fr))) ? 1 : 0;
});
dtRaw('DT_COLUMN_LENGTH', (vm, a, fr) => dtOf(vm, a, fr)?.cols.length ?? -1);
// DT_COLUMN_OPTIONS dt, column, default, value [, ...]: SP_DT_COLUMN_OPTIONS_ArgumentBuilder reads the option names as bare words (`DEFAULT`, any case),
// not as expressions, so they must not be evaluated as variables (AnonTW writes `DT_COLUMN_OPTIONS DT_REGION, name, DEFAULT, 1`). Only `default` exists;
// its value must match the column type (DTInvalidDataType otherwise) and integers are clamped to the column's width.
defRaw('DT_COLUMN_OPTIONS', (vm, ex, fn) => {
  const dt = compile(ex[0], fn, vm),
    col = compile(ex[1], fn, vm);
  const opts: { name: string; val: (fr: Frame) => Value }[] = [];
  for (let k = 2; k < ex.length; k += 2) {
    const e = ex[k];
    const name = e && e.k === 'var' && !e.idx?.length ? e.name : e && e.k === 'str' ? e.v : null;
    if (name === null || !ex[k + 1])
      throw new EmueraError('DT_COLUMN_OPTIONS: an option name and its value are expected');
    opts.push({ name: name.toLowerCase(), val: compile(ex[k + 1], fn, vm) });
  }
  return (fr) => {
    const t = vm.dts.get(S(dt(fr), 'DT'));
    if (!t) return -1;
    const cn = S(col(fr)),
      i = t.colIndex(cn);
    if (i < 0) return 0;
    for (const o of opts) {
      if (o.name !== 'default') throw new EmueraError(`DT_COLUMN_OPTIONS: unknown option "${o.name}"`);
      const v = o.val(fr),
        c = t.cols[i];
      if ((c.type === 'str') !== (typeof v === 'string'))
        throw new EmueraError(
          `DT_COLUMN_OPTIONS: the default value does not match the data type of column "${cn}" in table "${S(dt(fr))}"`,
        );
      c.def = typeof v === 'string' ? v : t.clamp(c, v);
    }
    return 1;
  };
});
dtRaw('DT_COLUMN_NAMES', (vm, a, fr, ex, fn) => {
  const t = dtOf(vm, a, fr);
  if (!t) return -1;
  const out = ex[1] ? arrRef(vm, ex[1], fn, fr) : null;
  const arr = out ? out.arr : vm.global('RESULTS');
  const off = out ? out.off : 0;
  t.cols.forEach((c, i) => {
    arr[off + i] = c.name;
  });
  return t.cols.length;
});
dtRaw('DT_ROW_LENGTH', (vm, a, fr) => dtOf(vm, a, fr)?.rows.length ?? -1);

function dtSetCell(t: DataTable, row: (Value | null)[], col: string, v: Value | undefined) {
  // DataTableRowSetMethod.CheckName refuses only the exact name "id". The column lookup then ignores case, so "ID" reaches the id column and sets it
  // (eraFL: DT_ROW_ADD "CC_SP_TOKEN_NUM", "ID", ACTOR_DID, to give a row the same id as its CC_ACTOR row).
  if (col === 'id') throw new EmueraError('DT: the id column cannot be edited');
  const i = t.colIndex(col);
  if (i < 0) throw new EmueraError(`DT: no column '${col}'`);
  const c = t.cols[i];
  if (i === 0) {
    if (v === undefined) throw new EmueraError("DT: column 'id' does not allow nulls");
    if (typeof v === 'string') throw new EmueraError(`DT: type mismatch for column '${col}'`);
    const id = t.clamp(c, v);
    if (t.rows.some((r) => r !== row && Number(r[0]) === Number(id)))
      throw new EmueraError(`DT: column 'id' is constrained to be unique, value '${id}' is already present`);
    row[0] = id;
    t.reserveId(id);
    return;
  }
  if (v === undefined) {
    row[i] = null;
    return;
  }
  if ((c.type === 'str') !== (typeof v === 'string')) throw new EmueraError(`DT: type mismatch for column '${col}'`);
  row[i] = typeof v === 'string' ? v : t.clamp(c, v);
}
function dtFillRow(
  vm: VM,
  t: DataTable,
  row: (Value | null)[],
  a: Args,
  fr: Frame,
  ex: Expr[],
  fn: FuncDef,
  b: number,
): number {
  if (a.length === b + 4) {
    const names = arrRef(vm, ex[b + 1], fn, fr),
      vals = arrRef(vm, ex[b + 2], fn, fr);
    const n = Math.min(toNum(a[b + 3](fr)), names.last - (names.off % names.last), vals.last - (vals.off % vals.last));
    for (let i = 0; i < n; i++) dtSetCell(t, row, String(names.arr[names.off + i]), vals.arr[vals.off + i]);
    return Math.max(0, n);
  }
  let c = 0;
  for (let k = b + 1; k < a.length; k += 2) {
    dtSetCell(t, row, S(a[k](fr)), a[k + 1]?.(fr));
    c++;
  }
  return c;
}
dtRaw('DT_ROW_ADD', (vm, a, fr, ex, fn) => {
  const t = dtOf(vm, a, fr);
  if (!t) return -1;
  const row = t.newRow();
  dtFillRow(vm, t, row, a, fr, ex, fn, 0);
  t.rows.push(row);
  return row[0] as Int;
});
dtRaw('DT_ROW_SET', (vm, a, fr, ex, fn) => {
  const t = dtOf(vm, a, fr);
  if (!t) return -1;
  const i = t.findId(asInt(a[1](fr)));
  if (i < 0) return -2;
  return dtFillRow(vm, t, t.rows[i], a, fr, ex, fn, 1);
});
dtRaw('DT_ROW_REMOVE', (vm, a, fr, ex, fn) => {
  const t = dtOf(vm, a, fr);
  if (!t) return -1;
  const ids: Int[] = [];
  if (a.length === 3) {
    const r = arrRef(vm, ex[1], fn, fr);
    const n = Math.min(toNum(a[2](fr)), r.arr.length - r.off);
    for (let i = 0; i < n; i++) ids.push(r.arr[r.off + i] as Int);
  } else ids.push(asInt(a[1](fr)));
  let removed = 0;
  for (const id of ids) {
    const i = t.findId(id);
    if (i >= 0) {
      t.rows.splice(i, 1);
      removed++;
    }
  }
  return a.length === 3 ? removed : removed ? 1 : 0;
});
function dtCell(name: string, mode: 'int' | 'str' | 'null') {
  dtRaw(name, (vm, a, fr) => {
    const t = dtOf(vm, a, fr);
    const none = mode === 'int' ? 0 : mode === 'str' ? '' : -1;
    if (!t) return none;
    const rowArg = asInt(a[1](fr));
    const ci = t.colIndex(S(a[2](fr)));
    const asId = !!a[3] && toNum(a[3](fr)) !== 0;
    const ri = asId ? t.findId(rowArg) : Number(rowArg);
    const row = t.rows[ri];
    if (!row || ci < 0) return mode === 'null' ? -2 : mode === 'int' ? 0 : '';
    const v = row[ci];
    if (mode === 'null') return V.bool(v === null);
    if (mode === 'str') return v === null ? '' : String(v);
    return v === null || typeof v === 'string' ? 0 : v;
  });
}
dtCell('DT_CELL_GET', 'int');
dtCell('DT_CELL_GETS', 'str');
dtCell('DT_CELL_ISNULL', 'null');
dtRaw('DT_CELL_SET', (vm, a, fr) => {
  const t = dtOf(vm, a, fr);
  if (!t) return -1;
  const name = S(a[2](fr));
  if (name.toLowerCase() === 'id') return 0;
  const hasValue = a.length >= 4 && !!a[3]; // an empty value slot clears the cell (null), as in the original
  const asId = a.length >= 5 && !!a[4] && toNum(a[4](fr)) !== 0;
  const ci = t.colIndex(name);
  const rowArg = asInt(a[1](fr));
  const ri = asId ? t.findId(rowArg) : Number(rowArg);
  const row = t.rows[ri];
  if (!row || ci < 0) return -3;
  if (!hasValue) {
    row[ci] = null;
    return 1;
  }
  const v = a[3](fr);
  const c = t.cols[ci];
  if ((c.type === 'str') !== (typeof v === 'string')) return -2;
  row[ci] = typeof v === 'string' ? v : t.clamp(c, v);
  return 1;
});
dtRaw('DT_SELECT', (vm, a, fr, ex, fn) => {
  const t = dtOf(vm, a, fr);
  if (!t) return -1;
  const filter = a[1] ? S(a[1](fr)) : null,
    sort = a[2] ? S(a[2](fr)) : null;
  const res = t.select(filter, sort);
  if (ex[3]) {
    const o = arrRef(vm, ex[3], fn, fr);
    const n = Math.min(res.length, o.arr.length - o.off);
    for (let i = 0; i < n; i++) o.arr[o.off + i] = res[i][0] as Int;
  } else {
    const rr = vm.global('RESULT');
    const n = Math.min(res.length, rr.length - 1);
    for (let i = 0; i < n; i++) rr[i + 1] = res[i][0] as Int;
    rr[0] = res.length;
  }
  return res.length;
});

def('EXISTCSV', (vm, a) => V.bool(!!vm.templates?.byNo(toNum(a[0]))));

// ------------------------------------------------------- CSV* (templates) ---
for (const [fname, key] of [
  ['CSVBASE', 'maxbase'],
  ['CSVMARK', 'mark'],
  ['CSVEXP', 'exp'],
  ['CSVABL', 'abl'],
  ['CSVTALENT', 'talent'],
  ['CSVRELATION', 'relation'],
  ['CSVCFLAG', 'cflag'],
  ['CSVEQUIP', 'equip'],
  ['CSVJUEL', 'juel'],
] as const) {
  def(
    fname,
    (vm, a) =>
      vm.templates?.byNo(toNum(a[0]))?.[key].get(toNum(a[1])) ??
      (key === 'relation' ? (vm.templates?.relationDef ?? 0) : 0),
  );
}
def('CSVCSTR', (vm, a) => vm.templates?.byNo(toNum(a[0]))?.cstr.get(toNum(a[1])) ?? '');
def('CSVNAME', (vm, a) => vm.templates?.byNo(toNum(a[0]))?.name ?? '');
def('CSVCALLNAME', (vm, a) => vm.templates?.byNo(toNum(a[0]))?.callname ?? '');
def('CSVNICKNAME', (vm, a) => vm.templates?.byNo(toNum(a[0]))?.nickname ?? '');
def('CSVMASTERNAME', (vm, a) => vm.templates?.byNo(toNum(a[0]))?.mastername ?? '');

// ------------------------------------------------------------- ENUM*, GETCHARA
// ENUM{FUNC,VAR,MACRO}{BEGINSWITH,ENDSWITH,WITH}(keyword [, outputArray]): names (compared case-insensitively) are written to RESULTS or the given
// string array; the count returned is capped by the array length. An empty keyword matches nothing. FUNC lists non-event functions, VAR the
// system and user global variables.
const enumCache = new WeakMap<object, { names: string[]; upper: string[]; memo: Map<string, string[]> }>();
const nameLists = new WeakMap<object, string[]>();
const funcNames = (vm: VM) => {
  let l = nameLists.get(vm.prog.funcs);
  if (!l) {
    l = [...vm.prog.funcs.values()].filter((x) => !x[0].event).map((x) => x[0].name);
    nameLists.set(vm.prog.funcs, l);
  }
  return l;
};
const varNames = (vm: VM) => {
  let l = nameLists.get(vm.prog.globals);
  if (!l) {
    l = [...new Set([...builtinVarNames(), ...[...vm.prog.globals.values()].map((d) => d.name)])];
    nameLists.set(vm.prog.globals, l);
  }
  return l;
};
function enumFn(kind: 'func' | 'var' | 'macro', how: 'begin' | 'end' | 'with') {
  return (vm: VM, args: Expr[], fn: FuncDef): Fn => {
    const kw = compile(args[0], fn, vm);
    const out = args[1] ? refOf(args[1], fn, vm) : null;
    return (fr) => {
      const k = S(kw(fr)).toUpperCase();
      const names = kind === 'func' ? funcNames(vm) : kind === 'var' ? varNames(vm) : (vm.prog.macros ?? []);
      const cacheKey = kind === 'func' ? vm.prog.funcs : kind === 'macro' ? (vm.prog.macros ??= []) : vm.prog.globals;
      let c = enumCache.get(cacheKey);
      if (!c || c.names !== names) {
        c = { names, upper: names.map((n) => n.toUpperCase()), memo: new Map() };
        enumCache.set(cacheKey, c);
      }
      const ck = how + ':' + k;
      let hit = c.memo.get(ck);
      if (!hit) {
        hit = [];
        if (k.length > 0)
          for (let i = 0; i < c.upper.length; i++) {
            const u = c.upper[i];
            if (u.length < k.length) continue;
            if (how === 'begin' ? u.startsWith(k) : how === 'end' ? u.endsWith(k) : u.includes(k)) hit.push(c.names[i]);
          }
        c.memo.set(ck, hit);
      }
      let arr: Value[],
        off = 0;
      if (out) {
        const l = out.locate(fr);
        arr = l.arr;
        off = l.off;
      } else arr = vm.global('RESULTS');
      const n = Math.min(arr.length - off, hit.length);
      for (let i = 0; i < n; i++) arr[off + i] = hit[i];
      return n;
    };
  };
}
for (const kind of ['func', 'var', 'macro'] as const)
  for (const how of ['begin', 'end', 'with'] as const)
    defRaw(
      `ENUM${kind.toUpperCase()}${how === 'begin' ? 'BEGINS' : how === 'end' ? 'ENDS' : ''}WITH`,
      enumFn(kind, how),
    );
def('GETCHARA', (vm, a) => {
  const no = toNum(a[0]);
  const noArr = vm.store.meta('NO')!;
  for (let i = 0; i < vm.store.charas.length; i++) if (vm.store.charaArrRead(i, noArr)[0] === no) return i;
  return -1;
});
def('GETSPCHARA', FUNCS.GETCHARA.run);

// debugging aid: EMU_TRACE=n also reports time per builtin function
if (Number((globalThis as any).process?.env?.EMU_TRACE ?? 0)) {
  const acc = new Map<string, number>();
  process.on('exit', () =>
    console.error(
      '[builtinTime]',
      [...acc]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([k, v]) => `${k}=${Math.round(v)}ms`)
        .join(' '),
    ),
  );
  for (const [name, b] of Object.entries(FUNCS)) {
    const run = b.run,
      raw = b.raw;
    b.run = (vm, a, fr) => {
      const t = performance.now();
      try {
        return run(vm, a, fr);
      } finally {
        acc.set(name, (acc.get(name) ?? 0) + performance.now() - t);
      }
    };
    if (raw)
      b.raw = (vm, a, fn) => {
        const f = raw(vm, a, fn);
        return (fr) => {
          const t = performance.now();
          try {
            return f(fr);
          } finally {
            acc.set(name, (acc.get(name) ?? 0) + performance.now() - t);
          }
        };
      };
  }
}

// GROUPMATCH(value, a, b, ...): how many of a, b, ... equal value
def('GROUPMATCH', (_, a) => {
  let n = 0;
  for (let i = 1; i < a.length; i++) if (a[i] === a[0]) n++;
  return n;
});
