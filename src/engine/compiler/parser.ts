/**
 * ERB/ERH statement parser and program builder.
 * Grammar per command comes from reference/builtins.json (extracted from the C# source).
 */
import { detectProfile, NET_ONLY_INSTRUCTIONS, PUCHI_ONLY_INSTRUCTIONS } from '../profile';
import { loadRenameDic, applyRename } from './rename';
import builtins from '../../../reference/builtins.json';
import { Cursor } from './cursor';
import { Expr, FormPart, ParseError, Pos } from './ast';
import { ExprParser, readIdent } from './expr';
import { preprocess, PPOptions } from './preprocess';
import { sortLoadOrder, sortLoadOrderPuchi } from './loadorder';
import { configValue, loadConfig } from '../runtime/config';
import { checkBalanced, expandText, macroKey, stripLineComment } from './macro';
import { Tables } from './tables';
import { cfg, CompilerConfig } from './config';
import { resolveNames, makeFuncResolver } from './resolve';
import type { LogicalSrc } from './preprocess';
import { key } from '../util/key';
import { Arg, CaseCond, Diagnostic, FuncDef, Param, Program, Stmt, VarDecl } from './types';

// ---------------------------------------------------------------- catalog ----
const cmdArg = new Map<string, string | null>();
for (const c of builtins.commands as { name: string; arg: string | null }[]) cmdArg.set(c.name, c.arg);
const methodNames = new Set((builtins.functions as { name: string }[]).map((f) => f.name));
const builtinVars = new Map<string, { isStr: boolean }>();
for (const v of builtins.variables as { name: string; flags: string[] }[])
  builtinVars.set(v.name, { isStr: v.flags.includes('STRING') });

type Cat = 'none' | 'raw' | 'form' | 'exprs' | 'call' | 'callform' | 'case' | 'inputs';
function catOf(t: string): Cat {
  switch (t) {
    case 'VOID':
      return 'none';
    case 'STR':
    case 'STR_NULLABLE':
      return 'raw';
    case 'FORM_STR':
    case 'FORM_STR_NULLABLE':
    case 'FORM_STR_ANY':
      return 'form';
    case 'SP_CALL':
    case 'SP_CALLF':
      return 'call';
    case 'SP_CALLFORM':
    case 'SP_CALLFORMF':
      return 'callform';
    case 'CASE':
      return 'case';
    case 'SP_INPUTS':
      return 'inputs';
    default:
      return 'exprs';
  }
}
function categorize(name: string, arg: string | null): Cat | null {
  if (arg == null) return null;
  const cats = arg.split('|').map(catOf);
  if (cats.length === 1) return cats[0];
  const formish = name.includes('FORM');
  const pick = cats.find((c) => (c === 'form' || c === 'callform') === formish);
  return pick ?? cats[0];
}

const EVENT = new Set([
  'EVENTFIRST',
  'EVENTTRAIN',
  'EVENTSHOP',
  'EVENTBUY',
  'EVENTCOM',
  'EVENTTURNEND',
  'EVENTCOMEND',
  'EVENTEND',
  'EVENTLOAD',
]);

// -------------------------------------------------------------- context ------
export interface ParseCtx {
  file: string;
  globals: Map<string, VarDecl>;
  diag: Diagnostic[];
  fn?: FuncDef;
  tables?: Tables;
  /** the VARI/VARS pre-pass is running (`predeclareLocals`) */
  predecl?: boolean;
}

function lookupVar(ctx: ParseCtx, name: string): { isStr: boolean; isConst?: boolean } | undefined {
  const k = key(name);
  const l = ctx.fn?.vars.get(k);
  if (l) return l;
  const g = ctx.globals.get(k);
  if (g) return g;
  return builtinVars.get(k);
}

