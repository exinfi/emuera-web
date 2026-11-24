/**
 * Expression evaluator: Expr -> closure. Variable references are resolved when a closure is first
 * built (per function), so evaluation is just array indexing.
 */
import type { Expr, FormPart } from '../compiler/ast';
import type { FuncDef, VarDecl } from '../compiler/types';
import { key } from '../util/key';
import * as V from './value';
import { EmueraError, Int, Value } from './value';
import type { Arr, Meta } from './vars';
import { fill } from './vars';
import type { VM } from './vm';
import { sjisWidth } from './text';

export interface Frame {
  fn: FuncDef;
  vm: VM;
  local: Arr;
  locals: Arr;
  arg: Arr;
  args: Arr;
  priv: Map<string, Arr>;
  pc: number;
  refs?: Map<string, { arr: Arr; off: number; dims: number[] }>;
  returned?: boolean;
  /** loop bookkeeping keyed by loop-head pc */
  loops: Map<number, { end: Int; step: Int }>;
  /** RETURNF value for #FUNCTION calls */
  retval?: Value;
  done?: boolean;
}

export type Fn = (fr: Frame) => Value;

/** An array passed by reference as a call argument; `v` is the scalar reading of the same expression. */
export interface ArrArg {
  arrArg: true;
  arr: Arr;
  off: number;
  dims: number[];
  v: Value;
}
export const isArrArg = (v: unknown): v is ArrArg =>
  typeof v === 'object' && v !== null && (v as ArrArg).arrArg === true;

/** Compile a call argument; bare array names also yield a by-reference handle for REF parameters. */
export function compileArg(e: Expr, fn: FuncDef, vm: VM, scalarRef = false): Fn {
  if (e.k === 'var' && e.name === '__EMPTY__') return () => undefined as unknown as Value;
  const plain = compile(e, fn, vm);
  if (e.k !== 'var') return plain;
  let ref: Ref | null | undefined;
  return (fr) => {
    if (ref === undefined) {
      try {
        const r = resolveRef(e, fn, vm);
        ref = (r.meta.rank > e.idx.length || (scalarRef && r.meta.rank === e.idx.length)) && !r.meta.calc ? r : null;
      } catch {
        ref = null;
      }
    }
    if (!ref) return plain(fr);
    const { arr, off: o0 } = ref.locate(fr);
    // Emuera binds a REF parameter to the whole array of the variable named (RefArgument / GetArray): subscripts of a fully subscripted argument are ignored
    const full = ref.meta.rank === e.idx.length;
    const off = full ? 0 : o0;
    // a REF parameter handed on to another function keeps the dimensions it was bound with (its declared size is only a placeholder)
    const bound = fr.refs?.get(key(e.name));
    const dims = full ? (bound ? bound.dims : ref.meta.dims) : (bound ? bound.dims : ref.meta.dims).slice(e.idx.length);
    return { arrArg: true, arr, off, dims, v: arr[o0] } as unknown as Value;
  };
}
export type IntFn = (fr: Frame) => Int;

export interface Ref {
  meta: Meta;
  get: Fn;
  set: (fr: Frame, v: Value) => void;
  /** underlying array + offset (for functions that take array arguments) */
  locate: (fr: Frame) => { arr: Arr; off: number; len: number };
  /** dimensions in effect for this frame: a #DIM REF parameter has only a placeholder size in its declaration, the real one is that of the array it is bound to */
  dimsOf: (fr: Frame) => number[];
}

const LOCAL_SIZES: Record<string, number> = { LOCAL: 1000, LOCALS: 100, ARG: 1000, ARGS: 100 };
/** length of LOCAL/LOCALS/ARG/ARGS in a function: #LOCALSIZE / #LOCALSSIZE raise LOCAL / LOCALS (ARG never shrinks); must equal LazyFrame.sz */
const frameSize = (n: string, fn: FuncDef): number => {
  const v = n === 'LOCAL' ? fn.localSize : n === 'LOCALS' ? fn.localsSize : 0;
  return v > 0 ? Math.max(v, n.startsWith('ARG') ? LOCAL_SIZES[n] : 0) : LOCAL_SIZES[n];
};

