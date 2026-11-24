import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { out, run } from '../helpers.ts';

const CONST_TABLE = ['{', '#DIMS CONST ROWS =', '\t"a",', '\t"b",', '\t"c"', '}', ''].join('\n');

describe('ARRAYCOPY with a constant array', () => {
  test('a #DIM CONST table can be the source', async () => {
    const o = await out(
      ['@SYSTEM_TITLE', '#DIMS DYNAMIC TMP, 5', 'ARRAYCOPY "ROWS", "TMP"', 'PRINTFORML %TMP:0%%TMP:1%%TMP:2%[%TMP:3%]', 'QUIT'],
      { erh: CONST_TABLE },
    );
    assert.deepEqual(o, ['abc[]']);
  });
  test('a constant array cannot be the destination', async () => {
    const r = await run(['@SYSTEM_TITLE', '#DIMS DYNAMIC TMP, 3', 'ARRAYCOPY "TMP", "ROWS"', 'QUIT'], { erh: CONST_TABLE });
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /2 argument of the ARRAYCOPY instruction "ROWS"/);
  });
});

describe('ARRAYSORT subscript', () => {
  test('the element subscript of a 1D array is ignored, even past the end (a FOR counter left at its end value)', async () => {
    const o = await out([
      '@SYSTEM_TITLE',
      '#DIM A, 6',
      'A:0 = 3',
      'A:1 = 9',
      'A:2 = 1',
      'A:3 = 7',
      'FOR LOCAL, 0, 6',
      'NEXT',
      'ARRAYSORT A:LOCAL, BACK',
      'PRINTFORML {A:0} {A:1} {A:2} {A:3} {A:4} {A:5}',
      'ARRAYSORT A:99',
      'PRINTFORML {A:0} {A:1} {A:2} {A:3} {A:4} {A:5}',
      'QUIT',
    ]);
    assert.deepEqual(o, ['9 7 3 1 0 0', '0 0 1 3 7 9']);
  });
  test('start and count still select the range', async () => {
    const o = await out([
      '@SYSTEM_TITLE',
      '#DIM A, 6',
      'A:0 = 5',
      'A:1 = 4',
      'A:2 = 3',
      'A:3 = 2',
      'A:4 = 1',
      'ARRAYSORT A, FORWARD, 1, 3',
      'PRINTFORML {A:0} {A:1} {A:2} {A:3} {A:4}',
      'QUIT',
    ]);
    assert.deepEqual(o, ['5 2 3 4 1']);
  });
  test('an out-of-range start is still an error', async () => {
    const r = await run(['@SYSTEM_TITLE', '#DIM A, 4', 'ARRAYSORT A, FORWARD, 9', 'QUIT']);
    assert.equal(r.errors.length, 1);
  });
});

describe('ARRAYSHIFT / ARRAYREMOVE / VARSET / ARRAYMSORT subscripts', () => {
  const head = ['@SYSTEM_TITLE', '#DIM A, 6', '#DIM B, 3, 3', 'A:0 = 1', 'A:1 = 2', 'A:2 = 3', 'A:3 = 4'];
  const row = 'PRINTFORML {A:0} {A:1} {A:2} {A:3} {A:4} {A:5}';
  test('ARRAYSHIFT ignores the element subscript of a 1D array', async () => {
    const o = await out([...head, 'ARRAYSHIFT A:99, 1, 0', row, 'QUIT']);
    assert.deepEqual(o, ['0 1 2 3 4 0']);
  });
  test('ARRAYREMOVE ignores the element subscript of a 1D array', async () => {
    const o = await out([...head, 'ARRAYREMOVE A:99, 1, 2', row, 'QUIT']);
    assert.deepEqual(o, ['1 4 0 0 0 0']);
  });
  test('ARRAYSHIFT start still errors past the end', async () => {
    const r = await run([...head, 'ARRAYSHIFT A, 1, 0, 6', 'QUIT']);
    assert.equal(r.errors.length, 1);
  });
  test('ARRAYSORT, ARRAYSHIFT and ARRAYREMOVE accept only 1D arrays', async () => {
    for (const c of ['ARRAYSORT B', 'ARRAYSHIFT B, 1, 0', 'ARRAYREMOVE B, 0, 1']) {
      const r = await run([...head, c, 'QUIT']);
      assert.equal(r.errors.length, 1, c);
      assert.match(r.errors[0], /supports only one-dimensional arrays and character array variables/, c);
    }
  });
  test('VARSET of the whole array ignores the element subscript, a partial fill checks it', async () => {
    const o = await out([...head, 'VARSET A:99, 7', row, 'QUIT']);
    assert.deepEqual(o, ['7 7 7 7 7 7']);
    const r = await run([...head, 'VARSET A:99, 5, 1, 3', 'QUIT']);
    assert.equal(r.errors.length, 1);
    const o2 = await out([...head, 'VARSET B:5, 4', 'PRINTFORML {B:0:0}{B:2:2}', 'QUIT']);
    assert.deepEqual(o2, ['44']);
  });
  test('ARRAYMSORT does not evaluate subscripts', async () => {
    const o = await out(['@SYSTEM_TITLE', '#DIM K, 4', '#DIM V, 4', 'K:0 = 3', 'K:1 = 1', 'K:2 = 2', 'V:0 = 30', 'V:1 = 10', 'V:2 = 20', 'ARRAYMSORT K:99, V:99', 'PRINTFORML {V:0} {V:1} {V:2}', 'QUIT']);
    assert.deepEqual(o, ['10 20 30']);
  });
  test('a character array keeps its character subscript: only the element subscript is ignored', async () => {
    const head2 = ['@SYSTEM_TITLE', 'ADDVOIDCHARA', 'ADDVOIDCHARA', 'CFLAG:0:0 = 1', 'CFLAG:0:1 = 2', 'CFLAG:0:2 = 3'];
    const crow = 'PRINTFORML {CFLAG:0:0} {CFLAG:0:1} {CFLAG:0:2} {CFLAG:0:3} / {CFLAG:1:0}';
    const cases: [string, string][] = [
      ['ARRAYSORT CFLAG:0:99, BACK', '3 2 1 0 / 0'],
      ['ARRAYSHIFT CFLAG:0:99, 1, 0', '0 1 2 3 / 0'],
      ['ARRAYREMOVE CFLAG:0:99, 0, 1', '2 3 0 0 / 0'],
    ];
    for (const [c, want] of cases) assert.deepEqual(await out([...head2, c, crow, 'QUIT']), [want], c);
  });
});
