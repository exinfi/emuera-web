/** String/number helper functions: BARSTR MONEYSTR STRFORM GETLINESTR CONVERT UNICODEBYTE ENCODETOUNI (and the bar text shared with BAR), plus REGEXPMATCH, HASH_XXH32 and the ENCODETOUNI statement. */
import { Cursor } from '../compiler/cursor';
import { ExprParser } from '../compiler/expr';
import type { FormPart } from '../compiler/ast';
import { compileForm, toNum } from './eval';
import { def, S } from './funcs';
import { sjisWidth } from './text';
import { EmueraError } from './value';
import type { VM } from './vm';
import { netRegex } from '../util/netregex';
import { COMMANDS } from './commands';

/** ExpressionMediator.CreateBar: "[***...]" with the configured bar characters */
export function createBar(vm: VM, v: number | bigint, max: number | bigint, len: number | bigint): string {
  const M = BigInt(max),
    L = BigInt(len);
  if (M <= 0n) throw new EmueraError('BAR: the maximum value must be positive');
  if (L <= 0n) throw new EmueraError('BAR: the length must be positive');
  if (L >= 100n) throw new EmueraError('BAR: the length is too long (must be below 100)');
  // (int)(var * length / max) with 64-bit wrap-around, as in unchecked C#
  let count = Number(BigInt.asIntN(32, BigInt.asIntN(64, BigInt(v) * L) / M));
  const n = Number(L);
  if (count < 0) count = 0;
  if (count > n) count = n;
  return '[' + vm.config.barChar1.repeat(count) + vm.config.barChar2.repeat(n - count) + ']';
}
def('BARSTR', (vm, a) => createBar(vm, a[0] as number, a[1] as number, a[2] as number));