const cache = new WeakMap<object, Fn>();
const refCache = new WeakMap<object, Ref>();

export function asInt(v: Value, what = 'value'): Int {
  if (typeof v === 'string') throw new EmueraError(`${what}: integer expected, got string "${v}"`);
  return v === undefined ? 0 : v; // an omitted argument reads as 0 where the function has no other default
}
export function asStr(v: Value, what = 'value'): string {
  if (typeof v !== 'string') throw new EmueraError(`${what}: string expected, got integer ${v}`);
  return v;
}
export const toNum = (v: Value): number => Number(asInt(v));

function frameArr(fr: Frame, name: string): Arr {
  switch (name) {
    case 'LOCAL':
      return fr.local;
    case 'LOCALS':
      return fr.locals;
    case 'ARG':
      return fr.arg;
    default:
      return fr.args;
  }
}

/** Frame whose LOCAL/LOCALS/ARG/ARGS arrays are allocated on first use (most calls never touch them). */
export class LazyFrame implements Frame {
  pc = 0;
  private _priv?: Map<string, Arr>;
  private _loops?: Map<number, { end: Int; step: Int }>;
  refs?: Map<string, { arr: Arr; off: number; dims: number[] }>;
  returned?: boolean;
  retval?: Value;
  done?: boolean;
  private _local?: Arr;
  private _locals?: Arr;
  private _arg?: Arr;
  private _args?: Arr;
  constructor(
    public fn: FuncDef,
    public vm: VM,
  ) {}
  get priv(): Map<string, Arr> {
    return (this._priv ??= new Map());
  }
  get loops(): Map<number, { end: Int; step: Int }> {
    return (this._loops ??= new Map());
  }
  private sz(n: string, v: number) {
    return v > 0 ? Math.max(v, n.startsWith('ARG') ? LOCAL_SIZES[n] : 0) : LOCAL_SIZES[n];
  }
  private take(n: number, str: boolean): Arr {
    const pool = str ? strPool : numPool;
    const a = pool.get(n)?.pop();
    return a ?? fill(n, str);
  }
  /**
   * LOCAL / LOCALS belong to the function, not to the call (VariableLocal: one token per function name, cleared only when the game state is reset, VariableData.SetDefaultLocalValue):
   * a value left by one call is still there at the next call, and a recursive call shares it. ShinEraTenseiP counts tiles that way (MAKE_FLOOR_LINE_COMMON_34 clears LOCAL itself at (0,0)).
   */
  private persisted(str: boolean, n: number): Arr {
    const m = ((this.vm as unknown as { localStore?: Map<string, Arr> }).localStore ??= new Map<string, Arr>());
    const k = (str ? 'S:' : 'N:') + this.fn.name.toUpperCase();
    let a = m.get(k);
    if (!a || a.length < n) {
      const b = fill(n, str);
      if (a) for (let i = 0; i < a.length; i++) b[i] = a[i];
      m.set(k, (a = b));
    }
    return a;
  }
  get local(): Arr {
    return (this._local ??= this.persisted(false, this.sz('LOCAL', this.fn.localSize)));
  }
  get locals(): Arr {
    return (this._locals ??= this.persisted(true, this.sz('LOCALS', this.fn.localsSize)));
  }
  get arg(): Arr {
    return (this._arg ??= this.take(LOCAL_SIZES.ARG, false));
  }
  get args(): Arr {
    return (this._args ??= this.take(LOCAL_SIZES.ARGS, true));
  }
  /**
   * Optimization 'frame-dirty' (opts.ts): highest index written + 1 in each scratch array. Every write path to a frame
   * array records it (resolveRef's frame-kind set, bindArgs, and any locate() handed to array builtins counts as "all"),
   * so release() only has to clear what was touched instead of all 1000 elements of ARG/LOCAL on every call.
   */
  hiL = 0;
  hiLS = 0;
  hiA = 0;
  hiAS = 0;
  /** give the scratch arrays back (cleared) for reuse by later calls */
  release() {
    const opt = this.vm.optimize;
    const give = (a: Arr | undefined, str: boolean, hi: number) => {
      if (!a) return;
      if (!opt || hi >= a.length) a.fill(str ? '' : 0);
      else if (hi > 0) {
        const z = str ? '' : 0;
        for (let i = 0; i < hi; i++) a[i] = z;
      }
      const pool = str ? strPool : numPool;
      let l = pool.get(a.length);
      if (!l) pool.set(a.length, (l = []));
      if (l.length < 64) l.push(a);
    };
    give(this._arg, false, this.hiA);
    give(this._args, true, this.hiAS); // LOCAL / LOCALS stay with the function
    this._local = this._locals = this._arg = this._args = undefined;
    this.hiL = this.hiLS = this.hiA = this.hiAS = 0;
  }
}
const numPool = new Map<number, Arr[]>(),
  strPool = new Map<number, Arr[]>();
