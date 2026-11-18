/**
 * Expression + FORM-string parser.
 * Grammar and precedence follow Emuera.EM.
 */
import { Cursor } from './cursor';
import { Align, Expr, FormPart, ParseError } from './ast';
import { cfg } from './config';
import { ID_STOP, idStart, macroKey, MAX_EXPAND_MACRO, spliceMacro } from './macro';

const PREC: Record<string, number> = {
  '&&': 0x40,
  '||': 0x40,
  '^^': 0x40,
  '!&': 0x40,
  '!|': 0x40,
  '&': 0x50,
  '|': 0x50,
  '^': 0x50,
  '==': 0x60,
  '!=': 0x60,
  '=': 0x60,
  '<': 0x65,
  '>': 0x65,
  '<=': 0x65,
  '>=': 0x65,
  '<<': 0x70,
  '>>': 0x70,
  '+': 0x80,
  '-': 0x80,
  '*': 0x90,
  '/': 0x90,
  '%': 0x90,
};
const OPS = [
  '>>',
  '<<',
  '>=',
  '<=',
  '==',
  '!=',
  '&&',
  '||',
  '^^',
  '!&',
  '!|',
  '+',
  '-',
  '*',
  '/',
  '%',
  '>',
  '<',
  '&',
  '|',
  '^',
  '=',
];

const isDigit = (c: string) => c >= '0' && c <= '9';
const isHex = (c: string) => isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');

function readDigits(c: Cursor, base: number): bigint {
  let v = 0n;
  const b = BigInt(base);
  let n = 0;
  for (;;) {
    const ch = c.cur;
    let d: number;
    if (isDigit(ch)) d = ch.charCodeAt(0) - 48;
    else if (base === 16 && isHex(ch)) d = parseInt(ch, 16);
    else break;
    if (d >= base) break;
    v = v * b + BigInt(d);
    c.i++;
    n++;
  }
  if (n === 0) return 0n;
  return v;
}

/** Numeric literal: decimal, 0x, 0b, with `p` (x2^n) / `e` (x10^n) exponents. */
export function readInt(c: Cursor): number | bigint {
  let base = 10;
  if (c.cur === '0') {
    const n = c.at(1);
    if (n === 'x' || n === 'X') {
      base = 16;
      c.i += 2;
    } else if (n === 'b' || n === 'B') {
      base = 2;
      c.i += 2;
    }
  }
  let v = readDigits(c, base);
  const e = c.cur;
  if (e === 'p' || e === 'P' || ((e === 'e' || e === 'E') && base !== 16)) {
    const eb = e === 'p' || e === 'P' ? 2 : 10;
    c.i++;
    const ex = Number(readDigits(c, base));
    if (ex !== 0) {
      // LexicalAnalyzer.ReadInt64: the product is taken as a double and range-checked as a double, so 1p63 (= 2^63 = (double)long.MaxValue) passes and
      // the unchecked (long) cast wraps it to long.MinValue; ~(1p63) is the usual way games write long.MaxValue
      const d = Number(v) * Math.pow(eb, ex);
      if (!Number.isFinite(d) || d > 9223372036854775807 || d < -9223372036854775808)
        throw new ParseError('integer out of range');
      v = d >= 9223372036854775808 ? -9223372036854775808n : BigInt(Math.trunc(d));
    }
  }
  if (v < -9007199254740991n) return v;
  if (v > 9007199254740991n) {
    if (v > 9223372036854775807n) throw new ParseError('integer out of range');
    return v;
  }
  return Number(v);
}

export function readIdent(c: Cursor): string {
  const st = c.i;
  while (!c.eof && !ID_STOP.has(c.cur)) c.i++;
  return c.s.slice(st, c.i);
}