// ------------------------------------------------------------ const fold -----
type CV = number | bigint | string;
export function constFold(e: Expr, ctx: ParseCtx): CV {
  const bad = (m: string): never => {
    throw new ParseError(`not a constant: ${m}`);
  };
  switch (e.k) {
    case 'int':
      return e.v;
    case 'str':
      return e.v;
    case 'var': {
      if (e.idx.length) bad(e.name);
      const k = key(e.name);
      const v = ctx.fn?.vars.get(k) ?? ctx.globals.get(k);
      if (v?.isConst && v.init) return v.init[0];
      if (k === '__INT_MAX__') return 9223372036854775807n;
      if (k === '__INT_MIN__') return -9223372036854775808n;
      return bad(e.name);
    }
    case 'un': {
      const v = constFold(e.e, ctx);
      if (typeof v === 'string') return bad('unary on string');
      if (e.op === '-') return typeof v === 'bigint' ? -v : -v;
      if (e.op === '+') return v;
      if (e.op === '!') return Number(v) === 0 ? 1 : 0;
      return typeof v === 'bigint' ? ~v : ~(v as number);
    }
    case 'bin': {
      if (e.op === '+' && e.l.k === 'bin' && e.l.op === '+') {
        // a long left-deep `a + b + c + ...` chain (ShinEraTenseiP has 2,400-term string tables in an ERH): fold it in a loop, not one stack frame per term
        const rs: Expr[] = [];
        let cur: Expr = e;
        while (cur.k === 'bin' && cur.op === '+') {
          rs.push(cur.r);
          cur = cur.l;
        }
        let acc = constFold(cur, ctx);
        for (let i = rs.length - 1; i >= 0; i--) {
          const v = constFold(rs[i], ctx);
          if (typeof acc === 'string' || typeof v === 'string') {
            if (typeof acc === 'string' && typeof v === 'string') acc += v;
            else return bad('string op');
          } else {
            const r = BigInt(acc) + BigInt(v);
            acc = Number.isSafeInteger(Number(r)) ? Number(r) : r;
          }
        }
        return acc;
      }
      const a = constFold(e.l, ctx),
        b = constFold(e.r, ctx);
      if (typeof a === 'string' || typeof b === 'string') {
        if (e.op === '+' && typeof a === 'string' && typeof b === 'string') return a + b;
        if (e.op === '*' && typeof a !== typeof b) {
          // string * integer (either order): repeat the string; MultStrInt in both Emuera sources refuses a negative count and 10000 or more
          const str = (typeof a === 'string' ? a : b) as string,
            n = typeof a === 'string' ? b : a;
          const cnt = BigInt(n as number | bigint);
          if (cnt < 0n) return bad(`multiplying a string by a negative value (${cnt})`);
          if (cnt >= 10000n) return bad(`multiplying a string by ${cnt} (10000 or more)`);
          return str.repeat(Number(cnt));
        }
        return bad('string op');
      }
      const x = BigInt(a),
        y = BigInt(b);
      let r: bigint;
      switch (e.op) {
        case '+':
          r = x + y;
          break;
        case '-':
          r = x - y;
          break;
        case '*':
          r = x * y;
          break;
        case '/':
          if (y === 0n) return bad('div0');
          r = x / y;
          break;
        case '%':
          if (y === 0n) return bad('mod0');
          r = x % y;
          break;
        case '<<':
          r = x << y;
          break;
        case '>>':
          r = x >> y;
          break;
        case '&':
          r = x & y;
          break;
        case '|':
          r = x | y;
          break;
        case '^':
          r = x ^ y;
          break;
        case '==':
          r = x === y ? 1n : 0n;
          break;
        case '!=':
          r = x !== y ? 1n : 0n;
          break;
        case '<':
          r = x < y ? 1n : 0n;
          break;
        case '>':
          r = x > y ? 1n : 0n;
          break;
        case '<=':
          r = x <= y ? 1n : 0n;
          break;
        case '>=':
          r = x >= y ? 1n : 0n;
          break;
        case '&&':
          r = x && y ? 1n : 0n;
          break;
        case '||':
          r = x || y ? 1n : 0n;
          break;
        default:
          return bad(e.op);
      }
      return Number.isSafeInteger(Number(r)) ? Number(r) : r;
    }
    case 'tern':
      return Number(constFold(e.c, ctx)) !== 0 ? constFold(e.a, ctx) : constFold(e.b, ctx);
    case 'form': {
      // StrFormTerm.Restructure: a form string whose every part is constant becomes a plain string at load (`#DIMS CONST X = @"%UNICODE(0x2660)%"`, or just `@"text"`)
      let out = '';
      const part = (q: FormPart): void => {
        if (q.t === 'lit') out += q.s;
        else if (q.t === 'yenat') {
          for (const x of Number(constFold(q.cond, ctx)) !== 0 ? q.a : (q.b ?? [])) part(x);
        } else {
          if (q.width) bad('form width');
          out += String(constFold(q.e, ctx));
        } // `{x,10}` / `%s,10,LEFT%` pad by display width: not folded
      };
      for (const q of e.parts) part(q);
      return out;
    }
    case 'call': {
      const fname = key(e.name);
      const a = e.args.map((x, i) => (fname === 'GETNUM' && i === 0 ? '' : constFold(x, ctx)));
      const nums = () => a.map((x) => (typeof x === 'string' ? bad('string arg') : BigInt(x)));
      const norm = (r: bigint): CV => (Number.isSafeInteger(Number(r)) ? Number(r) : r);
      if (fname === 'VARSIZE' && typeof a[0] === 'string') {
        const v = ctx.fn?.vars.get(key(a[0])) ?? ctx.globals.get(key(a[0]));
        let dim = a.length > 1 ? Number(a[1]) : 0;
        if (dim > 0 && cfg.varsizeDim) dim--;
        if (v) return v.dims[dim] ?? bad('VARSIZE dim');
        const n = ctx.tables?.varSize(a[0], dim);
        return n ?? bad(`VARSIZE of ${a[0]}`);
      }
      if (fname === 'GETNUM' && e.args[0].k === 'var' && typeof a[1] === 'string') {
        const n = ctx.tables?.nameToIndex(e.args[0].name, a[1]);
        return n ?? bad(`GETNUM(${e.args[0].name}, "${a[1]}")`);
      }
      if ((fname === 'STRLENS' || fname === 'STRLENSU') && typeof a[0] === 'string') {
        if (fname === 'STRLENSU') return a[0].length;
        let n = 0;
        for (const ch of a[0]) {
          const cp = ch.codePointAt(0)!;
          n += cp < 0x80 || (cp >= 0xff61 && cp <= 0xff9f) ? 1 : 2;
        }
        return n;
      }
      if (fname === 'GETDEFCOLOR' && a.length === 0) return cfg.foreColor; // GetColorMethod(isDef=true): CanRestructure, Config.ForeColor & 0xFFFFFF
      if (fname === 'GETDEFBGCOLOR' && a.length === 0) return cfg.bgColor; // GetBgColorMethod(isDef=true): CanRestructure, Config.BackColor & 0xFFFFFF
      if (fname === 'GETFOCUSCOLOR' && a.length === 0) return cfg.focusColor; // GetFocusColorMethod: CanRestructure
      // built-ins Emuera marks CanRestructure (folded at load when every argument is constant)
      if (fname === 'UNICODE' && a.length === 1) {
        const n = nums()[0];
        if (n < 0n || n > 0xffffn) return bad('UNICODE range');
        return String.fromCharCode(Number(n));
      }
      if (fname === 'TOSTR' && a.length === 1 && typeof a[0] !== 'string') return String(a[0]);
      if (fname === 'SIGN' && a.length === 1) {
        const n = nums()[0];
        return n > 0n ? 1 : n < 0n ? -1 : 0;
      }
      if (fname === 'LIMIT' && a.length === 3) {
        const [v, lo, hi] = nums();
        return norm(v < lo ? lo : v > hi ? hi : v);
      }
      if (fname === 'INRANGE' && a.length === 3) {
        const [v, lo, hi] = nums();
        return v >= lo && v <= hi ? 1 : 0;
      }
      if (fname === 'MAX') return norm(nums().reduce((p, q) => (q > p ? q : p)));
      if (fname === 'MIN') return norm(nums().reduce((p, q) => (q < p ? q : p)));
      if (fname === 'ABS') return norm((([x]) => (x < 0n ? -x : x))(nums()));
      return bad('call ' + e.name);
    }
    default:
      return bad(e.k);
  }
}