/** record that a frame array was written up to index n-1 (see LazyFrame.hiL) */
function frameMark(up: string): (fr: Frame, n: number) => void {
  switch (up) {
    case 'LOCAL':
      return (fr, n) => {
        const f = fr as LazyFrame;
        if (n > f.hiL) f.hiL = n;
      };
    case 'LOCALS':
      return (fr, n) => {
        const f = fr as LazyFrame;
        if (n > f.hiLS) f.hiLS = n;
      };
    case 'ARG':
      return (fr, n) => {
        const f = fr as LazyFrame;
        if (n > f.hiA) f.hiA = n;
      };
    default:
      return (fr, n) => {
        const f = fr as LazyFrame;
        if (n > f.hiAS) f.hiAS = n;
      };
  }
}

export function resolveRef(e: Expr & { k: 'var' }, fn: FuncDef, vm: VM): Ref {
  const hit = refCache.get(e);
  if (hit) return hit;
  const up = key(e.name);
  const st = vm.store;
  // a string-valued subscript is a name: look it up in the variable's name table (e.g. ITEM:REWARD_NAME)
  const nameIdx =
    (f: Fn, pos: number): Fn =>
    (fr) => {
      const v = f(fr);
      if (typeof v !== 'string') return v;
      const t = vm.tables;
      const n =
        t.userTable(e.name, pos)?.byName.get(v) ??
        t.userTable(e.name, pos - 1)?.byName.get(v) ??
        t.nameToIndex(e.name, v);
      if (n === undefined) throw new EmueraError(`${e.name}: unknown name "${v}"`);
      return n;
    };
  const idxFns = e.idx.map((x, i) => (x.k === 'int' ? compile(x, fn, vm) : nameIdx(compile(x, fn, vm), i)));
  let meta: Meta | undefined;
  let kind: 'frame' | 'priv' | 'static' | 'global' | 'chara' | 'calc' | 'ref' = 'global';
  let skey = '';

  if (up in LOCAL_SIZES) {
    kind = 'frame';
    meta = {
      name: up,
      isStr: up.endsWith('S'),
      rank: 1,
      chara: false,
      dims: [frameSize(up, fn)],
      calc: false,
      konst: false,
      save: false,
    };
  } else {
    const d = fn.vars.get(up);
    if (d) {
      meta = {
        name: d.name,
        isStr: d.isStr,
        rank: d.dims.length,
        chara: false,
        dims: d.dims,
        calc: false,
        konst: d.isConst,
        save: false,
        user: d,
      };
      skey = `${key(fn.name)}@${up}`;
      kind = d.isRef ? 'ref' : d.isStatic || d.isConst ? 'static' : 'priv';
    } else {
      meta = st.meta(up);
      if (!meta) throw new EmueraError(`unknown variable '${e.name}'`);
      kind = meta.calc ? 'calc' : meta.chara ? 'chara' : 'global';
    }
  }
  const m = meta;
  const n = idxFns.length;
  /** non-constant #DIM initializers (see VarDecl.initExprs): compiled once, evaluated where the array is created */
  const runInitExprs = (u: VarDecl | undefined, a: Arr, fr: Frame) => {
    if (!u?.initExprs) return;
    const fns = u.initFns ?? (u.initFns = u.initExprs.map((x) => compile(x, fn, vm)));
    fns.forEach((f, i) => {
      if (i < a.length) a[i] = f(fr) as Value;
    });
  };
  const arrOf = (fr: Frame): Arr => {
    switch (kind) {
      case 'frame':
        return frameArr(fr, up);
      case 'priv': {
        let a = fr.priv.get(up);
        if (!a) {
          a = fill(st.size(m), m.isStr);
          // PrivateInt1D/Str1DVariableToken.ScopeIn: the declared defaults are copied into the fresh array on every call (2D/3D private arrays take none)
          if (m.rank === 1)
            m.user?.init?.forEach((v, i) => {
              if (i < a!.length) a![i] = v as Value;
            });
          if (m.rank === 1) runInitExprs(m.user, a, fr);
          fr.priv.set(up, a);
        }
        return a;
      }
      case 'static': {
        let a = st.statics.get(skey);
        if (!a) {
          a = fill(st.size(m), m.isStr);
          m.user?.init?.forEach((v, i) => {
            if (i < a!.length) a![i] = v as Value;
          });
          runInitExprs(m.user, a, fr);
          st.statics.set(skey, a);
        }
        return a;
      }
      default:
        return st.globalArr(m);
    }
  };

  const evalIdx = (fr: Frame, from: number): number[] => {
    const out: number[] = [];
    for (let i = from; i < n; i++) out.push(toNum(idxFns[i](fr)));
    return out;
  };

  let locate: Ref['locate'];
  if (kind === 'ref') {
    locate = (fr) => {
      const r = fr.refs?.get(up);
      if (!r) throw new EmueraError(`${m.name}: reference parameter was not bound to an array`);
      let off = r.off;
      const dims = r.dims.length ? r.dims : [r.arr.length - r.off];
      let mul = dims.reduce((a, b) => a * b, 1);
      for (let d = 0; d < dims.length; d++) {
        const i = d < n ? toNum(idxFns[d](fr)) : 0;
        if (i < 0 || i >= dims[d]) throw new EmueraError(`${m.name}: index ${i} is out of range (0..${dims[d] - 1})`);
        mul /= dims[d];
        off += i * mul;
      }
      return { arr: r.arr, off, len: r.arr.length };
    };
  } else if (kind === 'chara') {
    locate = (fr) => {
      let ci: number;
      let rest: number[];
      if (n === m.rank + 1) {
        ci = toNum(idxFns[0](fr));
        rest = evalIdx(fr, 1);
      } else if (n === m.rank || (m.rank === 0 && n === 0)) {
        ci = vm.targetIndex();
        rest = evalIdx(fr, 0);
      } else if (n < m.rank) {
        ci = vm.targetIndex();
        rest = evalIdx(fr, 0);
      } else throw new EmueraError(`${m.name}: too many subscripts`);
      const arr = st.charaArr(ci, m);
      const off = st.offset(m, rest);
      return { arr, off, len: arr.length };
    };
  } else if (kind === 'calc') {
    locate = () => {
      throw new EmueraError(`${m.name} cannot be addressed as an array`);
    };
  } else {
    locate = (fr) => {
      const arr = arrOf(fr);
      const off = st.offset(m, evalIdx(fr, 0));
      return { arr, off, len: arr.length };
    };
  }

  let get: Fn;
  let set: Ref['set'];
  if (kind === 'calc') {
    const getter = vm.calcGetter(up);
    get = (fr) => getter(n ? idxFns.map((f) => f(fr)) : []);
    set = (fr, v) => vm.calcSetter(up, n ? idxFns.map((f) => f(fr)) : [], v);
  } else if (kind === 'chara') {
    // fast shapes (optimization 'chara-read-zero'): 1 = V:chara:i, 2 = V:i (target omitted), 3 = V:chara (scalar), 4 = V (scalar, target).
    // They evaluate the character first, then the index, then range-check in the same order as the general path, without the index array.
    const fk = m.rank === 1 ? (n === 2 ? 1 : n === 1 ? 2 : 0) : m.rank === 0 ? (n === 1 ? 3 : n === 0 ? 4 : 0) : 0;
    get = (fr) => {
      if (!st.readZero) {
        const { arr, off } = locate(fr);
        return arr[off];
      }
      let ci: number,
        i = 0;
      switch (fk) {
        case 1:
          ci = toNum(idxFns[0](fr));
          i = toNum(idxFns[1](fr));
          break;
        case 2:
          ci = vm.targetIndex();
          i = toNum(idxFns[0](fr));
          break;
        case 3:
          ci = toNum(idxFns[0](fr));
          break;
        case 4:
          ci = vm.targetIndex();
          break;
        default: {
          let rest: number[];
          if (n === m.rank + 1) {
            ci = toNum(idxFns[0](fr));
            rest = evalIdx(fr, 1);
          } else if (n === m.rank || (m.rank === 0 && n === 0)) {
            ci = vm.targetIndex();
            rest = evalIdx(fr, 0);
          } else if (n < m.rank) {
            ci = vm.targetIndex();
            rest = evalIdx(fr, 0);
          } else throw new EmueraError(`${m.name}: too many subscripts`);
          const arr = st.charaArrRead(ci, m);
          return arr[st.offset(m, rest)];
        }
      }
      const arr = st.charaArrRead(ci, m);
      if (i < 0 || i >= m.dims[0]) throw new EmueraError(`${m.name}: index ${i} is out of range (0..${m.dims[0] - 1})`);
      return arr[i];
    };
    set = (fr, v) => {
      checkType(m, v);
      if (st.readZero && fk !== 0) {
        let ci: number,
          i = 0;
        switch (fk) {
          case 1:
            ci = toNum(idxFns[0](fr));
            i = toNum(idxFns[1](fr));
            break;
          case 2:
            ci = vm.targetIndex();
            i = toNum(idxFns[0](fr));
            break;
          case 3:
            ci = toNum(idxFns[0](fr));
            break;
          default:
            ci = vm.targetIndex();
            break;
        }
        const arr = st.charaArr(ci, m);
        if (i < 0 || i >= m.dims[0])
          throw new EmueraError(`${m.name}: index ${i} is out of range (0..${m.dims[0] - 1})`);
        arr[i] = v;
        return;
      }
      const { arr, off } = locate(fr);
      arr[off] = v;
    };
  } else if (kind === 'frame') {
    // LOCAL / LOCALS / ARG / ARGS: like the general paths below, plus the dirty-extent bookkeeping for LazyFrame.release()
    const mk = frameMark(up);
    if (n === 0 && m.dims.length === 1 && m.dims[0] >= 1) {
      // bare LOCAL / ARG: element 0, without the index array and result object of the general path
      get = (fr) => arrOf(fr)[0];
      set = (fr, v) => {
        checkType(m, v);
        mk(fr, 1);
        arrOf(fr)[0] = v;
      };
    } else if (n === 1 && m.dims.length === 1) {
      const i0 = idxFns[0];
      const len = m.dims[0];
      get = (fr) => {
        const i = toNum(i0(fr));
        if (i < 0 || i >= len) throw new EmueraError(`${m.name}: index ${i} is out of range (0..${len - 1})`);
        return arrOf(fr)[i];
      };
      set = (fr, v) => {
        checkType(m, v);
        const i = toNum(i0(fr));
        if (i < 0 || i >= len) throw new EmueraError(`${m.name}: index ${i} is out of range (0..${len - 1})`);
        mk(fr, i + 1);
        arrOf(fr)[i] = v;
      };
    } else {
      get = (fr) => {
        const { arr, off } = locate(fr);
        return arr[off];
      };
      set = (fr, v) => {
        checkType(m, v);
        const { arr, off } = locate(fr);
        mk(fr, off + 1);
        arr[off] = v;
      };
    }
  } else if (kind !== 'ref' && n === 0 && m.dims.length === 1 && m.dims[0] >= 1) {
    // bare scalar name (#DIM X, TARGET, RESULT ...): element 0, same checks as the general path, no index array / result object
    get = (fr) => arrOf(fr)[0];
    set = (fr, v) => {
      checkType(m, v);
      if (m.konst) throw new EmueraError(`${m.name} is constant`);
      arrOf(fr)[0] = v;
    };
  } else if (kind !== 'ref' && n === 1 && m.dims.length === 1) {
    // hot path: one subscript into a 1-D array
    const i0 = idxFns[0];
    const len = m.dims[0];
    get = (fr) => {
      const i = toNum(i0(fr));
      if (i < 0 || i >= len) throw new EmueraError(`${m.name}: index ${i} is out of range (0..${len - 1})`);
      return arrOf(fr)[i];
    };
    set = (fr, v) => {
      checkType(m, v);
      const i = toNum(i0(fr));
      if (i < 0 || i >= len) throw new EmueraError(`${m.name}: index ${i} is out of range (0..${len - 1})`);
      if (m.konst) throw new EmueraError(`${m.name} is constant`); // (this branch is never a frame array)
      arrOf(fr)[i] = v;
    };
  } else {
    get = (fr) => {
      const { arr, off } = locate(fr);
      return arr[off];
    };
    set = (fr, v) => {
      checkType(m, v);
      if (m.konst) throw new EmueraError(`${m.name} is constant`);
      const { arr, off } = locate(fr);
      arr[off] = v;
    };
  }
  const dimsOf: Ref['dimsOf'] =
    kind === 'ref'
      ? (fr) => {
          const r = fr.refs?.get(up);
          return r ? (r.dims.length ? r.dims : [r.arr.length - r.off]) : m.dims;
        }
      : () => m.dims;
  // VariableParser.ReduceVariable: subscript-count rules. Reading or writing a variable with the wrong number of subscripts is an
  // error in the original (VariableNoArgTerm -> MissingVarArg; CanNotOmit*VarArg; TooMany*VarArg). Reference uses (locate/dimsOf)
  // such as ARRAYCOPY or VARSET keep accepting a bare array name.
  const bad = kind === 'ref' || kind === 'calc' || m.user?.isChara ? null : subscriptError(m, kind === 'chara', n);
  if (bad) {
    const fail = () => {
      throw new EmueraError(bad);
    };
    get = fail as unknown as Fn;
    set = fail;
  }
  // a frame array handed to a builtin / REF parameter may be written anywhere: count it as fully dirty
  const mkAll = kind === 'frame' ? frameMark(up) : null;
  const ref: Ref = {
    meta: m,
    get,
    set,
    locate: mkAll
      ? (fr) => {
          mkAll(fr, 1e9);
          return locate(fr);
        }
      : locate,
    dimsOf,
  };
  refCache.set(e, ref);
  return ref;
}

