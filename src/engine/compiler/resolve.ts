/**
 * Name resolution pass: replaces CSV element names used as indices (`ABL:TECH`, `CFLAG:現在位置`)
 * with their integer indices, and reports names that resolve to nothing.
 */
import builtins from '../../../reference/builtins.json';
import { Expr, FormPart } from './ast';
import { arityError, stmtArityError } from './arity';
import type { Tables } from './tables';
import type { Arg, Diagnostic, FuncDef, Program, Stmt } from './types';

const builtinVars = new Map<string, string[]>();
for (const v of builtins.variables as { name: string; flags: string[] }[]) builtinVars.set(v.name, v.flags);
const methodNames = new Set((builtins.functions as { name: string }[]).map((f) => f.name));
const up = (s: string) => s.toUpperCase();

export interface ResolveStats {
  resolved: number;
  unresolved: number;
}

export interface Resolver {
  expr(e: Expr, fn: FuncDef | undefined): Expr;
  parts(p: FormPart[], fn: FuncDef | undefined): void;
  stats: ResolveStats;
}
/** Resolver for text parsed while the game runs (GETVAR / FORMS / CALLFORM ...): same CSV-name rules as the load-time pass. */
export function makeResolver(prog: Program, tables: Tables): Resolver {
  const stats: ResolveStats = { resolved: 0, unresolved: 0 };
  const w = buildWalker(prog, tables, stats, new Set<string>());
  const st = { pos: { file: '(runtime)', line: 0 } } as unknown as Stmt;
  return { stats, expr: (e, fn) => w.walk(e, fn, st), parts: (p, fn) => p.forEach((x) => w.walkPart(x, fn, st)) };
}

/** Returns a function that resolves one function's body in place (names, statement arity). Shared walker state so results match a whole-program pass. */
export function makeFuncResolver(prog: Program, tables: Tables, stats: ResolveStats): (fn: FuncDef) => void {
  const seenUnknown = new Set<string>();
  const { walk, walkPart } = buildWalker(prog, tables, stats, seenUnknown);
  const walkArg = (a: Arg, fn: FuncDef | undefined, st: Stmt) => {
    switch (a.a) {
      case 'exprs':
        a.list = a.list.map((x) => walk(x, fn, st));
        break;
      case 'raw': {
        const ia = a as { init?: Expr };
        if (ia.init) ia.init = walk(ia.init, fn, st);
        break;
      } // VARI x = FLAG:名前
      case 'form':
        a.parts.forEach((p) => walkPart(p, fn, st));
        break;
      case 'inputs':
        a.def?.forEach((p) => walkPart(p, fn, st));
        a.rest = a.rest.map((x) => walk(x, fn, st));
        break;
      case 'call':
        if (typeof a.name !== 'string') a.name.forEach((p) => walkPart(p, fn, st));
        a.sub = a.sub.map((x) => walk(x, fn, st));
        a.args = a.args.map((x) => walk(x, fn, st));
        break;
      case 'case':
        for (const c of a.conds) {
          if (c.c === 'eq' || c.c === 'is') c.e = walk(c.e, fn, st);
          else {
            c.lo = walk(c.lo, fn, st);
            c.hi = walk(c.hi, fn, st);
          }
        }
        break;
      case 'set':
        a.target = walk(a.target, fn, st);
        if (a.rhs) {
          if (a.form) (a.rhs as FormPart[]).forEach((p) => walkPart(p, fn, st));
          else a.rhs = (a.rhs as Expr[]).map((x) => walk(x, fn, st));
        }
        break;
    }
  };
  return (fn) => {
    for (const st of fn.body) {
      walkArg(st.arg, fn, st);
      if (st.arg.a === 'exprs') {
        const r = stmtArityError(st.cmd, st.arg.list);
        if (r?.warn) prog.diagnostics.push({ file: st.pos.file, line: st.pos.line, msg: r.warn, level: 'warn' });
        if (r?.error) {
          prog.diagnostics.push({ file: st.pos.file, line: st.pos.line, msg: r.error, level: 'error' });
          // the original marks the line as an error line and throws when it is executed
          st.arg = { a: 'raw', text: r.error } as Arg;
          st.cmd = '__ERRLINE';
        }
      }
    }
  };
}

export function resolveNames(prog: Program, tables: Tables): ResolveStats {
  const stats: ResolveStats = { resolved: 0, unresolved: 0 };
  const one = makeFuncResolver(prog, tables, stats);
  for (const list of prog.funcs.values()) for (const fn of list) one(fn);
  return stats;
}