// --------------------------------------------------------------- #DIM --------
const DIM_KW = new Set(['CONST', 'REF', 'DYNAMIC', 'STATIC', 'GLOBAL', 'SAVEDATA', 'CHARADATA']);
export function parseDim(rest: string, isStr: boolean, isPrivate: boolean, ctx: ParseCtx): VarDecl {
  const c = new Cursor(rest);
  const ep = new ExprParser(c);
  const d: VarDecl = {
    name: '',
    isStr,
    dims: [],
    isConst: false,
    isRef: false,
    isStatic: true,
    isGlobal: false,
    isSave: false,
    isChara: false,
  };
  for (;;) {
    c.skipWs();
    const save = c.i;
    const w = readIdent(c).toUpperCase(); // directive words follow the "ignore case" setting (default and AnonTW: on): `#DIM const` and `#fUNCTIONS` are valid in EM+EE
    if (w && DIM_KW.has(w)) {
      if (w === 'CONST') d.isConst = true;
      else if (w === 'REF') {
        d.isRef = true;
        d.isStatic = false;
      } else if (w === 'DYNAMIC') d.isStatic = false;
      else if (w === 'STATIC') d.isStatic = true;
      else if (w === 'GLOBAL') d.isGlobal = true;
      else if (w === 'SAVEDATA') d.isSave = true;
      else if (w === 'CHARADATA') d.isChara = true;
      continue;
    }
    c.i = save;
    break;
  }
  while (ep.expandMacro()) c.skipWs(); // `#DEFINE HOGE MY_INT` then `#DIM HOGE, 5` declares MY_INT
  d.name = readIdent(c);
  if (!d.name) throw new ParseError('#DIM: missing variable name');
  c.skipWs();
  const sizes: number[] = [];
  while (c.cur === ',') {
    c.i++;
    c.skipWs();
    if (d.isRef && (c.cur === ',' || c.eof)) {
      sizes.push(0);
      continue;
    }
    const e = ep.expr(',=');
    const v = constFold(e, ctx);
    if (typeof v === 'string') throw new ParseError('#DIM: size must be integer');
    sizes.push(Number(v));
    c.skipWs();
  }
  let init: Expr[] | null = null;
  c.skipWs();
  if (c.cur === '=') {
    c.i++;
    init = [];
    for (;;) {
      c.skipWs();
      if (c.eof || c.at() === ';') break; // trailing comma
      init.push(ep.expr(','));
      c.skipWs();
      if (c.at() === ',') {
        c.i++;
        continue;
      }
      break;
    }
  }
  c.skipWs();
  if (!c.eof && c.cur !== ';') throw new ParseError(`#DIM: unexpected '${c.rest()}'`);
  d.dims = sizes.length ? sizes : init ? [init.length] : [1];
  if (init) {
    try {
      d.init = init.map((e) => constFold(e, ctx));
    } catch (err) {
      // Emuera folds pure built-ins with constant arguments at load; a function-local initializer we cannot fold is evaluated on entry instead of dropping the variable
      if (!(err instanceof ParseError) || !isPrivate || d.isConst) throw err;
      d.initExprs = init;
    }
  } else if (d.isConst) throw new ParseError('#DIM CONST needs an initial value');
  return d;
}

// ----------------------------------------------------------- statements ------
const ASSIGN_OPS = ["'=", '<<=', '>>=', '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=', '==', '='];

function trailing(c: Cursor) {
  c.skipWs();
  if (!c.eof && c.cur !== ';') throw new ParseError(`unexpected '${c.rest()}'`, c.i);
}

function exprList(c: Cursor, ep: ExprParser, printV = false): Expr[] {
  const out: Expr[] = [];
  c.skipWs();
  if (c.eof || c.cur === ';') return out;
  for (;;) {
    c.skipWs();
    if (c.cur === ',') out.push({ k: 'var', name: '__EMPTY__', idx: [] });
    else if (printV && c.cur === "'") {
      // LexicalAnalyzer (AnalyzePrintV): in a PRINTV argument, `'` starts a bare string literal that runs to the next comma or end of line
      // (`PRINTV 'LV,ABL:x,'(,ABL:x * 1,')` prints "LV", the value, "(", the value*1, ")").
      c.i++;
      let t = '';
      while (!c.eof && (c.cur as string) !== ',') {
        if ((c.cur as string) === '\\') c.i++;
        t += c.cur;
        c.i++;
      }
      out.push({ k: 'str', v: t });
      if ((c.cur as string) === ',') {
        c.i++;
        c.skipWs();
        if (!c.eof) continue;
      }
      break;
    } else out.push(ep.expr(','));
    c.skipWs();
    if (c.cur === ',') {
      c.i++;
      c.skipWs();
      if (c.eof || c.at() === ';') {
        out.push({ k: 'var', name: '__EMPTY__', idx: [] });
        break;
      }
      continue;
    }
    break;
  }
  trailing(c);
  return out;
}

/** TIMES var, <real constant> */
function timesArgs(c: Cursor, ep: ExprParser): Expr[] {
  const v = ep.term(',');
  c.skipWs();
  if (c.cur !== ',') throw new ParseError("TIMES: expected ','", c.i);
  c.i++;
  c.skipWs();
  const m = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(c.rest());
  if (!m) throw new ParseError('TIMES: real constant expected', c.i);
  c.i += m[0].length;
  trailing(c);
  return [v, { k: 'real', v: parseFloat(m[0]) }];
}

function parseCase(c: Cursor, ep: ExprParser): CaseCond[] {
  const out: CaseCond[] = [];
  for (;;) {
    c.skipWs();
    if (/^IS/i.test(c.s.slice(c.i, c.i + 2)) && /[\s<>=!&|^+\-*\/%]/.test(c.at(2))) {
      // TO/IS compare with Config.StringComparison (IgnoreCase)
      c.i += 2;
      c.skipWs();
      // ExpressionParser.reduceCaseExpression accepts ANY binary operator after IS (`CASE IS & 4` tests (value & 4) != 0), not just comparisons
      const m = /^(<=|>=|==|!=|&&|\|\||\^\^|!&|!\||<<|>>|<|>|=|\+|-|\*|\/|%|&|\||\^)/.exec(c.rest());
      if (!m) throw new ParseError('CASE IS: operator expected', c.i);
      c.i += m[1].length;
      out.push({ c: 'is', op: m[1] === '=' ? '==' : m[1], e: ep.expr(',') });
    } else {
      const lo = ep.expr(',');
      c.skipWs();
      if (/^TO/i.test(c.s.slice(c.i, c.i + 2)) && /\s/.test(c.at(2))) {
        c.i += 2;
        out.push({ c: 'range', lo, hi: ep.expr(',') });
      } else out.push({ c: 'eq', e: lo });
    }
    c.skipWs();
    if (c.cur === ',') {
      c.i++;
      c.skipWs();
      if (c.eof || (c.cur as string) === ';') break; // ReduceCaseExpressions: a trailing comma ends the list (`CASE "x",`)
      continue;
    }
    break;
  }
  trailing(c);
  return out;
}

function parseCallArg(c: Cursor, ep: ExprParser, form: boolean): Arg {
  let name: string | FormPart[];
  if (form) {
    name = ep.form('pbcs', true);
  } else {
    const st = c.i;
    while (!c.eof && !'([,;'.includes(c.cur)) c.i++;
    name = c.s.slice(st, c.i).trim();
    if (!name) throw new ParseError('missing function name');
  }
  let sub: Expr[] = [];
  let args: Expr[] = [];
  if (c.cur === '[') {
    c.i++;
    sub = ep.args(']');
    c.skipWs();
  }
  if (c.cur === '(') {
    c.i++;
    args = ep.args(')');
  } else if (c.cur === ',') {
    c.i++;
    args = exprList(c, ep);
    return { a: 'call', name, sub, args };
  }
  trailing(c);
  return { a: 'call', name, sub, args };
}