function subscriptError(m: Meta, chara: boolean, n: number): string | null {
  const nm = m.name;
  const rank = m.dims.length;
  if (chara) {
    const r = m.rank;
    if (r >= 2)
      return n === 3 || (r > 2 && n === r + 1)
        ? null
        : n === 0
          ? `The variable "${nm}" requires arguments`
          : n > r + 1
            ? `Too many arguments for the 2D character variable ${nm}`
            : `The arguments of the 2D character variable ${nm} cannot be omitted`;
    if (r === 1) return n <= 2 ? null : `Too many arguments for the 1D character variable ${nm}`;
    return n <= 1 ? null : `Too many arguments for the character variable ${nm}`;
  }
  if (rank <= 1) return n <= 1 ? null : `Too many arguments for the 1D variable ${nm}`;
  if (n === 0) return `The variable "${nm}" requires arguments`;
  if (n < rank) return `The arguments of the ${rank}D variable ${nm} cannot be omitted`;
  if (n > rank) return `Too many arguments for the ${rank}D variable ${nm}`;
  return null;
}

function checkType(m: Meta, v: Value) {
  if (m.isStr !== (typeof v === 'string'))
    throw new EmueraError(
      `${m.name}: cannot assign ${typeof v === 'string' ? 'string' : 'integer'} to ${m.isStr ? 'string' : 'integer'} variable`,
    );
}