/** Plain string body up to the closing quote (escapes: \s \S \t \n, others literal). */
export function readQuoted(c: Cursor): string {
  let out = '';
  while (!c.eof && c.cur !== '"') {
    if (c.cur === '\\') {
      c.i++;
      if (c.eof) throw new ParseError('missing character after escape');
      out += unescape(c.cur);
      c.i++;
      continue;
    }
    out += c.cur;
    c.i++;
  }
  return out;
}

function unescape(ch: string): string {
  switch (ch) {
    case 's':
      return ' ';
    case 'S':
      return '　';
    case 't':
      return '\t';
    case 'n':
      return '\n';
    case '\n':
      return '';
    default:
      return ch;
  }
}

export class ExprParser {
  constructor(public c: Cursor) {}

  /** if the identifier at the cursor is a #DEFINE macro, replace it by its text in place (the Emuera lexer expands macros word by word) */
  expandMacro(): boolean {
    const c = this.c;
    if (cfg.macros.size === 0 || !idStart(c.s, c.i)) return false;
    let j = c.i;
    while (j < c.s.length && !ID_STOP.has(c.s[j])) j++;
    const rep = cfg.macros.get(macroKey(c.s.slice(c.i, j)));
    if (rep === undefined) return false;
    if (++c.macros > MAX_EXPAND_MACRO)
      throw new ParseError(
        `macro expansion exceeded ${MAX_EXPAND_MACRO} iterations (self-referencing or circular macro?)`,
        c.i,
      );
    c.s = spliceMacro(c.s, c.i, j, rep);
    return true;
  }

  /** Parse a full expression (incl. ternary). `stops` are chars that terminate an operand. */
  expr(stops = ''): Expr {
    const cond = this.bin(0x40, stops);
    this.c.skipWs();
    if (this.c.cur === '?' && !stops.includes('?')) {
      this.c.i++;
      const a = this.expr(stops);
      this.c.skipWs();
      if (this.c.at() !== '#') throw new ParseError("expected '#' in ternary", this.c.i);
      this.c.i++;
      const b = this.expr(stops);
      return { k: 'tern', c: cond, a, b };
    }
    return cond;
  }

  private peekOp(stops: string): string | null {
    this.c.skipWs();
    while (this.expandMacro()) this.c.skipWs();
    for (const op of OPS) {
      if (this.c.startsWith(op)) {
        if (stops.includes(op[0])) return null;
        // "++"/"--" are not binary operators
        if ((op === '+' && this.c.at(1) === '+') || (op === '-' && this.c.at(1) === '-')) return null;
        return op;
      }
    }
    return null;
  }

  private bin(min: number, stops: string): Expr {
    let l = this.unary(stops);
    for (;;) {
      const op = this.peekOp(stops);
      if (!op) return l;
      const p = PREC[op];
      if (p < min) return l;
      this.c.i += op.length;
      const r = this.bin(p + 1, stops);
      l = { k: 'bin', op: op === '=' ? '==' : op, l, r };
    }
  }

  private unary(stops: string): Expr {
    const c = this.c;
    c.skipWs();
    while (this.expandMacro()) c.skipWs();
    const ch = c.cur;
    if (c.startsWith('++') || c.startsWith('--')) {
      const op = c.s.substr(c.i, 2) as '++' | '--';
      c.i += 2;
      return { k: 'incdec', op, prefix: true, target: this.unary(stops) };
    }
    if (ch === '+' || ch === '-' || ch === '!' || ch === '~') {
      c.i++;
      return { k: 'un', op: ch, e: this.unary(stops) };
    }
    let e = this.primary(stops);
    c.skipWs();
    if (c.startsWith('++') || c.startsWith('--')) {
      // postfix only when it cannot be a binary op continuation (`A++` then end/stop)
      if (e.k === 'var') {
        const op = c.s.substr(c.i, 2) as '++' | '--';
        c.i += 2;
        e = { k: 'incdec', op, prefix: false, target: e };
      }
    }
    return e;
  }