function parseAssign(c: Cursor, ep: ExprParser, ctx: ParseCtx): Arg {
  const target = ep.term();
  if (target.k !== 'var' || target.name.startsWith('__')) throw new ParseError('left side is not a variable');
  c.skipWs();
  // SP_SET_ArgumentBuilder reads the text before the operator with ReduceArguments, which drops one trailing comma: `COUNTRY_SOLDIER:LOCAL, += X` is `COUNTRY_SOLDIER:LOCAL += X` (eraRanceK)
  if (c.cur === ',') {
    c.i++;
    c.skipWs();
  }
  // ++ / --
  if (c.startsWith('++') || c.startsWith('--')) {
    const op = c.s.substr(c.i, 2);
    c.i += 2;
    trailing(c);
    return { a: 'set', target, op, rhs: null, form: false };
  }
  let op = '';
  for (const o of ASSIGN_OPS)
    if (c.startsWith(o)) {
      op = o;
      break;
    }
  if (!op) throw new ParseError('cannot interpret line');
  c.i += op.length;
  if (op === '==') op = '=';
  const info = lookupVar(ctx, target.name);
  if (!info) throw new ParseError(`unknown variable '${target.name}'`);
  if (info.isStr && op === '=') {
    while (c.cur === ' ') c.i++;
    return { a: 'set', target, op, rhs: ep.form('eol', true), form: true };
  }
  const rhs = exprList(c, ep);
  // ReduceArguments: a comma right before the end of the line adds no (omitted) term, so `A = 1, 2, 3,` has three values (ShinEraTenseiP's `{ }` tables end rows with a comma)
  if (rhs.length > 1) {
    const l = rhs[rhs.length - 1];
    if (l.k === 'var' && l.name === '__EMPTY__') rhs.pop();
  }
  return { a: 'set', target, op, rhs, form: false };
}

/**
 * `VARI` / `VARS` declare a local variable for the whole function: the loader registers them while it reads the lines, and statement arguments are analysed after
 * the function is read, so a variable may be used on a line above its declaration (ShinEraTenseiP's MAG_PORTRAIT declares most of its locals half way down).
 * Called when a function's label is read: declares the function's VARI/VARS lines (up to the next label) so the statement pass finds them. Errors are left for that pass.
 */
function predeclareLocals(lines: LogicalSrc[], from: number, ctx: ParseCtx): void {
  const quiet: ParseCtx = { ...ctx, diag: [], predecl: true };
  for (let k = from; k < lines.length; k++) {
    const t = lines[k].text;
    const ch = t.charCodeAt(0);
    if (ch === 64) break; // '@': the next function
    if (ch !== 86 && ch !== 118) continue; // 'V' / 'v'
    if (!/^VAR[IS][ \t]/i.test(t)) continue;
    try {
      parseStatement(t, quiet);
    } catch {
      /* reported when the statement itself is parsed */
    }
  }
}

export function parseStatement(text: string, ctx: ParseCtx): Arg & { cmd: string } {
  const c = new Cursor(text);
  const ep = new ExprParser(c);
  c.skipWs();
  // prefix ++ / --
  if (c.startsWith('++') || c.startsWith('--')) {
    const op = c.s.substr(c.i, 2);
    c.i += 2;
    const target = ep.term();
    if (target.k !== 'var') throw new ParseError('++/-- needs a variable');
    trailing(c);
    return { cmd: 'SET', a: 'set', target, op, rhs: null, form: false };
  }
  const start = c.i;
  const rawName = readIdent(c);
  const name = key(rawName);
  const hasArgSep = c.eof || c.cur === ' ' || c.cur === '\t' || c.cur === ';' || c.cur === '　';
  if (name && cmdArg.has(name) && hasArgSep) {
    const argT = cmdArg.get(name) ?? null;
    if (name === 'VARI' || name === 'VARS') {
      // local variable declaration: VARI name[, dims] [= init]
      // `VARS X = ` (an `=` with nothing after it, ShinEraTenseiP) declares X without an initial value
      const rest = c
        .rest()
        .replace(/;.*$/, '')
        .replace(/\s*=\s*$/, '');
      // LogicalLineParser: a scalar VARI takes any integer expression as its initial value, evaluated each time the line runs (`VARI L = LINECOUNT`); an array form takes none
      const eq = rest.indexOf('=');
      let init: Expr | undefined, d: VarDecl;
      if (name === 'VARI' && eq >= 0 && !rest.slice(0, eq).includes(',') && rest.slice(eq + 1).trim() !== '') {
        d = parseDim(rest.slice(0, eq).trim(), false, true, ctx);
        const ic = new Cursor(rest.slice(eq + 1));
        init = new ExprParser(ic).expr();
        ic.skipWs();
        if (!ic.eof) throw new ParseError(`unexpected '${ic.cur}'`, ic.i);
      } else d = parseDim(rest.trim(), name === 'VARS', true, ctx);
      d.isStatic = false;
      // First declaration wins, as in both loaders (a repeated VARI, or a VARI after a `#DIM` of the same name, is ignored; ShinEraTenseiP does both)
      if (ctx.fn) {
        const k = key(d.name);
        const prev = ctx.fn.vars.get(k);
        if (ctx.predecl) {
          if (!prev) {
            d.pre = true;
            ctx.fn.vars.set(k, d);
          }
        } else if (!prev || prev.pre) ctx.fn.vars.set(k, d);
      }
      return { cmd: name, a: 'raw', text: d.name, ...(init ? { init } : {}) } as Arg & { cmd: string };
    }
    const cat = (name === 'CUSTOMDRAWLINE' ? 'raw' : categorize(name, argT)) ?? 'exprs';
    // consume exactly one separator char (raw/form keep the rest verbatim)
    if (!c.eof && cat !== 'none') c.i++;
    switch (cat) {
      case 'none':
        // VOID_ArgumentBuilder: arguments are not required; the original only warns (level 1) and runs the instruction
        return { cmd: name, a: 'none' };
      case 'raw':
        return { cmd: name, a: 'raw', text: c.rest() };
      case 'form':
        return { cmd: name, a: 'form', parts: ep.form('eol', false) };
      case 'inputs': {
        if (c.eof) return { cmd: name, a: 'inputs', def: null, rest: [] };
        const def = ep.form('comma', false);
        let rest: Expr[] = [];
        if (c.cur === ',') {
          c.i++;
          rest = exprList(c, ep);
        }
        return { cmd: name, a: 'inputs', def, rest };
      }
      case 'exprs':
        if (name === 'TIMES') return { cmd: name, a: 'exprs', list: timesArgs(c, ep) };
        return { cmd: name, a: 'exprs', list: exprList(c, ep, /^PRINTV/.test(name)) };
      case 'case':
        return { cmd: name, ...({ a: 'case', conds: parseCase(c, ep) } as Arg) };
      case 'call':
      case 'callform':
        c.skipWs();
        return { cmd: name, ...parseCallArg(c, ep, cat === 'callform') };
    }
  }
  if (name && methodNames.has(name) && (hasArgSep || c.cur === '(')) {
    // expression function used as a statement: `GDRAWG 0, 1` or `FOO(1,2)`
    if (c.cur === '(') {
      c.i = start;
      const e = ep.expr();
      trailing(c);
      return { cmd: name, a: 'exprs', list: [e] };
    }
    if (!c.eof) c.i++;
    return { cmd: name, a: 'exprs', list: exprList(c, ep) };
  }
  // assignment
  c.i = start;
  return { cmd: 'SET', ...parseAssign(c, ep, ctx) };
}