export function padTo(s: string, width: number, align: 'left' | 'right' | 'center' | null): string {
  const w = sjisWidth(s);
  if (width <= w) return s;
  const pad = width - w;
  if (align === 'left') return s + ' '.repeat(pad);
  if (align === 'center') {
    const l = Math.floor(pad / 2);
    return ' '.repeat(l) + s + ' '.repeat(pad - l);
  }
  return ' '.repeat(pad) + s;
}

export function compileForm(parts: FormPart[], fn: FuncDef, vm: VM): (fr: Frame) => string {
  const cs = parts.map((p): ((fr: Frame) => string) => {
    if (p.t === 'lit') {
      const s = p.s;
      return () => s;
    }
    if (p.t === 'yenat') {
      const c = compile(p.cond, fn, vm);
      const a = compileForm(p.a, fn, vm);
      const b = p.b ? compileForm(p.b, fn, vm) : () => '';
      return (fr) => (V.isZero(asInt(c(fr))) ? b(fr) : a(fr));
    }
    const e = compile(p.e, fn, vm);
    const w = p.width ? compile(p.width, fn, vm) : null;
    const al = p.align ?? null;
    const isInt = p.t === 'int';
    return (fr) => {
      const v = e(fr);
      const s = isInt ? String(asInt(v, '{}')) : asStr(v, '%%');
      return w ? padTo(s, toNum(w(fr)), al ?? 'right') : s;
    };
  });
  if (cs.length === 1) return cs[0];
  return (fr) => {
    let o = '';
    for (const c of cs) o += c(fr);
    return o;
  };
}

