/** Variable access by name at run time: GETVAR / GETVARS / SETVAR, and the helpers other modules use to resolve `"NAME:i:j"`. */
import type { Expr } from '../compiler/ast';
import { key } from '../util/key';
import { ExprParser } from '../compiler/expr';
import { Cursor } from '../compiler/cursor';
import { makeResolver } from '../compiler/resolve';
import { compile, resolveRef } from './eval';
import { defRaw, S } from './funcs';
import { EmueraError } from './value';
import type { VM } from './vm';

// ---- variables by name:  "NAME:i:j"
export function byName(vm: VM, spec: string) {
  const parts = spec.split(':');
  const name = key(parts[0].trim());
  const meta = vm.store.meta(name);
  if (!meta || meta.calc) throw new EmueraError(`GETVAR: unknown variable ${parts[0]}`);
  const idx = parts.slice(1).map((p, d) => {
    const t = p.trim();
    if (/^[+-]?\d+$/.test(t)) return Number(t);
    const n = vm.tables.userTable(name, d)?.byName.get(t) ?? vm.tables.nameToIndex(name, t);
    if (n === undefined) throw new EmueraError(`GETVAR: bad index '${t}' for ${name}`);
    return n;
  });
  let arr;
  if (meta.chara) {
    const ci = idx.length === meta.rank + 1 ? idx.shift()! : vm.targetIndex();
    arr = vm.store.charaArr(ci, meta);
  } else arr = vm.store.globalArr(meta);
  return { arr, off: vm.store.offset(meta, idx), meta };
}
// GETVAR / GETVARS / SETVAR: the text is a full expression parsed at run time in the caller's scope (GetVarMethod: LexicalAnalyzer + ReduceExpressionTerm),
// so subscripts may be numbers, CSV names, or any variable of the calling function (`CSTR:ARG:固有素質3`)
const rtCaches = new WeakMap<object, Map<string, import('./eval').Ref>>(); // per VM: a cached Ref points into that VM's storage
const rtResolvers = new WeakMap<object, ReturnType<typeof makeResolver>>();
export function runtimeVar(vm: VM, fn: import('../compiler/types').FuncDef, text: string) {
  const k = `${fn.name}\u0000${text}`;
  let rtVars = rtCaches.get(vm);
  if (!rtVars) rtCaches.set(vm, (rtVars = new Map()));
  let r = rtVars.get(k);
  if (!r) {
    let e: Expr;
    try {
      e = new ExprParser(new Cursor(text)).expr();
    } catch {
      throw new EmueraError(`${text} is not variable`);
    }
    if (e.k !== 'var') throw new EmueraError(`${text} is not variable`);
    let rtResolver = rtResolvers.get(vm);
    if (!rtResolver) rtResolvers.set(vm, (rtResolver = makeResolver(vm.prog, vm.tables)));
    e = rtResolver.expr(e, fn);
    try {
      r = resolveRef(e as Expr & { k: 'var' }, fn, vm);
    } catch {
      throw new EmueraError(`${text} is not variable`);
    }
    if (rtVars.size > 4000) rtVars.clear();
    rtVars.set(k, r);
  }
  return r;
}
defRaw('GETVAR', (vm, ex, fn) => {
  const t = compile(ex[0], fn, vm);
  return (fr) => {
    const text = S(t(fr)),
      r = runtimeVar(vm, fn, text);
    if (r.meta.isStr) throw new EmueraError(`${text} is not integer`);
    return r.get(fr);
  };
});
defRaw('GETVARS', (vm, ex, fn) => {
  const t = compile(ex[0], fn, vm);
  return (fr) => {
    const text = S(t(fr)),
      r = runtimeVar(vm, fn, text);
    if (!r.meta.isStr) throw new EmueraError(`${text} is not string`);
    return r.get(fr);
  };
});
defRaw('SETVAR', (vm, ex, fn) => {
  const t = compile(ex[0], fn, vm),
    v = compile(ex[1], fn, vm);
  return (fr) => {
    const text = S(t(fr)),
      r = runtimeVar(vm, fn, text);
    if (r.meta.konst) throw new EmueraError(`${text} is not variable`);
    const val = v(fr);
    if (r.meta.isStr !== (typeof val === 'string'))
      throw new EmueraError(`${text} is not ${r.meta.isStr ? 'integer' : 'string'}`);
    r.set(fr, val);
    return 1;
  };
});