  /** A single term (primary, no binary operators): used for lvalues and indices. */
  term(stops = ''): Expr {
    return this.primary(stops);
  }

  private primary(stops: string, inIndex = false): Expr {
    const c = this.c;
    c.skipWs();
    while (this.expandMacro()) c.skipWs();
    const ch = c.cur;
    if (c.eof) throw new ParseError('unexpected end of expression', c.i);
    if (isDigit(ch)) return { k: 'int', v: readInt(c) };
    if (ch === '"') {
      c.i++;
      const v = readQuoted(c);
      if (c.cur !== '"') throw new ParseError('unterminated string', c.i);
      c.i++;
      return { k: 'str', v };
    }
    if (ch === '@' && c.at(1) === '"') {
      c.i += 2;
      const parts = this.form('dq', false);
      if (c.cur !== '"') throw new ParseError('unterminated @"..."', c.i);
      c.i++;
      return { k: 'form', parts };
    }
    if (ch === '\\' && c.at(1) === '@') {
      c.i += 2;
      return { k: 'form', parts: [this.yenat()] };
    }
    if (ch === '(') {
      c.i++;
      const e = this.expr(',)');
      c.skipWs();
      if (c.cur !== ')') throw new ParseError("expected ')'", c.i);
      c.i++;
      return e;
    }
    const name = readIdent(c);
    if (!name) throw new ParseError(`unexpected '${ch}'`, c.i);
    // function call
    const save = c.i;
    c.skipWs();
    if (c.cur === '(') {
      c.i++;
      const args = this.args(')');
      return { k: 'call', name, args };
    }
    c.i = save;
    // variable with ':' indices (flat: `A:B:C` is A[B][C], so an index term never takes its own ':' chain)
    const idx: Expr[] = [];
    for (; !inIndex; ) {
      const s2 = c.i;
      c.skipWs();
      if (c.cur === ':') {
        c.i++;
        idx.push(this.indexTerm(stops));
      } else {
        c.i = s2;
        break;
      }
    }
    return { k: 'var', name, idx };
  }

  /** One `:`-index is a single term (use parentheses for arithmetic), as in Emuera. */
  private indexTerm(stops: string): Expr {
    return this.primary(stops + ':', true);
  }

  /** Comma-separated args up to `close` (consumed). Empty slots are allowed → int 0 marker via null-ish literal. */
  args(close: string): Expr[] {
    const c = this.c;
    const out: Expr[] = [];
    c.skipWs();
    if (c.cur === close) {
      c.i++;
      return out;
    }
    for (;;) {
      c.skipWs();
      if (c.cur === ',' || c.cur === close) out.push({ k: 'var', name: '__EMPTY__', idx: [] });
      else out.push(this.expr(',' + close));
      c.skipWs();
      if (c.cur === ',') {
        c.i++;
        continue;
      }
      if (c.cur === close) {
        c.i++;
        return out;
      }
      throw new ParseError(`expected ',' or '${close}'`, c.i);
    }
  }

