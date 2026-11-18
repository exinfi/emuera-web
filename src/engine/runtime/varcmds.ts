/** Statements that read and modify variables: arithmetic (TIMES, POWER), SWAP, VARSIZE, array range/copy/sort/search, bit operations, SPLIT, VARI/VARS. */
import type { Expr } from '../compiler/ast';
import { key } from '../util/key';
import { asInt, asStr, compile, resolveRef, toNum } from './eval';
import { COMMANDS, Factory } from './commands';
import { FUNCS } from './funcs';
import * as V from './value';
import { EmueraError, Int, Value } from './value';
import { compareValues } from './compare';
import { exprs, varExpr } from './cmdargs';
import { runtimeVar } from './varbyname';

COMMANDS.TIMES = (st, fn, vm) => {
  const l = exprs(st);
  const ref = resolveRef(varExpr(l[0], 'TIMES'), fn, vm);
  const k = compile(l[1], fn, vm);
  return (fr) => {
    const x = Number(ref.get(fr) as Int) * Number(k(fr));
    ref.set(fr, Math.trunc(x));
  };
};
// SAVENOS [var] / PRINTCPERLINE [var]: the configured value is stored into the variable (RESULT:0 when none is given) (argument type SP_GETINT in EM+EE, Emuera.NET and
// PuchiEmuera; the same names are also expression functions). eraSumireTeru's title screen asks SAVENOS for the slot count to decide
// whether to offer [1] Load.
const configToVar: Record<string, (vm: import('./vm').VM) => number> = {
  SAVENOS: (vm) => vm.config.saveDataNos,
  PRINTCPERLINE: (vm) => vm.config.printCPerLine,
};
for (const name of Object.keys(configToVar))
  COMMANDS[name] = (st, fn, vm) => {
    const l = exprs(st);
    // no argument: the value goes to RESULT:0 (SP_GETINT_ArgumentBuilder in all three engines); eraSumireTeru's @LINE_RETURN relies on it
    if (!l.length) return () => void (vm.global('RESULT')[0] = configToVar[name](vm));
    const ref = resolveRef(varExpr(l[0], name), fn, vm);
    return (fr) => ref.set(fr, configToVar[name](vm));
  };
COMMANDS.POWER = (st, fn, vm) => {
  const l = exprs(st);
  const ref = resolveRef(varExpr(l[0], 'POWER'), fn, vm);
  const b = compile(l[1], fn, vm),
    e = compile(l[2], fn, vm);
  return (fr) => ref.set(fr, FUNCS.POWER.run(vm, [b(fr), e(fr)], fr));
};
COMMANDS.SWAP = (st, fn, vm) => {
  const l = exprs(st);
  const a = resolveRef(varExpr(l[0], 'SWAP'), fn, vm),
    b = resolveRef(varExpr(l[1], 'SWAP'), fn, vm);
  // locate each side ONCE: the index expressions can have side effects (SWAP X:(RAND:n), X:(m) in Fisher-Yates shuffles); get+set would evaluate RAND several times and duplicate/lose elements
  return (fr) => {
    const x = a.locate(fr),
      y = b.locate(fr);
    const t = x.arr[x.off];
    x.arr[x.off] = y.arr[y.off];
    y.arr[y.off] = t;
  };
};
COMMANDS.VARSIZE = (st, fn, vm) => {
  const l = exprs(st);
  const e = varExpr(l[0], 'VARSIZE');
  const ref = resolveRef(e, fn, vm);
  return (fr) => {
    ref.dimsOf(fr).forEach((d, i) => vm.setResult(d, i));
  };
};