function buildWalker(prog: Program, tables: Tables, stats: ResolveStats, seenUnknown: Set<string>) {
  const userMethods = new Set([...prog.funcs].filter(([, v]) => v.some((f) => f.method)).map(([k]) => k));
  const known = (fn: FuncDef | undefined, name: string): boolean => {
    const k = up(name);
    // ExpressionParser.reduceIdentifier (identifier without parentheses): only variables shadow a CSV name. #FUNCTION methods and built-in function names do not (GetFunctionMethod with null arguments only looks at REF-returning methods), e.g. `RCVAR:ARG:精飲フラグ` still reads the CSV name although `@精飲フラグ(ARG)` is a #FUNCTION.
    return !!(fn?.vars.has(k) || prog.globals.has(k) || builtinVars.has(k));
  };

  const walk = (e: Expr, fn: FuncDef | undefined, st: Stmt): Expr => {
    switch (e.k) {
      case 'var': {
        e.idx = e.idx.map((x) => walk(x, fn, st));
        const flags = builtinVars.get(up(e.name));
        if (up(e.name) === 'CDFLAG' && e.idx.length >= 2) {
          // CDFLAG:chara:name1:name2 - the two dimensions are named by Cdflag1.csv / Cdflag2.csv (CDFLAGNAME1 / CDFLAGNAME2)
          const shift = e.idx.length === 3 ? 1 : 0;
          for (const d of [0, 1]) {
            const ix = e.idx[shift + d];
            if (ix && ix.k === 'var' && ix.idx.length === 0 && !known(fn, ix.name) && ix.name !== '__EMPTY__') {
              const n = tables.userTable('CDFLAG' + (d + 1), 0)?.byName.get(ix.name);
              if (n !== undefined) {
                e.idx[shift + d] = { k: 'int', v: n };
                stats.resolved++;
              }
            }
          }
        }
        const user = fn?.vars.get(up(e.name)) ?? prog.globals.get(up(e.name));
        if (user && e.idx.length) {
          e.idx.forEach((ix, p) => {
            if (ix.k === 'var' && ix.idx.length === 0 && !known(fn, ix.name) && ix.name !== '__EMPTY__') {
              const shift = user.isChara && e.idx.length === user.dims.length + 1 ? 1 : 0;
              const n = p - shift < 0 ? undefined : tables.userTable(e.name, p - shift)?.byName.get(ix.name);
              if (n !== undefined) {
                e.idx[p] = { k: 'int', v: n };
                stats.resolved++;
              } else {
                stats.unresolved++;
                const key = `${e.name}:${ix.name}`;
                if (!seenUnknown.has(key)) {
                  seenUnknown.add(key);
                  prog.diagnostics.push({
                    file: st.pos.file,
                    line: st.pos.line,
                    msg: `unresolved name '${ix.name}' in ${e.name}`,
                    level: 'warn',
                  });
                }
              }
            }
          });
        } else if (e.idx.length) {
          const pos = e.idx.length - 1;
          const ix = e.idx[pos];
          if (ix.k === 'var' && ix.idx.length === 0 && !known(fn, ix.name) && ix.name !== '__EMPTY__') {
            const n = flags ? tables.nameToIndex(e.name, ix.name) : undefined;
            if (n !== undefined) {
              e.idx[pos] = { k: 'int', v: n };
              stats.resolved++;
            } else if (!user) {
              stats.unresolved++;
              const key = `${e.name}:${ix.name}`;
              if (!seenUnknown.has(key)) {
                seenUnknown.add(key);
                prog.diagnostics.push({
                  file: st.pos.file,
                  line: st.pos.line,
                  msg: `unresolved name '${ix.name}' in ${e.name}`,
                  level: 'warn',
                });
              }
            }
          }
        }
        return e;
      }
      case 'call': {
        e.args = e.args.map((x) => walk(x, fn, st));
        if (!userMethods.has(up(e.name))) {
          const m = arityError(e.name, e.args);
          if (m && !seenUnknown.has('arity:' + st.pos.file + st.pos.line + m)) {
            seenUnknown.add('arity:' + st.pos.file + st.pos.line + m);
            prog.diagnostics.push({ file: st.pos.file, line: st.pos.line, msg: m, level: 'warn' });
          }
        }
        return e;
      }
      case 'un':
        e.e = walk(e.e, fn, st);
        return e;
      case 'bin':
        e.l = walk(e.l, fn, st);
        e.r = walk(e.r, fn, st);
        return e;
      case 'tern':
        e.c = walk(e.c, fn, st);
        e.a = walk(e.a, fn, st);
        e.b = walk(e.b, fn, st);
        return e;
      case 'incdec':
        e.target = walk(e.target, fn, st);
        return e;
      case 'form':
        for (const p of e.parts) walkPart(p, fn, st);
        return e;
      default:
        return e;
    }
  };
  const walkPart = (p: FormPart, fn: FuncDef | undefined, st: Stmt) => {
    if (p.t === 'lit') return;
    if (p.t === 'yenat') {
      p.cond = walk(p.cond, fn, st);
      p.a.forEach((x) => walkPart(x, fn, st));
      p.b?.forEach((x) => walkPart(x, fn, st));
      return;
    }
    p.e = walk(p.e, fn, st);
    if (p.width) p.width = walk(p.width, fn, st);
  };
  return { walk, walkPart };
}
export type { Diagnostic };