  /**
   * FORM string body. `end` selects the terminator (not consumed):
   * eol | dq (") | sharp (#) | yenat (\@) | comma | pbcs (( [ , ;)
   */
  form(end: 'eol' | 'dq' | 'sharp' | 'yenat' | 'comma' | 'pbcs', trim: boolean): FormPart[] {
    const c = this.c;
    const parts: FormPart[] = [];
    let buf = '';
    const flush = () => {
      parts.push({ t: 'lit', s: buf });
      buf = '';
    };
    const pushExpr = (kind: 'int' | 'str', close: string) => {
      flush();
      c.i++;
      const e = this.expr(',' + close);
      let width: Expr | undefined;
      let align: Align = null;
      c.skipWs();
      if (c.cur === ',') {
        c.i++;
        c.skipWs();
        if (c.cur !== ',' && c.cur !== close) width = this.expr(',' + close);
        c.skipWs();
        if (c.cur === ',') {
          c.i++;
          c.skipWs();
          const w = readIdent(c).toUpperCase();
          align = w === 'LEFT' ? 'left' : w === 'RIGHT' ? 'right' : w === 'CENTER' ? 'center' : null;
          c.skipWs();
        }
      }
      if (c.cur !== close) throw new ParseError(`no matching '${close}'`, c.i);
      c.i++;
      parts.push({ t: kind, e, width, align });
    };
    loop: for (;;) {
      const ch = c.cur;
      switch (ch) {
        case '\0':
          break loop;
        case '\n':
          break loop;
        case '"':
          if (end === 'dq') break loop;
          buf += ch;
          c.i++;
          break;
        case '#':
          if (end === 'sharp') break loop;
          buf += ch;
          c.i++;
          break;
        case ',':
          if (end === 'comma' || end === 'pbcs') break loop;
          buf += ch;
          c.i++;
          break;
        case '(':
        case '[':
        case ';':
          if (end === 'pbcs') break loop;
          buf += ch;
          c.i++;
          break;
        case '%':
          pushExpr('str', '%');
          break;
        case '{':
          pushExpr('int', '}');
          break;
        case '*':
        case '+':
        case '=':
        case '/':
        case '$':
          if (!cfg.ignoreTripleSymbol && c.at(1) === ch && c.at(2) === ch) {
            flush();
            c.i += 3;
            const [v, idx] = (
              {
                '*': ['NAME', 'TARGET'],
                '+': ['CALLNAME', 'MASTER'],
                '=': ['CALLNAME', 'PLAYER'],
                '/': ['NAME', 'ASSI'],
                $: ['CALLNAME', 'TARGET'],
              } as Record<string, string[]>
            )[ch];
            parts.push({
              t: 'str',
              e: { k: 'var', name: v, idx: [{ k: 'var', name: idx, idx: [{ k: 'int', v: 0 }] }] },
            });
          } else {
            buf += ch;
            c.i++;
          }
          break;
        case '\\': {
          c.i++;
          const n = c.cur;
          if (n === '\0') throw new ParseError('missing character after escape', c.i);
          if (n === '@') {
            if (end === 'yenat' || end === 'sharp') {
              c.i--;
              break loop;
            }
            flush();
            c.i++;
            parts.push(this.yenat());
            break;
          }
          buf += unescape(n);
          c.i++;
          break;
        }
        default:
          buf += ch;
          c.i++;
      }
    }
    flush();
    if (trim) {
      const f = parts[0];
      if (f.t === 'lit') f.s = f.s.replace(/^[ \t]+/, '');
      const l = parts[parts.length - 1];
      if (l.t === 'lit') l.s = l.s.replace(/[ \t]+$/, '');
    }
    return parts;
  }

  /** After `\@`: cond ? a # b \@ */
  yenat(): FormPart {
    const c = this.c;
    const cond = this.expr('?');
    c.skipWs();
    if (c.cur !== '?') throw new ParseError("\\@ without '?'", c.i);
    c.i++;
    const a = this.form('sharp', true);
    if (c.at() !== '#') {
      // `\@cond?a\@` (missing '#') is tolerated with a warning in Emuera
      if (c.at() === '\\' && c.at(1) === '@') {
        c.i += 2;
        return { t: 'yenat', cond, a, b: null };
      }
      throw new ParseError("\\@ without '#'", c.i);
    }
    c.i++;
    const b = this.form('yenat', true);
    if (!(c.at() === '\\' && c.at(1) === '@')) throw new ParseError('unterminated \\@', c.i);
    c.i += 2;
    return { t: 'yenat', cond, a, b };
  }
}

export function parseExpr(src: string): Expr {
  const c = new Cursor(src);
  const e = new ExprParser(c).expr();
  c.skipWs();
  if (!c.eof) throw new ParseError(`trailing text '${c.rest()}'`, c.i);
  return e;
}