function rowRange(ref: ReturnType<typeof resolveRef>, fr: any, start: number, count: number) {
  const { arr, off } = ref.locate(fr);
  const rd = ref.dimsOf(fr),
    last = rd[rd.length - 1];
  const base = off - (off % last);
  const a = start;
  const n = count < 0 ? last - a : count;
  return { arr, base, a, n: Math.max(0, Math.min(n, last - a)), last };
}
COMMANDS.ARRAYREMOVE = (st, fn, vm) => {
  const l = exprs(st);
  const ref = resolveRef(varExpr(l[0], 'ARRAYREMOVE'), fn, vm);
  const s = compile(l[1], fn, vm),
    c = compile(l[2], fn, vm);
  return (fr) => {
    const st0 = toNum(s(fr)),
      cnt = toNum(c(fr));
    if (st0 < 0) throw new EmueraError(`The 2 argument of "ARRAYREMOVE" instruction (${st0}) is negative`);
    if (st0 >= ref.dimsOf(fr)[ref.dimsOf(fr).length - 1])
      throw new EmueraError(
        `The 2 argument of "ARRAYREMOVE" instruction (${st0}) is out of the range of the "${ref.meta.name}" array`,
      );
    const { arr, base, a, n, last } = rowRange(ref, fr, st0, cnt <= 0 ? -1 : cnt); // a count of 0 or less removes everything from `start` on
    const blank: Value = ref.meta.isStr ? '' : 0;
    for (let i = a; i < last; i++) arr[base + i] = i + n < last ? arr[base + i + n] : blank;
  };
};
COMMANDS.ARRAYSHIFT = (st, fn, vm) => {
  const l = exprs(st);
  const ref = resolveRef(varExpr(l[0], 'ARRAYSHIFT'), fn, vm);
  const sh = compile(l[1], fn, vm),
    def = compile(l[2], fn, vm);
  const s = l[3] ? compile(l[3], fn, vm) : null,
    c = l[4] ? compile(l[4], fn, vm) : null;
  return (fr) => {
    const shift = toNum(sh(fr)),
      d = def(fr);
    const st0 = s ? toNum(s(fr)) : 0,
      cn = c ? toNum(c(fr)) : -1;
    if (shift === 0) return;
    if (st0 < 0) throw new EmueraError(`The 4 argument of "ARRAYSHIFT" instruction (${st0}) is negative`);
    if (c && cn < 0) throw new EmueraError(`The 5 argument of "ARRAYSHIFT" instruction (${cn}) is negative`);
    if (c && cn === 0) return;
    if (st0 >= ref.dimsOf(fr)[ref.dimsOf(fr).length - 1])
      throw new EmueraError(`ARRAYSHIFT: start index ${st0} is out of the range of the "${ref.meta.name}" array`);
    const { arr, base, a, n } = rowRange(ref, fr, st0, cn);
    const src = arr.slice(base + a, base + a + n);
    for (let i = 0; i < n; i++) {
      const from = i - shift;
      arr[base + a + i] = from >= 0 && from < n ? src[from] : d;
    }
  };
};
COMMANDS.SPLIT = (st, fn, vm) => {
  const l = exprs(st);
  const s = compile(l[0], fn, vm),
    sep = compile(l[1], fn, vm);
  const ref = resolveRef(varExpr(l[2], 'SPLIT'), fn, vm);
  return (fr) => {
    const parts = asStr(s(fr)).split(asStr(sep(fr)));
    const { arr, off } = ref.locate(fr);
    parts.forEach((p, i) => {
      if (off + i < arr.length) arr[off + i] = p;
    });
    vm.setResult(parts.length);
  };
};

// ---------------------------------------------------------- bit operations --
const bitCmd =
  (op: (v: Int, bit: Int) => Int): Factory =>
  (st, fn, vm) => {
    const l = exprs(st);
    const ref = resolveRef(varExpr(l[0], st.cmd), fn, vm);
    const bits = l.slice(1).map((e) => compile(e, fn, vm));
    return (fr) => {
      let v = asInt(ref.get(fr));
      for (const b of bits) {
        const n = toNum(b(fr));
        if (n < 0 || n > 63) throw new EmueraError(`${st.cmd}: bit ${n} out of range (0-63)`);
        v = op(v, BigInt(n) as unknown as Int);
      }
      ref.set(fr, v);
    };
  };
const bitMask = (n: Int) => V.shl(1, n);
COMMANDS.SETBIT = bitCmd((v, n) => V.bitOr(v, bitMask(n)));
COMMANDS.CLEARBIT = bitCmd((v, n) => V.bitAnd(v, V.bitNot(bitMask(n))));
COMMANDS.INVERTBIT = bitCmd((v, n) => V.bitXor(v, bitMask(n)));

