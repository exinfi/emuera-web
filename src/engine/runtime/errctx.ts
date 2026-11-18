/**
 * Error context: when an ERB statement fails, say exactly where (file, line, the ERB call stack with arguments)
 * and what the statement was reading (current value of every variable it mentions).
 */
import type { Expr } from '../compiler/ast';
import type { Stmt } from '../compiler/types';
import { compile, type Frame } from './eval';

export interface ErrFrame {
  fn: string;
  file: string;
  line: number;
  cmd: string;
  arg: string;
  args: string;
}
export interface ErrInfo {
  stack: ErrFrame[];
  vars: string[];
}

const short = (v: unknown) =>
  typeof v === 'string' ? JSON.stringify(v.length > 60 ? v.slice(0, 60) + '…' : v) : String(v);

/** every variable reference inside a statement's arguments (deduplicated, capped) */
function varNodes(x: unknown, out: Expr[], seen = new Set<unknown>()) {
  if (!x || typeof x !== 'object' || seen.has(x) || out.length >= 14) return;
  seen.add(x);
  if (Array.isArray(x)) {
    for (const y of x) varNodes(y, out, seen);
    return;
  }
  const o = x as any;
  if (o.k === 'var' && typeof o.name === 'string' && o.name !== '__EMPTY__') out.push(o as Expr);
  for (const k of Object.keys(o)) if (k !== 'pos') varNodes(o[k], out, seen);
}

export function readVars(fr: Frame, st: Stmt): string[] {
  const nodes: Expr[] = [];
  varNodes((st as any).arg, nodes);
  const lines: string[] = [];
  const done = new Set<string>();
  for (const n of nodes) {
    if (n.k !== 'var') continue;
    try {
      const idx = n.idx.map((i) => short(compile(i, fr.fn, fr.vm)(fr)));
      const label = n.name + (idx.length ? ':' + idx.join(':') : '');
      if (done.has(label)) continue;
      done.add(label);
      lines.push(`${label} = ${short(compile(n, fr.fn, fr.vm)(fr))}`);
    } catch (e: any) {
      lines.push(`${n.name} = <unreadable: ${String(e?.message ?? e).slice(0, 50)}>`);
    }
  }
  return lines;
}

/** called while an error unwinds through each ERB function: records this level (innermost first) */
export function noteFrame(e: any, fr: Frame, st: Stmt | undefined) {
  if (!st) return;
  if (!e.erb) e.erb = { stack: [], vars: readVars(fr, st) }; // the innermost level reads the variables
  const info: ErrInfo = e.erb;
  if (info.stack.length > 60) return;
  const named = fr.fn.params
    .map((p) => {
      try {
        return p.target.k === 'var' ? `${p.target.name}=${short(compile(p.target, fr.fn, fr.vm)(fr))}` : '';
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  const trim = (a: ArrayLike<unknown>) => {
    const l = Array.from(a).slice(0, 6).map(String);
    while (l.length && (l[l.length - 1] === '0' || l[l.length - 1] === '')) l.pop();
    return l;
  };
  const nums = (
    named.length
      ? named
      : trim(fr.arg)
          .map((v, i) => `ARG:${i}=${v}`)
          .concat(trim(fr.args).map((v, i) => `ARGS:${i}=${short(v)}`))
  ).join(', ');
  const strs = '';
  info.stack.push({ fn: fr.fn.name, file: st.pos.file, line: st.pos.line, cmd: st.cmd, arg: nums, args: strs });
}

export function formatStack(info: ErrInfo): string {
  const out = info.stack.map(
    (f, i) =>
      `  ${i === 0 ? 'at' : 'called from'} @${f.fn}(${[f.arg, f.args].filter(Boolean).join(' | ')})  ${f.file}:${f.line}  [${f.cmd}]`,
  );
  if (info.vars.length) out.push('  statement reads: ' + info.vars.join('; '));
  return out.join('\n');
}