export function compile(e: Expr, fn: FuncDef, vm: VM): Fn {
  const hit = cache.get(e);
  if (hit) return hit;
  const f = build(e, fn, vm);
  cache.set(e, f);
  return f;
}

function build(e: Expr, fn: FuncDef, vm: VM): Fn {
  switch (e.k) {
    case 'int': {
      const v = e.v as Int;
      return () => v;
    }
    case 'real': {
      const v = e.v;
      return () => v;
    }
    case 'str': {
      const v = e.v;
      return () => v;
    }
    case 'form': {
      const f = compileForm(e.parts, fn, vm);
      return f;
    }
    case 'var': {
      if (e.name === '__EMPTY__') return () => 0;
      return resolveRef(e, fn, vm).get;
    }
    case 'call':
      return vm.compileCall(e, fn);
    case 'un': {
      const x = compile(e.e, fn, vm);
      switch (e.op) {
        case '-':
          return (fr) => V.neg(asInt(x(fr)));
        case '+':
          return (fr) => asInt(x(fr));
        case '!':
          return (fr) => (V.isZero(asInt(x(fr))) ? 1 : 0);
        default:
          return (fr) => V.bitNot(asInt(x(fr)));
      }
    }
    case 'tern': {
      const c = compile(e.c, fn, vm),
        a = compile(e.a, fn, vm),
        b = compile(e.b, fn, vm);
      return (fr) => (V.isZero(asInt(c(fr))) ? b(fr) : a(fr));
    }
    case 'incdec': {
      if (e.target.k !== 'var') throw new EmueraError('++/-- needs a variable');
      const r = resolveRef(e.target, fn, vm);
      const d = e.op === '++' ? 1 : -1;
      return e.prefix
        ? (fr) => {
            const nv = V.add(asInt(r.get(fr)), d);
            r.set(fr, nv);
            return nv;
          }
        : (fr) => {
            const ov = asInt(r.get(fr));
            r.set(fr, V.add(ov, d));
            return ov;
          };
    }
    case 'bin':
      return buildBin(e, fn, vm);
  }
}

