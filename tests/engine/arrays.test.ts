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