COMMANDS.ARRAYCOPY = (st, fn, vm) => {
  const l = exprs(st).map((e) => compile(e, fn, vm));
  return (fr) => {
    // names resolve like GETVAR text: globals and the calling function's own #DIM variables
    const find = (n: string, pos: number) => {
      let r;
      try {
        r = runtimeVar(vm, fn, n);
      } catch {
        throw new EmueraError(`The ${pos} argument of the ARRAYCOPY instruction "${n}" is not a variable name`);
      }
      if (r.meta.chara)
        throw new EmueraError(`The ${pos} argument of the ARRAYCOPY instruction "${n}" is a character variable`);
      if (r.meta.calc || r.meta.konst || r.meta.rank < 1)
        throw new EmueraError(`The ${pos} argument of the ARRAYCOPY instruction "${n}" is not an array variable`);
      // a #DIM REF parameter has only a placeholder size: use the dimensions of the array it is bound to
      const bound = fr.refs?.get(key(n.trim()));
      if (bound)
        return {
          m: { ...r.meta, dims: bound.dims.length ? bound.dims : [bound.arr.length - bound.off] },
          arr: bound.arr,
          off: bound.off,
        };
      return { m: r.meta, arr: r.locate(fr).arr, off: 0 };
    };
    const s = find(asStr(l[0](fr)), 1),
      d = find(asStr(l[1](fr)), 2);
    if (s.m.isStr !== d.m.isStr)
      throw new EmueraError('The type of the two array variables of the ARRAYCOPY instruction do not match');
    // CopyArray: each dimension is cut to the smaller of the two sizes (the dimensions are not flattened)
    const sd = s.m.dims,
      dd = d.m.dims;
    if (sd.length !== dd.length)
      throw new EmueraError('ARRAYCOPY: the two variables must have the same number of dimensions');
    const n0 = Math.min(sd[0], dd[0]);
    const so = s.off,
      dof = d.off;
    if (sd.length === 1) {
      for (let i = 0; i < n0; i++) d.arr[dof + i] = s.arr[so + i];
      return;
    }
    const n1 = Math.min(sd[1], dd[1]);
    if (sd.length === 2) {
      for (let i = 0; i < n0; i++) for (let j = 0; j < n1; j++) d.arr[dof + i * dd[1] + j] = s.arr[so + i * sd[1] + j];
      return;
    }
    const n2 = Math.min(sd[2], dd[2]);
    for (let i = 0; i < n0; i++)
      for (let j = 0; j < n1; j++)
        for (let k = 0; k < n2; k++) d.arr[dof + (i * dd[1] + j) * dd[2] + k] = s.arr[so + (i * sd[1] + j) * sd[2] + k];
  };
};
COMMANDS.ARRAYSORT = (st, fn, vm) => {
  const l = exprs(st);
  const ref = resolveRef(varExpr(l[0], 'ARRAYSORT'), fn, vm);
  const back = l[1]?.k === 'var' && l[1].name.toUpperCase() === 'BACK';
  const start = l[2] ? compile(l[2], fn, vm) : null,
    count = l[3] ? compile(l[3], fn, vm) : null;
  return (fr) => {
    const { arr, off } = ref.locate(fr);
    const st0 = start ? toNum(start(fr)) : 0;
    if (st0 < 0) throw new EmueraError(`The 3 argument of "ARRAYSORT" instruction (${st0}) is negative`);
    const cn = count ? toNum(count(fr)) : -1;
    if (count && cn < 0) throw new EmueraError(`The 4 argument of "ARRAYSORT" instruction (${cn}) is negative`);
    if (count && cn === 0) return;
    const sdm = ref.dimsOf(fr),
      last = sdm[sdm.length - 1],
      base = off - (off % last);
    if (st0 >= last)
      throw new EmueraError(`ARRAYSORT: start index ${st0} is out of the range of the "${ref.meta.name}" array`);
    const a = base + st0;
    const n = cn < 0 ? last - st0 : cn;
    if (st0 + n > last)
      throw new EmueraError(`ARRAYSORT: range ${st0}..${st0 + n} is out of the range of the "${ref.meta.name}" array`);
    const part = arr.slice(a, a + n).sort(compareValues);
    if (back) part.reverse();
    part.forEach((v, i) => {
      arr[a + i] = v;
    });
  };
};

// VARI / VARS name: ScopeIn on the private variable, i.e. it starts again from its initial value
for (const n of ['VARI', 'VARS'])
  COMMANDS[n] = (st, fn, vm) => {
    const raw = st.arg.a === 'raw' ? st.arg.text : '';
    const name = key(raw);
    const init = (st.arg as { init?: Expr }).init;
    if (!init)
      return (fr) => {
        (fr as any).priv?.delete(name);
      };
    // VARI name = expr: ScopeIn, then the value of the expression (VARI_Instruction)
    const val = compile(init, fn, vm),
      ref = resolveRef({ k: 'var', name: raw, idx: [] }, fn, vm);
    return (fr) => {
      (fr as any).priv?.delete(name);
      ref.set(fr, val(fr));
    };
  };

// MATCHALL (profile 'emuera-net' only)
// MATCHALL var, value[, begin[, end]] (MATCHALL_Instruction): every index of a 1-D array whose element equals value; RESULT:0 = number of hits, RESULT:1.. = the indices (as many as fit)
COMMANDS.MATCHALL = (st, fn, vm) => {
  const l = st.arg.a === 'exprs' ? st.arg.list : [];
  if (!l.length || l[0].k !== 'var') throw new EmueraError('MATCHALL: the 1st argument must be a variable');
  const ref = resolveRef(l[0] as Expr & { k: 'var' }, fn, vm);
  if (ref.meta.chara) throw new EmueraError('MATCHALL on a character variable is not implemented yet');
  if (ref.meta.rank !== 1) throw new EmueraError('MATCHALL: a non-character variable must be a 1-D array');
  if (!l[1]) throw new EmueraError('MATCHALL: no value to look for');
  const val = compile(l[1], fn, vm),
    beg = l[2] ? compile(l[2], fn, vm) : null,
    end = l[3] ? compile(l[3], fn, vm) : null;
  return (fr) => {
    const { arr } = ref.locate(fr);
    const len = ref.dimsOf(fr)[0];
    const a = beg ? Number(beg(fr)) : 0,
      b = end ? Number(end(fr)) : len;
    if (a < 0 || b < 0) throw new EmueraError('MATCHALL: 検索範囲に負の値が渡されました');
    if (a > b) throw new EmueraError('MATCHALL: 検索範囲の指定が不正です');
    if (Math.max(a, b) > len) throw new EmueraError('MATCHALL: 検索範囲が変数のサイズを超えています');
    const v = val(fr),
      res = vm.global('RESULT');
    let n = 0;
    for (let i = a; i < b; i++)
      if (arr[i] === v) {
        if (n + 1 < res.length) res[n + 1] = i;
        n++;
      }
    res[0] = n;
  };
};