function buildBin(e: Expr & { k: 'bin' }, fn: FuncDef, vm: VM): Fn {
  const l = compile(e.l, fn, vm),
    r = compile(e.r, fn, vm);
  const op = e.op;
  if (op === '&&') return (fr) => (V.isZero(asInt(l(fr))) ? 0 : V.isZero(asInt(r(fr))) ? 0 : 1);
  if (op === '||') return (fr) => (!V.isZero(asInt(l(fr))) ? 1 : V.isZero(asInt(r(fr))) ? 0 : 1);
  const cmpOp = (c: number): boolean => {
    switch (op) {
      case '==':
        return c === 0;
      case '!=':
        return c !== 0;
      case '<':
        return c < 0;
      case '>':
        return c > 0;
      case '<=':
        return c <= 0;
      default:
        return c >= 0;
    }
  };
  switch (op) {
    case '+':
      return (fr) => {
        const a = l(fr),
          b = r(fr);
        if (typeof a === 'string') {
          if (typeof b !== 'string') throw new EmueraError('cannot add integer to string');
          return a + b;
        }
        return V.add(a, asInt(b));
      };
    case '-':
      return (fr) => V.sub(asInt(l(fr)), asInt(r(fr)));
    case '*':
      return (fr) => {
        const a = l(fr),
          b = r(fr);
        if (typeof a === 'string' || typeof b === 'string') {
          // MultStrInt (both Emuera sources): a negative count or 10000 or more is an error
          const str = (typeof a === 'string' ? a : b) as string,
            n = toNum(typeof a === 'string' ? b : a);
          if (n < 0) throw new EmueraError(`文字列に負の値(${n})を乗算しようとしました`);
          if (n >= 10000) throw new EmueraError(`文字列に10000以上の値(${n})を乗算しようとしました`);
          return str.repeat(n);
        }
        return V.mul(a, asInt(b));
      };
    case '/':
      return (fr) => V.div(asInt(l(fr)), asInt(r(fr)));
    case '%':
      return (fr) => V.mod(asInt(l(fr)), asInt(r(fr)));
    case '&':
      return (fr) => V.bitAnd(asInt(l(fr)), asInt(r(fr)));
    case '|':
      return (fr) => V.bitOr(asInt(l(fr)), asInt(r(fr)));
    case '^':
      return (fr) => V.bitXor(asInt(l(fr)), asInt(r(fr)));
    case '<<':
      return (fr) => V.shl(asInt(l(fr)), asInt(r(fr)));
    case '>>':
      return (fr) => V.shr(asInt(l(fr)), asInt(r(fr)));
    case '^^':
      return (fr) => (V.isZero(asInt(l(fr))) !== V.isZero(asInt(r(fr))) ? 1 : 0);
    case '!&':
      return (fr) => (V.isZero(asInt(l(fr))) || V.isZero(asInt(r(fr))) ? 1 : 0);
    case '!|':
      return (fr) => (V.isZero(asInt(l(fr))) && V.isZero(asInt(r(fr))) ? 1 : 0);
    default: {
      const slow = (a: Value, b: Value): number => {
        if (typeof a === 'string' || typeof b === 'string') {
          if (typeof a !== typeof b) throw new EmueraError(`cannot compare string with integer (${op})`);
          return cmpOp(a < b ? -1 : a > b ? 1 : 0) ? 1 : 0;
        }
        return cmpOp(V.cmp(a, b)) ? 1 : 0;
      };
      // two plain numbers (the common case) are compared directly: same result as V.cmp, without the operator switch
      switch (op) {
        case '==':
          return (fr) => {
            const a = l(fr),
              b = r(fr);
            return typeof a === 'number' && typeof b === 'number' ? (a === b ? 1 : 0) : slow(a, b);
          };
        case '!=':
          return (fr) => {
            const a = l(fr),
              b = r(fr);
            return typeof a === 'number' && typeof b === 'number' ? (a !== b ? 1 : 0) : slow(a, b);
          };
        case '<':
          return (fr) => {
            const a = l(fr),
              b = r(fr);
            return typeof a === 'number' && typeof b === 'number' ? (a < b ? 1 : 0) : slow(a, b);
          };
        case '>':
          return (fr) => {
            const a = l(fr),
              b = r(fr);
            return typeof a === 'number' && typeof b === 'number' ? (a > b ? 1 : 0) : slow(a, b);
          };
        case '<=':
          return (fr) => {
            const a = l(fr),
              b = r(fr);
            return typeof a === 'number' && typeof b === 'number' ? (a <= b ? 1 : 0) : slow(a, b);
          };
        default:
          return (fr) => {
            const a = l(fr),
              b = r(fr);
            return typeof a === 'number' && typeof b === 'number' ? (a >= b ? 1 : 0) : slow(a, b);
          };
      }
    }
  }
}