// ------------------------------------------------------------ linking --------
const OPEN_LOOP: Record<string, string> = { REPEAT: 'REND', FOR: 'NEXT', WHILE: 'WEND', DO: 'LOOP' };
const CLOSE_LOOP: Record<string, string> = { REND: 'REPEAT', NEXT: 'FOR', WEND: 'WHILE', LOOP: 'DO' };
const TRYC = new Set(['TRYCGOTO', 'TRYCJUMP', 'TRYCCALL', 'TRYCGOTOFORM', 'TRYCJUMPFORM', 'TRYCCALLFORM']);
const DATA_OPEN = /^(PRINTDATA[KDLW]*|STRDATA)$/;
const LIST_OPEN = new Set(['TRYCALLLIST', 'TRYJUMPLIST', 'TRYGOTOLIST']);

export function link(fn: FuncDef, diag: Diagnostic[]): void {
  const b = fn.body;
  const err = (i: number, msg: string) =>
    diag.push({
      file: b[i]?.pos.file ?? fn.pos.file,
      line: b[i]?.pos.line ?? fn.pos.line,
      msg: `@${fn.name}: ${msg}`,
      level: 'error',
    });
  const stack: number[] = [];
  const top = () => (stack.length ? b[stack[stack.length - 1]].cmd : '');
  const lastIf: Record<number, number> = {};
  // Both loaders keep one "paired line" per function and never clear it (loop close, BREAK/CONTINUE that found a loop,
  // CATCH and ENDCATCH set it), so a BREAK/CONTINUE outside any loop still takes the last value: no load note there, and it
  // runs against that line. We keep our note, and run against the line as well when it is a loop head.
  let pair = -1;
  for (let i = 0; i < b.length; i++) {
    const s = b[i];
    const cmd = s.cmd;
    if (cmd === 'IF' || cmd === 'SELECTCASE') {
      stack.push(i);
      lastIf[i] = i;
      continue;
    }
    if (cmd === 'ELSEIF' || cmd === 'ELSE') {
      if (top() !== 'IF') {
        err(i, `${cmd} without IF`);
        continue;
      }
      const head = stack[stack.length - 1];
      b[lastIf[head]].alt = i;
      lastIf[head] = i;
      b[i].jump = head; // temporarily: head index, fixed at ENDIF
      continue;
    }
    if (cmd === 'CASE' || cmd === 'CASEELSE') {
      if (top() !== 'SELECTCASE') {
        err(i, `${cmd} outside SELECTCASE`);
        continue;
      }
      const head = stack[stack.length - 1];
      b[lastIf[head]].alt = i;
      lastIf[head] = i;
      b[i].jump = head;
      continue;
    }
    if (cmd === 'ENDIF' || cmd === 'ENDSELECT') {
      const want = cmd === 'ENDIF' ? 'IF' : 'SELECTCASE';
      if (top() !== want) {
        err(i, `unexpected ${cmd}`);
        continue;
      }
      const head = stack.pop()!;
      b[lastIf[head]].alt = i;
      for (let j = head; j <= i; j++)
        if ((b[j].jump === head && j !== head) || j === head) {
          if (
            b[j].cmd === 'ELSEIF' ||
            b[j].cmd === 'ELSE' ||
            b[j].cmd === 'CASE' ||
            b[j].cmd === 'CASEELSE' ||
            j === head
          )
            b[j].jump = i;
        }
      b[i].jump = head;
      continue;
    }
    if (OPEN_LOOP[cmd]) {
      stack.push(i);
      continue;
    }
    if (CLOSE_LOOP[cmd]) {
      if (top() !== CLOSE_LOOP[cmd]) {
        err(i, `${cmd} without ${CLOSE_LOOP[cmd]}`);
        continue;
      }
      const head = stack.pop()!;
      b[head].jump = i;
      b[i].jump = head;
      pair = head;
      continue;
    }
    if (cmd === 'BREAK' || cmd === 'CONTINUE') {
      let found = -1;
      for (let k = stack.length - 1; k >= 0; k--)
        if (OPEN_LOOP[b[stack[k]].cmd]) {
          found = stack[k];
          break;
        }
      if (found >= 0) {
        s.jump = found;
        pair = found;
      } else {
        err(i, `${cmd} outside loop`);
        if (pair >= 0 && OPEN_LOOP[b[pair].cmd]) s.jump = pair; // the stale line; any other kind stops at run time
      }
      continue;
    }
    if (TRYC.has(cmd) || DATA_OPEN.test(cmd) || LIST_OPEN.has(cmd) || cmd === 'DATALIST' || cmd === 'NOSKIP') {
      stack.push(i);
      continue;
    }
    if (cmd === 'CATCH') {
      pair = stack.length ? stack[stack.length - 1] : -1;
      if (!TRYC.has(top())) {
        err(i, 'CATCH without TRYC*');
        continue;
      }
      const head = stack.pop()!;
      pair = head;
      b[head].alt = i;
      stack.push(i);
      continue;
    }
    const closers: Record<string, string[]> = {
      ENDCATCH: ['CATCH'],
      ENDDATA: ['DATALIST_OR_DATA'],
      ENDLIST: ['DATALIST'],
      ENDFUNC: ['TRYCALLLIST'],
      ENDNOSKIP: ['NOSKIP'],
    };
    if (cmd === 'ENDCATCH') {
      if (top() !== 'CATCH') {
        err(i, 'ENDCATCH without CATCH');
        continue;
      }
      const head = stack.pop()!;
      b[head].jump = i;
      pair = head;
      continue;
    }
    if (cmd === 'ENDLIST') {
      if (top() !== 'DATALIST') {
        err(i, 'ENDLIST without DATALIST');
        continue;
      }
      const head = stack.pop()!;
      b[head].jump = i;
      continue;
    }
    if (cmd === 'ENDDATA') {
      const t = top();
      if (!DATA_OPEN.test(t)) {
        err(i, 'ENDDATA without PRINTDATA/STRDATA');
        continue;
      }
      const head = stack.pop()!;
      b[head].jump = i;
      continue;
    }
    if (cmd === 'ENDFUNC') {
      // TRYCALLLIST ... FUNC x ... ENDFUNC
      if (!LIST_OPEN.has(top())) {
        err(i, 'ENDFUNC without TRYCALLLIST');
        continue;
      }
      const head = stack.pop()!;
      b[head].jump = i;
      continue;
    }
    if (cmd === 'ENDNOSKIP') {
      if (top() !== 'NOSKIP') {
        err(i, 'ENDNOSKIP without NOSKIP');
        continue;
      }
      const head = stack.pop()!;
      b[head].jump = i;
      continue;
    }
    void closers;
  }
  for (const k of stack) err(k, `${b[k].cmd} is never closed`);
}

