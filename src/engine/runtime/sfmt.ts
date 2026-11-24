/**
 * The legacy random generator of Emuera (MinorShift.Emuera.Runtime.Utils.MTRandom, SFMT-19937 after Rei HOBARA's C# port), ported line by line.
 * `RANDOMIZE n` creates one seeded with the low 32 bits of n; `RAND` is then NextUInt64 % max where NextUInt64 joins two 32-bit outputs, the first one the high half.
 * Both EM+EE and Emuera.NET use it whenever the game's `UseNewRandom` setting is off (the default); with it on RANDOMIZE, INITRAND and DUMPRAND do nothing.
 */
import type { Int } from './value';

const MEXP = 19937;
const N = Math.floor(MEXP / 128) + 1; // 156 128-bit words
export const N32 = N * 4; // 624 32-bit words
const POS1 = 122;
const SL1 = 18;
const SR1 = 11;
const MSK = [0xdfffffef, 0xddfecb7f, 0xbffaffff, 0xbffffff6];
const PARITY = [0x00000001, 0x00000000, 0x00000000, 0x13c9e684];

export class MTRandom {
  private s = new Uint32Array(N32);
  private idx = N32;

  /** seed: a long; only its low 32 bits count (the original casts to uint) */
  constructor(seed: bigint | number) {
    const s = this.s;
    s[0] = Number(BigInt.asUintN(32, BigInt(seed)));
    for (let i = 1; i < N32; i++) s[i] = (Math.imul(1812433253, s[i - 1] ^ (s[i - 1] >>> 30)) + i) >>> 0;
    this.periodCertification();
    this.idx = N32;
  }

  private periodCertification() {
    const s = this.s;
    let inner = 0;
    for (let i = 0; i < 4; i++) inner ^= s[i] & PARITY[i];
    for (let i = 16; i > 0; i >>= 1) inner ^= inner >>> i;
    inner &= 1;
    if (inner === 1) return;
    for (let i = 0; i < 4; i++) {
      let work = 1;
      for (let j = 0; j < 32; j++) {
        if ((work & PARITY[i]) !== 0) {
          s[i] ^= work;
          return;
        }
        work = (work << 1) >>> 0;
      }
    }
  }

  private genAll() {
    const p = this.s;
    let a = 0;
    let b = POS1 * 4;
    let c = (N - 2) * 4;
    let d = (N - 1) * 4;
    do {
      p[a + 3] = p[a + 3] ^ (p[a + 3] << 8) ^ (p[a + 2] >>> 24) ^ (p[c + 3] >>> 8) ^ ((p[b + 3] >>> SR1) & MSK[3]) ^ (p[d + 3] << SL1);
      p[a + 2] = p[a + 2] ^ (p[a + 2] << 8) ^ (p[a + 1] >>> 24) ^ (p[c + 3] << 24) ^ (p[c + 2] >>> 8) ^ ((p[b + 2] >>> SR1) & MSK[2]) ^ (p[d + 2] << SL1);
      p[a + 1] = p[a + 1] ^ (p[a + 1] << 8) ^ (p[a] >>> 24) ^ (p[c + 2] << 24) ^ (p[c + 1] >>> 8) ^ ((p[b + 1] >>> SR1) & MSK[1]) ^ (p[d + 1] << SL1);
      p[a] = p[a] ^ (p[a] << 8) ^ (p[c + 1] << 24) ^ (p[c] >>> 8) ^ ((p[b] >>> SR1) & MSK[0]) ^ (p[d] << SL1);
      c = d;
      d = a;
      a += 4;
      b += 4;
      if (b >= N32) b = 0;
    } while (a < N32);
  }

  nextUInt32(): number {
    if (this.idx >= N32) {
      this.genAll();
      this.idx = 0;
    }
    return this.s[this.idx++];
  }

  /** NextInt64(max) for max > 0: (hi << 32 | lo) % max with the first output as hi. A safe-integer path for the usual small maximums, BigInt beyond. */
  nextMod(max: Int): Int {
    const hi = this.nextUInt32();
    const lo = this.nextUInt32();
    if (typeof max === 'number' && max <= 2097152) return (((hi % max) * (4294967296 % max)) % max + (lo % max)) % max;
    const r = ((BigInt(hi) << 32n) + BigInt(lo)) % BigInt(max);
    return r <= 9007199254740991n ? Number(r) : r;
  }

  /** the 625 words INITRAND / DUMPRAND exchange with RANDDATA: 624 state words and the index */
  getState(out: (i: number, v: number) => void) {
    for (let i = 0; i < N32; i++) out(i, this.s[i]);
    out(N32, this.idx);
  }
  setState(get: (i: number) => number) {
    for (let i = 0; i < N32; i++) this.s[i] = Number(BigInt.asUintN(32, BigInt(get(i))));
    this.idx = Math.max(0, Math.min(N32, Number(get(N32))));
  }
}
