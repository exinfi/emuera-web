/**
 * Emuera integers are int64. We store them as JS numbers while |v| <= 2^53 (fast path) and as
 * bigint beyond that; every arithmetic helper normalises back. Strings are JS strings.
 */
export type Int = number | bigint;
export type Value = Int | string;

const MAX = 9223372036854775807n;
const MIN = -9223372036854775808n;
const WRAP = 1n << 64n;

export function wrap64(v: bigint): bigint {
  if (v <= MAX && v >= MIN) return v;
  let r = v % WRAP;
  if (r > MAX) r -= WRAP;
  else if (r < MIN) r += WRAP;
  return r;
}
export function norm(v: bigint): Int {
  const w = wrap64(v);
  return w >= -9007199254740991n && w <= 9007199254740991n ? Number(w) : w;
}
const big = (v: Int) => (typeof v === 'bigint' ? v : BigInt(v));

export class EmueraError extends Error {}

export const add = (a: Int, b: Int): Int => {
  if (typeof a === 'number' && typeof b === 'number') {
    const r = a + b;
    if (Number.isSafeInteger(r)) return r;
  }
  return norm(big(a) + big(b));
};
export const sub = (a: Int, b: Int): Int => {
  if (typeof a === 'number' && typeof b === 'number') {
    const r = a - b;
    if (Number.isSafeInteger(r)) return r;
  }
  return norm(big(a) - big(b));
};
export const mul = (a: Int, b: Int): Int => {
  if (typeof a === 'number' && typeof b === 'number') {
    const r = a * b;
    if (Number.isSafeInteger(r)) return r;
  }
  return norm(big(a) * big(b));
};
export const div = (a: Int, b: Int): Int => {
  if (b === 0 || b === 0n) throw new EmueraError('division by zero');
  if (typeof a === 'number' && typeof b === 'number') return Math.trunc(a / b) + 0;
  return norm(big(a) / big(b));
};
export const mod = (a: Int, b: Int): Int => {
  if (b === 0 || b === 0n) throw new EmueraError('modulo by zero');
  if (typeof a === 'number' && typeof b === 'number') return (a % b) + 0;
  return norm(big(a) % big(b));
};
export const neg = (a: Int): Int => (typeof a === 'number' ? -a + 0 : norm(-a));
const TWO32 = 4294967296;
/** bitwise op on two JS-number ints via 32-bit halves (exact for |v| < 2^53; two's complement semantics match int64) */
const bit2 = (a: number, b: number, f: (x: number, y: number) => number): number => {
  const ah = Math.floor(a / TWO32),
    bh = Math.floor(b / TWO32);
  const al = a - ah * TWO32,
    bl = b - bh * TWO32;
  return f(ah, bh) * TWO32 + (f(al, bl) >>> 0);
};
export const bitAnd = (a: Int, b: Int): Int => {
  if (typeof a === 'number' && typeof b === 'number') {
    const r = bit2(a, b, (x, y) => x & y);
    if (Number.isSafeInteger(r)) return r + 0;
  }
  return norm(BigInt.asIntN(64, big(a) & big(b)));
};
export const bitOr = (a: Int, b: Int): Int => {
  if (typeof a === 'number' && typeof b === 'number') {
    const r = bit2(a, b, (x, y) => x | y);
    if (Number.isSafeInteger(r)) return r + 0;
  }
  return norm(BigInt.asIntN(64, big(a) | big(b)));
};
export const bitXor = (a: Int, b: Int): Int => {
  if (typeof a === 'number' && typeof b === 'number') {
    const r = bit2(a, b, (x, y) => x ^ y);
    if (Number.isSafeInteger(r)) return r + 0;
  }
  return norm(BigInt.asIntN(64, big(a) ^ big(b)));
};
export const bitNot = (a: Int): Int => {
  if (typeof a === 'number') {
    const r = -a - 1;
    if (Number.isSafeInteger(r)) return r + 0;
  }
  return norm(~big(a));
};
export const shl = (a: Int, b: Int): Int => {
  const n = Number(b);
  if (n < 0) throw new EmueraError('negative shift');
  if (n >= 64) return 0;
  if (typeof a === 'number' && n <= 52) {
    const r = a * 2 ** n;
    if (Number.isSafeInteger(r)) return r + 0;
  }
  return norm(BigInt.asIntN(64, big(a) << BigInt(n)));
};
export const shr = (a: Int, b: Int): Int => {
  const n = Number(b);
  if (n < 0) throw new EmueraError('negative shift');
  if (typeof a === 'number') return Math.floor(a / 2 ** Math.min(n, 64)) + 0;
  return norm(big(a) >> BigInt(Math.min(n, 64)));
};
export const cmp = (a: Int, b: Int): number => (a < b ? -1 : a > b ? 1 : 0);
export const isZero = (a: Int) => a === 0 || a === 0n;
export const toNumber = (a: Int) => Number(a);
export const bool = (b: boolean): number => (b ? 1 : 0);

/** Parse like Emuera's TOINT: leading sign/digits (and 0x/0b), otherwise 0. */
export function parseIntLoose(s: string): Int {
  const m = /^\s*([+-]?)(0[xX][0-9a-fA-F]+|0[bB][01]+|\d+)/.exec(s);
  if (!m) return 0;
  try {
    const v = BigInt(m[2]);
    return norm(m[1] === '-' ? -v : v);
  } catch {
    return 0;
  }
}