// ------------------------------------------------------------- macros ---------
/** #DEFINE NAME [replacement] (text after the directive). Mirrors ErhLoader.analyzeSharpDefine. */
function defineMacro(text: string, names: string[], prog: Program): void {
  const c = new Cursor(text);
  c.skipWs();
  const name = readIdent(c);
  if (!name) throw new ParseError('missing the identifier to replace');
  const k = macroKey(name);
  if (RESERVED_NAMES.has(k)) throw new ParseError(`'${name}' is a reserved word and cannot be a macro name`);
  if (cfg.macros.has(k)) throw new ParseError(`macro '${name}' is already defined`);
  if (prog.globals.has(k)) throw new ParseError(`'${name}' is already used as a global variable name`);
  if (c.cur === '(') throw new ParseError('function-like macros cannot be declared');
  const body = stripLineComment(c.rest()).trim();
  checkBalanced(body);
  cfg.macros.set(k, expandText(body));
  names.push(name);
}
const RESERVED_NAMES = new Set([
  'IS',
  'TO',
  'INT',
  'STR',
  'REFFUNC',
  'STATIC',
  'DYNAMIC',
  'GLOBAL',
  'PRIVATE',
  'SAVEDATA',
  'CHARADATA',
  'REF',
  '__DEBUG__',
  '__SKIP__',
  '_',
]);

/**
 * IdentifierDictionary.CheckUserLabelName for @functions. A name that is also a system function or a reserved word is an error when
 * overriding is not allowed (level 2: the function is not defined) and a warning when it is; a clash with a system variable or
 * instruction is only a warning. A name already used by a #DEFINE macro is always an error.
 */
function checkLabelName(name: string, ctx: ParseCtx, pos: Pos) {
  if (!cfg.warnOverload) return;
  const k = key(name);
  const warn = (msg: string) => ctx.diag.push({ file: pos.file, line: pos.line, msg, level: 'warn' });
  if (RESERVED_NAMES.has(k)) {
    if (cfg.allowOverload) warn(`The function name "${name}" is a reserved word and overrides it`);
    else throw new ParseError(`The function name "${name}" is a reserved word and cannot be used`);
  } else if (methodNames.has(k)) {
    if (cfg.allowOverload) warn(`The function "${name}" overrides a system function`);
    else throw new ParseError(`The function name "${name}" is already used by a system function`);
  } else if (builtinVars.has(k)) warn(`The function name "${name}" is already used by a system variable`);
  else if (cmdArg.has(k)) warn(`The function name "${name}" is already used by a system instruction`);
  else if (cfg.macros.has(k)) throw new ParseError(`The function name "${name}" is already used by a macro`);
}

// ------------------------------------------------------------- files ---------
function parseLabelLine(text: string, pos: Pos, ctx: ParseCtx): FuncDef {
  const c = new Cursor(text.slice(1).trimStart());
  const name = readIdent(c);
  if (!name) throw new ParseError('invalid function label');
  checkLabelName(name, ctx, pos);
  const fn: FuncDef = {
    name,
    pos,
    method: null,
    event: EVENT.has(key(name)),
    single: false,
    pri: false,
    later: false,
    only: false,
    localSize: 0,
    localsSize: 0,
    params: [],
    vars: new Map(),
    body: [],
    labels: new Map(),
  };
  ctx.fn = fn;
  c.skipWs();
  if (c.eof || c.cur === ';') return fn;
  const ep = new ExprParser(c);
  if (c.cur === '[') {
    c.i++;
    ep.args(']');
    c.skipWs();
  }
  let close = '';
  if (c.cur === '(') {
    c.i++;
    close = ')';
  } else if (c.cur === ',') c.i++;
  else throw new ParseError('wrong argument format');
  for (;;) {
    c.skipWs();
    if (close && c.cur === close) {
      c.i++;
      break;
    }
    if (c.eof || c.at() === ';') break;
    const target = ep.term(',=)');
    c.skipWs();
    const p: Param = { target };
    if (c.at() === '=') {
      c.i++;
      p.def = ep.expr(',)');
      c.skipWs();
    }
    fn.params.push(p);
    if (c.cur === ',') {
      c.i++;
      continue;
    }
    if (close && c.cur === close) {
      c.i++;
      break;
    }
    break;
  }
  return fn;
}

function sharpLine(text: string, fn: FuncDef, ctx: ParseCtx): void {
  const c = new Cursor(text.slice(1));
  const raw = readIdent(c),
    tok = raw.toUpperCase(); // case-insensitive like EM+EE (Config.StringComparison with IgnoreCase on)
  const rest = c.rest();
  switch (tok) {
    case 'SINGLE':
      fn.single = true;
      break;
    case 'LATER':
      fn.later = true;
      break;
    case 'PRI':
      fn.pri = true;
      break;
    case 'ONLY':
      fn.only = true;
      break;
    case 'FUNCTION':
      fn.method = 'int';
      break;
    case 'FUNCTIONS':
      fn.method = 'str';
      break;
    case 'LOCALSIZE':
    case 'LOCALSSIZE': {
      const v = constFold(new ExprParser(new Cursor(rest)).expr(), ctx);
      if (tok === 'LOCALSIZE') fn.localSize = Number(v);
      else fn.localsSize = Number(v);
      break;
    }
    case 'DIM':
    case 'DIMS': {
      const d = parseDim(rest, tok === 'DIMS', true, ctx);
      if (fn.vars.get(key(d.name)) && !fn.vars.get(key(d.name))!.pre)
        throw new ParseError(`variable '${d.name}' already defined`);
      fn.vars.set(key(d.name), d);
      break;
    }
    default:
      throw new ParseError(`cannot interpret #${raw}`);
  }
}

/** `release` (optional): the caller may drop its copy of the text once the parser is done with this file (the experimental loader decodes lazily, one file at a time) */
export interface SourceFile {
  path: string;
  text: string;
  release?: () => void;
}

export interface ParseOptions extends PPOptions {
  /** CSV files by path (names, VariableSize) */
  csv?: Record<string, string>;
  config?: Partial<CompilerConfig>;
  /** Parse each function's statements on first use instead of at load (headers, #DIM/#LOCALSIZE lines and labels are still read eagerly). Same AST/diagnostics, later. */
  lazy?: boolean;
}