// ------------------------------------------------------------ number format --
const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** .NET Int64.ToString(format) for the formats games use (standard D N F X E G P C R and custom 0 # , . % ; 'lit') */
export function formatLong(nIn: number | bigint, fmt: string): string {
  const n = BigInt(nIn);
  if (fmt === '') return n.toString();
  const std = /^([A-Za-z])(\d{0,2})$/.exec(fmt);
  if (std) {
    const c = std[1].toUpperCase(),
      hasP = std[2] !== '',
      p = hasP ? Number(std[2]) : -1;
    const neg = n < 0n,
      abs = (neg ? -n : n).toString();
    const sign = neg ? '-' : '';
    switch (c) {
      case 'D':
        return sign + abs.padStart(Math.max(p, 0), '0');
      case 'N':
        return sign + group(abs) + (p === 0 ? '' : '.' + '0'.repeat(p < 0 ? 2 : p));
      case 'F':
        return sign + abs + (p === 0 ? '' : '.' + '0'.repeat(p < 0 ? 2 : p));
      case 'C':
        return (neg ? '-' : '') + '¤' + group(abs) + (p > 0 ? '.' + '0'.repeat(p) : '');
      case 'P':
        return sign + group(abs + '00') + (p === 0 ? '' : '.' + '0'.repeat(p < 0 ? 2 : p)) + ' %';
      case 'X': {
        const h = BigInt.asUintN(64, n).toString(16);
        const t = std[1] === 'x' ? h : h.toUpperCase();
        return t.padStart(Math.max(p, 0), '0');
      }
      case 'E': {
        const prec = p < 0 ? 6 : p;
        const digits = abs;
        const exp = digits.length - 1;
        const mant = digits[0] + (prec ? '.' + (digits.slice(1) + '0'.repeat(prec)).slice(0, prec) : '');
        return sign + mant + (std[1] === 'e' ? 'e' : 'E') + '+' + String(exp).padStart(3, '0');
      }
      case 'G':
      case 'R':
        return n.toString();
      default:
        break;
    }
    throw new EmueraError('format');
  }
  // custom format: sections positive;negative;zero
  const sections: string[] = [];
  let cur = '',
    q = '';
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (q) {
      cur += ch;
      if (ch === q) q = '';
      continue;
    }
    if (ch === "'" || ch === '"') {
      q = ch;
      cur += ch;
      continue;
    }
    if (ch === '\\') {
      cur += ch + (fmt[++i] ?? '');
      continue;
    }
    if (ch === ';') {
      sections.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  sections.push(cur);
  const neg = n < 0n;
  let sec = sections[0];
  if (n === 0n && sections.length >= 3) sec = sections[2];
  else if (neg && sections.length >= 2) sec = sections[1];
  const useAbsSign = !(neg && sections.length >= 2);
  // tokenise the section
  type T = { k: 'lit'; s: string } | { k: 'd' | 'h' | ',' | '.' | '%' };
  const toks: T[] = [];
  for (let i = 0; i < sec.length; i++) {
    const ch = sec[i];
    if (ch === "'" || ch === '"') {
      const j = sec.indexOf(ch, i + 1);
      toks.push({ k: 'lit', s: sec.slice(i + 1, j < 0 ? undefined : j) });
      i = j < 0 ? sec.length : j;
    } else if (ch === '\\') {
      toks.push({ k: 'lit', s: sec[++i] ?? '' });
    } else if (ch === '0') toks.push({ k: 'd' });
    else if (ch === '#') toks.push({ k: 'h' });
    else if (ch === ',') toks.push({ k: ',' });
    else if (ch === '.') toks.push({ k: '.' });
    else if (ch === '%') toks.push({ k: '%' });
    else toks.push({ k: 'lit', s: ch });
  }
  let x = neg ? -n : n;
  if (toks.some((t) => t.k === '%')) x *= 100n;
  const dot = toks.findIndex((t) => t.k === '.');
  const intToks = dot < 0 ? toks : toks.slice(0, dot);
  const isDig = (t: T) => t.k === 'd' || t.k === 'h';
  let lastInt = -1;
  intToks.forEach((t, i) => {
    if (isDig(t)) lastInt = i;
  });
  let firstInt = intToks.findIndex(isDig);
  // commas after the last integer digit placeholder scale the number down by 1000 each; commas between digits group
  let thousands = 0;
  for (let i = lastInt + 1; i < intToks.length; i++) if (intToks[i].k === ',') thousands++;
  const grouping = firstInt >= 0 && intToks.slice(firstInt, lastInt + 1).some((t) => t.k === ',');
  const fracToks = dot < 0 ? [] : toks.slice(dot + 1).filter(isDig);
  const fc = fracToks.length,
    shift = thousands * 3;
  // rounded = round-half-up(x / 10^shift * 10^fc)
  const pow = (k: number) => 10n ** BigInt(k);
  const rounded = shift > fc ? (x + pow(shift - fc) / 2n) / pow(shift - fc) : x * pow(fc - shift);
  let ip = (rounded / pow(fc)).toString();
  let fp = fc ? (rounded % pow(fc)).toString().padStart(fc, '0') : '';
  const intZeros = intToks.filter((t) => t.k === 'd').length;
  if (rounded / pow(fc) === 0n) ip = '';
  ip = ip.padStart(intZeros, '0');
  if (grouping) ip = group(ip);
  // trailing '#' fraction slots drop their trailing zeros
  let keep = fc;
  for (let i = fc - 1; i >= 0 && fracToks[i].k === 'h' && fp[i] === '0'; i--) keep = i;
  fp = fp.slice(0, keep);
  const allZero = rounded === 0n;
  let out = '',
    intDone = false,
    fracDone = false,
    sawDot = false;
  for (const t of toks) {
    if (t.k === 'lit') out += t.s;
    else if (t.k === '%') out += '%';
    else if (t.k === '.') {
      sawDot = true;
      if (fp.length) out += '.';
    } else if (t.k === ',') continue;
    else if (!sawDot) {
      if (!intDone) {
        out += ip;
        intDone = true;
      }
    } else if (!fracDone) {
      out += fp;
      fracDone = true;
    }
  }
  return (neg && useAbsSign && !allZero ? '-' : '') + out;
}
def('MONEYSTR', (vm, a) => {
  const money = a[0] as number | bigint;
  let body: string;
  if (a.length < 2 || a[1] === undefined) body = money.toString();
  else {
    try {
      body = formatLong(money, String(a[1]));
    } catch {
      throw new EmueraError('MONEYSTR: The 2 argument format is wrong');
    }
  }
  return vm.config.moneyFirst ? vm.config.moneyLabel + body : body + vm.config.moneyLabel;
});

// ----------------------------------------------------------------- STRFORM --
const formCache = new Map<string, FormPart[]>();
def('STRFORM', (vm, a, fr) => {
  const s = String(a[0]);
  let parts = formCache.get(s);
  try {
    if (!parts) {
      parts = new ExprParser(new Cursor(s)).form('eol', false);
      formCache.set(s, parts);
    }
    return compileForm(parts, fr.fn, vm)(fr);
  } catch (e) {
    throw new EmueraError(`STRFORM: invalid format string "${s}": ${(e as Error).message}`);
  }
});

// ------------------------------------------------------------- GETLINESTR --
/** EmueraConsole.getStBar: repeat the text until it fills the drawable width (without crossing it) */
export function lineStr(vm: VM, bar: string): string {
  const unit = Math.max(1, vm.config.fontSize / 2); // half-width cell in px
  const limit = Math.max(1, vm.config.windowWidth - 3); // DrawableWidth
  const width = (t: string) => sjisWidth(t) * unit;
  let b = bar,
    w = 0;
  while (w < limit) {
    b += bar;
    w = width(b);
  }
  while (w > limit && b.length) {
    b = b.slice(0, -1);
    w = width(b);
  }
  return b;
}
def('GETLINESTR', (vm, a) => {
  const s = String(a[0]);
  if (!s) throw new EmueraError('GETLINESTR: The 1 argument is empty string');
  return lineStr(vm, s);
});

// ---------------------------------------------------------- conversions -----
def('CONVERT', (_vm, a) => {
  const base = Number(a[1]);
  if (![2, 8, 10, 16].includes(base))
    throw new EmueraError('CONVERT: The 2 argument of the CONVERT function must be either 2, 8, 10, 16');
  const n = BigInt(a[0] as number | bigint);
  // Convert.ToString(long, base): bases 2/8/16 print the two's complement, 10 the signed value
  return base === 10 ? n.toString() : BigInt.asUintN(64, n).toString(base);
});
def('UNICODEBYTE', (_vm, a) => {
  const s = String(a[0]);
  if (!s.length) throw new EmueraError('UNICODEBYTE: the string is empty');
  return s.codePointAt(0)!;
});
def('ENCODETOUNI', (_vm, a) => {
  const s = String(a[0]);
  if (!s.length) return -1;
  const pos = a[1] === undefined ? 0 : Number(a[1]);
  if (pos < 0) throw new EmueraError(`ENCODETOUNI: Specified negative value(${pos}) to the 2 argument`);
  if (pos >= s.length)
    throw new EmueraError(
      `ENCODETOUNI: The second argument(${pos}) exceeds the number of characters in the string of the first argument (${s})`,
    );
  const c = s.charCodeAt(pos);
  if (
    (c >= 0xdc00 && c <= 0xdfff) ||
    (c >= 0xd800 &&
      c <= 0xdbff &&
      !(pos + 1 < s.length && s.charCodeAt(pos + 1) >= 0xdc00 && s.charCodeAt(pos + 1) <= 0xdfff))
  )
    throw new EmueraError(`ENCODETOUNI: invalid surrogate at ${pos}`);
  return s.codePointAt(pos)!;
});

// ---- regex
def('REGEXPMATCH', (vm, a) => {
  let re: RegExp;
  try {
    re = netRegex(S(a[1]), 'g');
  } catch {
    throw new EmueraError(`REGEXPMATCH: bad pattern ${S(a[1])}`);
  }
  const ms = [...S(a[0]).matchAll(re)];
  if (a[2] !== undefined && toNum(a[2]) !== 0) {
    const groups = ms.length ? ms[0].length : 0;
    vm.global('RESULT')[1] = groups;
    const rs = vm.global('RESULTS');
    ms.forEach((m, i) =>
      m.forEach((g, j) => {
        const k = i * groups + j;
        if (k < rs.length) rs[k] = g ?? '';
      }),
    );
  }
  return ms.length;
});

// HASH_XXH32(str): XxHash32 of the UTF-8 bytes, seed 0, as an unsigned 32-bit number
def('HASH_XXH32', (_vm, a) => xxh32(new TextEncoder().encode(String(a[0]))));
function xxh32(b: Uint8Array): number {
  const P1 = 0x9e3779b1,
    P2 = 0x85ebca77,
    P3 = 0xc2b2ae3d,
    P4 = 0x27d4eb2f,
    P5 = 0x165667b1;
  const rotl = (x: number, r: number) => (x << r) | (x >>> (32 - r));
  const rd = (i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  const round = (acc: number, v: number) => Math.imul(rotl((acc + Math.imul(v, P2)) | 0, 13), P1);
  let i = 0,
    h: number;
  const n = b.length;
  if (n >= 16) {
    let v1 = (P1 + P2) | 0,
      v2 = P2,
      v3 = 0,
      v4 = -P1 | 0;
    for (; i <= n - 16; i += 16) {
      v1 = round(v1, rd(i));
      v2 = round(v2, rd(i + 4));
      v3 = round(v3, rd(i + 8));
      v4 = round(v4, rd(i + 12));
    }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) | 0;
  } else h = P5;
  h = (h + n) | 0;
  for (; i <= n - 4; i += 4) h = Math.imul(rotl((h + Math.imul(rd(i), P3)) | 0, 17), P4);
  for (; i < n; i++) h = Math.imul(rotl((h + Math.imul(b[i], P5)) | 0, 11), P1);
  h ^= h >>> 15;
  h = Math.imul(h, P2);
  h ^= h >>> 13;
  h = Math.imul(h, P3);
  h ^= h >>> 16;
  return h >>> 0;
}

// ENCODETOUNI <form string> (the instruction; the function form returns one code point): RESULT = the string's length, RESULT:1.. = each character's code
// (the same in Emuera.NET). char.ConvertToUtf32(s, i) throws for a low surrogate, so any surrogate pair or lone
// surrogate in the string is an error there too. ShinEraTenseiP reads button presses this way (`ONEINPUTS` then `ENCODETOUNI %RESULTS%`, button values are `UNICODE(n)`).
COMMANDS.ENCODETOUNI = (st, fn, vm) => {
  const f = st.arg.a === 'form' ? compileForm(st.arg.parts, fn, vm) : () => '';
  return (fr) => {
    const t = String(f(fr)),
      res = vm.global('RESULT');
    if (t.length > res.length - 1)
      throw new EmueraError(`ENCODETOUNI: the string is too long (${t.length} characters, at most ${res.length - 1})`);
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdfff) throw new EmueraError(`ENCODETOUNI: invalid surrogate at index ${i}`);
    }
    res[0] = t.length;
    for (let i = 0; i < t.length; i++) res[i + 1] = t.charCodeAt(i);
  };
};
