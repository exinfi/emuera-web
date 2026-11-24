import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { out } from '../helpers.ts';
import { MTRandom } from '../../src/engine/runtime/sfmt.ts';

// Behavior follows the EM+EE and Emuera.NET sources, which agree: RANDOMIZE/INITRAND/DUMPRAND (Instraction.Child.cs), MTRandom (SFMT.cs), GetNextRand (VariableEvaluator.cs).
// The seed-1234 vector is the published SFMT-19937 reference output (32-bit mode); the other expected values are worked out from it by hand.
const seq = (n: number) => Array.from({ length: n }, (_, i) => `{RAND:1000000}`).join(' ');
const draw = (seedLine: string, extra: string[] = []) => [
  '@SYSTEM_TITLE',
  seedLine,
  `PRINTFORML ${seq(6)}`,
  ...extra,
  'QUIT',
];

describe('legacy generator (SFMT-19937, as Emuera MTRandom)', () => {
  test('first outputs for seed 1234 match the published SFMT-19937 reference values', () => {
    const r = new MTRandom(1234);
    const got = Array.from({ length: 9 }, () => r.nextUInt32());
    assert.deepEqual(got, [3440181298, 1564997079, 1510669302, 2930277156, 1452439940, 3796268453, 423124208, 2143818589, 3827219408]);
  });
  test('only the low 32 bits of the seed count', () => {
    const a = new MTRandom(5),
      b = new MTRandom(5n + (1n << 32n)),
      c = new MTRandom(-4294967291n);
    for (let i = 0; i < 5; i++) {
      const x = a.nextUInt32();
      assert.equal(b.nextUInt32(), x);
      assert.equal(c.nextUInt32(), x);
    }
  });
  test('nextMod is the 64-bit value (first output high) modulo max, for small and large maximums', () => {
    const a = new MTRandom(77),
      b = new MTRandom(77);
    for (const m of [1, 2, 7, 100, 2097152, 2097153, 4294967296, 9007199254740991, 1n << 62n]) {
      const hi = BigInt(b.nextUInt32()),
        lo = BigInt(b.nextUInt32());
      const want = ((hi << 32n) + lo) % BigInt(m);
      assert.equal(BigInt(a.nextMod(typeof m === 'bigint' ? m : m)), want, String(m));
    }
  });
});

describe('RANDOMIZE', () => {
  test('the same seed gives the same RAND sequence, a different seed another one', async () => {
    const a = await out(draw('RANDOMIZE 42'));
    const b = await out(draw('RANDOMIZE 42'));
    const c = await out(draw('RANDOMIZE 43'));
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, c);
  });
  test('reseeding in the middle of a run repeats the sequence (fixed seed first, a changing one after)', async () => {
    const o = await out([
      '@SYSTEM_TITLE',
      'RANDOMIZE 1234',
      `PRINTFORML ${seq(3)}`,
      'RANDOMIZE 999',
      `PRINTFORML ${seq(3)}`,
      'RANDOMIZE 1234',
      `PRINTFORML ${seq(3)}`,
      'QUIT',
    ]);
    assert.equal(o[0], o[2]);
    assert.notEqual(o[0], o[1]);
  });
  test('RAND(min,max) and PRINTDATA draw from the same seeded stream', async () => {
    const prog = [
      '@SYSTEM_TITLE',
      'RANDOMIZE 7',
      'PRINTFORML {RAND(10,20)} {RAND(10,20)} {RAND(10,20)}',
      'PRINTDATA',
      'DATA a',
      'DATA b',
      'DATA c',
      'ENDDATA',
      'PRINTL ',
      'QUIT',
    ];
    const a = await out(prog),
      b = await out(prog);
    assert.deepEqual(a, b);
    for (const n of a[0].split(' ').map(Number)) assert.ok(n >= 10 && n < 20);
  });
  test('the seed expression is evaluated, and a missing argument seeds 0', async () => {
    const a = await out(draw('RANDOMIZE 2 + 3'));
    const b = await out(draw('RANDOMIZE 5'));
    assert.deepEqual(a, b);
    assert.deepEqual(await out(draw('RANDOMIZE')), await out(draw('RANDOMIZE 0')));
  });
});

describe('UseNewRandom (setting.json)', () => {
  const sj = (v: string) => ({ csv: { 'setting.json': `{"UseNewRandom":${v}}` } });
  test('on: RANDOMIZE is ignored, so two seeded runs differ', async () => {
    const a = await out(draw('RANDOMIZE 42'), sj('true'));
    const b = await out(draw('RANDOMIZE 42'), sj('true'));
    assert.notDeepEqual(a, b);
  });
  test('off or missing: RANDOMIZE is honored', async () => {
    const a = await out(draw('RANDOMIZE 42'), sj('false'));
    const b = await out(draw('RANDOMIZE 42'), sj('false'));
    assert.deepEqual(a, b);
  });
});

describe('INITRAND / DUMPRAND', () => {
  test('DUMPRAND saves the state into RANDDATA and INITRAND restores it, repeating the draws', async () => {
    const o = await out([
      '@SYSTEM_TITLE',
      'RANDOMIZE 11',
      'DUMPRAND',
      `PRINTFORML ${seq(4)}`,
      'INITRAND',
      `PRINTFORML ${seq(4)}`,
      'QUIT',
    ]);
    assert.equal(o[0], o[1]);
  });
});