const LAZY = Symbol('lazyBody');
const SRC = Symbol('lazySrc'); // a forced lazy function keeps its flat body text and line numbers (no extra memory: the deferred form already held them), so an error report can show source lines
interface LazyBody {
  text: string;
  nos: Int32Array;
  file: string;
}
/** Source lines around `line` for an error report, from the body text a lazily parsed function kept: `[line number, logical line text]` (comments already stripped, `{ }` blocks joined). Undefined for functions that were parsed eagerly (those with `#` lines) and for eager programs. */
export function bodySource(
  fn: FuncDef,
  line: number,
  before = 4,
  after = 2,
): { file: string; lines: [number, string][] } | undefined {
  const st = (fn as any)[SRC] as LazyBody | undefined;
  if (!st) return undefined;
  const k = st.nos.indexOf(line);
  if (k < 0) return undefined;
  const parts = st.text.split('\n'),
    out: [number, string][] = [];
  for (let i = Math.max(0, k - before); i <= Math.min(parts.length - 1, k + after); i++)
    out.push([st.nos[i], parts[i]]);
  return { file: st.file, lines: out };
}
/** a flat copy of a substring: slices of a long string keep the whole parent alive */
const flat = (s: string): string => (s.length < 14 ? s : (' ' + s).slice(1));

export function parseProgram(files: SourceFile[], opts: ParseOptions = {}): Program {
  // engine profile: instructions only Emuera.NET has are known to the parser only for such a game
  cfg.profile = opts.config?.profile ?? detectProfile(opts.csv ?? {});
  for (const [n, t] of Object.entries(NET_ONLY_INSTRUCTIONS)) {
    if (cfg.profile === 'emuera-net') cmdArg.set(n, t);
    else cmdArg.delete(n);
  }
  for (const [n, t] of Object.entries(PUCHI_ONLY_INSTRUCTIONS)) {
    if (cfg.profile === 'puchi') cmdArg.set(n, t);
    else cmdArg.delete(n);
  }
  const renameDic = loadRenameDic(opts.csv ?? {});
  if (renameDic?.size)
    files = files.map((f) =>
      /\.(erb|erh)$/i.test(f.path)
        ? f.release
          ? ({
              path: f.path,
              release: () => f.release!(),
              get text() {
                return applyRename(f.text, renameDic);
              },
            } as SourceFile)
          : { ...f, text: applyRename(f.text, renameDic) }
        : f,
    ); // _Rename.csv: [[name]] -> value in ERB and ERH lines
  Object.assign(
    cfg,
    {
      bgColor: loadConfig(opts.csv ?? {}).backColor & 0xffffff,
      foreColor: Number(configValue(loadConfig(opts.csv ?? {}), 'ForeColor')) & 0xffffff,
      focusColor: Number(configValue(loadConfig(opts.csv ?? {}), 'FocusColor')) & 0xffffff,
      fullWidthSpace: configValue(loadConfig(opts.csv ?? {}), 'SystemAllowFullSpace') === 1,
      ignoreTripleSymbol: true,
      macros: new Map<string, string>(),
      varsizeDim: configValue(loadConfig(opts.csv ?? {}), 'VarsizeDimConfig') === 1,
      allowOverload: configValue(loadConfig(opts.csv ?? {}), 'AllowFunctionOverloading') === 1,
      warnOverload:
        configValue(loadConfig(opts.csv ?? {}), 'WarnFunctionOverloading') === 1 ||
        configValue(loadConfig(opts.csv ?? {}), 'AllowFunctionOverloading') !== 1,
    },
    opts.config,
  );
  const macroNames: string[] = [];
  const ppErh: PPOptions = { ...opts, macros: new Set(opts.macros), collectDefines: true };
  const ppErb: PPOptions = { ...opts, macros: ppErh.macros };
  const tables = new Tables(opts.csv ?? {});
  const prog: Program = {
    funcs: new Map(),
    globals: new Map(),
    diagnostics: [],
    stats: { files: files.length, funcs: 0, stmts: 0 },
    macros: macroNames,
  };
  const diag = prog.diagnostics;
  const sortFiles = configValue(loadConfig(opts.csv ?? {}), 'SortWithFilename') === 1;
  const ordered = <T extends { path: string }>(l: T[]) =>
    sortFiles ? (cfg.profile === 'puchi' ? sortLoadOrderPuchi(l) : sortLoadOrder(l)) : l;
  const erh = ordered(files.filter((f) => /\.erh$/i.test(f.path)));
  const erb = ordered(files.filter((f) => /\.erb$/i.test(f.path)));
  const err = (file: string, line: number, msg: string) => diag.push({ file, line, msg, level: 'error' });

  // ERH: #DIM lines may reference constants defined in files loaded later, so retry until no progress.
  type Pending = { file: string; line: number; text: string };
  let pending: Pending[] = [];
  for (const f of erh) {
    let lines;
    try {
      lines = preprocess(f.text, ppErh);
    } catch (e: any) {
      err(f.path, 0, e.message);
      continue;
    }
    for (const l of lines) pending.push({ file: f.path, line: l.line, text: l.text });
  }
  for (const f of erh) f.release?.();
  const ctx0: ParseCtx = { file: '', globals: prog.globals, diag, tables };
  // #DEFINE in file order first (a body sees the macros defined before it); #DIM lines may then use them
  pending = pending.filter((l) => {
    const m = /^#\s*DEFINE(?![^\s])/i.exec(l.text);
    if (!m) return true;
    try {
      defineMacro(l.text.slice(m[0].length), macroNames, prog);
    } catch (e: any) {
      err(l.file, l.line, '#DEFINE: ' + e.message);
    }
    return false;
  });
  for (;;) {
    const next: (Pending & { msg: string })[] = [];
    for (const l of pending) {
      try {
        if (l.text[0] !== '#') {
          err(l.file, l.line, 'unexpected line in ERH');
          continue;
        }
        const c = new Cursor(l.text.slice(1));
        const raw = readIdent(c),
          tok = raw.toUpperCase();
        if (tok === 'DIM' || tok === 'DIMS') {
          const d = parseDim(c.rest(), tok === 'DIMS', false, ctx0);
          if (prog.globals.has(key(d.name))) throw new ParseError(`variable '${d.name}' already defined`);
          prog.globals.set(key(d.name), d);
        } else throw new ParseError(`cannot interpret #${raw}`);
      } catch (e: any) {
        next.push({ ...l, msg: e.message });
      }
    }
    if (next.length === 0) break;
    if (next.length === pending.length) {
      for (const l of next) err(l.file, l.line, l.msg);
      break;
    }
    pending = next;
  }

  const lazy = opts.lazy ?? (globalThis as any).process?.env?.EMU_LAZY === '1'; // EMU_LAZY=1 runs the test-suite/tools lazily
  const resStats = { resolved: 0, unresolved: 0 };
  let resolveOne: ((fn: FuncDef) => void) | undefined;
  const cfgSnap = () => ({ ...cfg });
  let snap: CompilerConfig | undefined;
  /** One body line -> statement (eager and lazy paths share this). */
  const bodyLine = (l: LogicalSrc, fn: FuncDef, ctx: ParseCtx, file: string) => {
    const pos: Pos = { file, line: l.line };
    try {
      const ch = l.text[0];
      if (ch === '#') {
        sharpLine(l.text, fn, ctx);
        return;
      }
      if (ch === '$') {
        const name = readIdent(new Cursor(l.text.slice(1).trimStart())); // EM+EE: the lexer skips blanks after `$` ("$ PRO_JUMP_1" in eraRanceK)
        fn.labels.set(key(name), fn.body.length);
        fn.body.push({ pos, cmd: '$', arg: { a: 'raw', text: name } });
        return;
      }
      const r = parseStatement(l.text, ctx);
      const { cmd, ...arg } = r;
      fn.body.push({ pos, cmd, arg: arg as Arg });
    } catch (e: any) {
      diag.push({
        file,
        line: l.line,
        msg: e.message + (e instanceof ParseError && e.col >= 0 ? ` (col ${e.col})` : ''),
        level: 'error',
      });
    }
  };
  /**
   * Defer a function's statements: body/labels become accessors that parse, link and resolve on first read.
   * Memory (matters on phones; a 240 MB ERB game has 140 000 functions): a deferred function keeps only its logical lines as one flat string plus their line
   * numbers, and every deferred function shares the same two accessor functions (no per-function closures). Strings the parser keeps from `@` lines and eagerly parsed
   * bodies are flat copies (`flat`), because a substring would keep the whole source file's text alive.
   */
  const def = (fn: FuncDef, k: 'body' | 'labels', v: unknown) =>
    Object.defineProperty(fn, k, { value: v, writable: true, configurable: true, enumerable: true });
  const ensureFn = (fn: FuncDef) => {
    const st = (fn as any)[LAZY] as LazyBody;
    (fn as any)[LAZY] = undefined;
    (fn as any)[SRC] = st;
    def(fn, 'body', []);
    def(fn, 'labels', new Map());
    if (
      snap &&
      (cfg.macros !== snap.macros ||
        cfg.varsizeDim !== snap.varsizeDim ||
        cfg.allowOverload !== snap.allowOverload ||
        cfg.fullWidthSpace !== snap.fullWidthSpace ||
        cfg.ignoreTripleSymbol !== snap.ignoreTripleSymbol)
    )
      Object.assign(cfg, snap);
    const ctx: ParseCtx = { file: st.file, globals: prog.globals, diag, tables, fn };
    const parts = st.text.split('\n');
    for (let i = 0; i < parts.length; i++) bodyLine({ line: st.nos[i], text: parts[i] }, fn, ctx, st.file);
    link(fn, diag);
    prog.stats.stmts += fn.body.length;
    resolveOne ??= makeFuncResolver(prog, tables, resStats);
    resolveOne(fn);
    prog.names = resStats;
  };
  const lazyAccessor = (k: 'body' | 'labels'): PropertyDescriptor => ({
    configurable: true,
    enumerable: true,
    get(this: FuncDef) {
      ensureFn(this);
      return this[k];
    },
    set(this: FuncDef, v: unknown) {
      def(this, k, v);
    },
  });
  const accBody = lazyAccessor('body'),
    accLabels = lazyAccessor('labels');
  const defer = (fn: FuncDef, lines: LogicalSrc[], from: number, to: number, file: string) => {
    const nos = new Int32Array(to - from);
    for (let k = from; k < to; k++) nos[k - from] = lines[k].line;
    (fn as any)[LAZY] = {
      text: lines
        .slice(from, to)
        .map((x) => x.text)
        .join('\n'),
      nos,
      file,
    } as LazyBody;
    Object.defineProperty(fn, 'body', accBody);
    Object.defineProperty(fn, 'labels', accLabels);
  };

  let prevSrc: SourceFile | undefined; // the previous file's text is released when the next one starts (an early `continue` below cannot skip it)
  for (const f of erb) {
    prevSrc?.release?.();
    prevSrc = f;
    let lines: LogicalSrc[];
    try {
      lines = preprocess(f.text, ppErb);
    } catch (e: any) {
      err(f.path, 0, e.message);
      continue;
    }
    const ctx: ParseCtx = { file: f.path, globals: prog.globals, diag, tables };
    let fn: FuncDef | undefined;
    let orphan: { first: number; n: number; text: string } | undefined; // lines before the file's first function: reported once per file
    let skipBody = false; // after a refused label the lines up to the next label belong to no function
    let isLazy = false;
    const finish = () => {
      if (!fn) return;
      if (!isLazy) {
        link(fn, diag);
        prog.stats.stmts += fn.body.length;
      }
      isLazy = false;
      prog.stats.funcs++;
      const arr = prog.funcs.get(key(fn.name)) ?? [];
      arr.push(fn);
      prog.funcs.set(key(fn.name), arr);
    };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const pos: Pos = { file: f.path, line: l.line };
      const ch = l.text[0];
      if (ch === '@') {
        finish();
        ctx.fn = undefined;
        fn = undefined;
        skipBody = true;
        try {
          fn = parseLabelLine(flat(l.text), pos, ctx);
          skipBody = false;
          predeclareLocals(lines, i + 1, ctx);
        } catch (e: any) {
          err(f.path, l.line, e.message + (e instanceof ParseError && e.col >= 0 ? ` (col ${e.col})` : ''));
        }
        continue;
      }
      if (!fn) {
        if (!skipBody) {
          if (!orphan) {
            orphan = { first: l.line, n: 0, text: l.text };
          }
          orphan.n++;
        }
        continue;
      }
      if (lazy && ch !== '#' && fn.body.length === 0 && !isLazy) {
        // first statement line: if no '#' line follows in this function, defer the whole remainder
        let j = i;
        while (j < lines.length && lines[j].text[0] !== '@' && lines[j].text[0] !== '#') j++;
        if (j >= lines.length || lines[j].text[0] === '@') {
          defer(fn, lines, i, j, f.path);
          isLazy = true;
          i = j - 1;
          continue;
        }
      }
      bodyLine({ line: l.line, text: flat(l.text) }, fn, ctx, f.path);
    }
    finish();
    if (orphan)
      err(
        f.path,
        orphan.first,
        orphan.n === 1
          ? 'line before first function'
          : `${orphan.n} lines before first function (first line: ${JSON.stringify(orphan.text.slice(0, 40))})${/\0/.test(f.text) ? '; the file contains NUL characters, so it is probably not in a text encoding the loader detected' : ''}`,
      );
  }
  prevSrc?.release?.();
  if (lazy) {
    snap = cfgSnap();
    prog.names = resStats;
    return prog;
  }
  prog.names = resolveNames(prog, tables);
  return prog;
}

/** Parse every deferred function body now (lazy programs); a no-op for eagerly parsed ones. */
export function forceAll(prog: Program): Program {
  for (const l of prog.funcs.values()) for (const f of l) void f.body;
  return prog;
}
