import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { out, run } from '../helpers.ts';

// Source: EM+EE DataTableSelectMethod passes filter/sort straight to .NET DataTable.Select (DataColumn.Expression syntax).
const game = (body: string[]) => [
  '@SYSTEM_TITLE',
  'DT_CREATE "T"',
  'DT_COLUMN_ADD "T", "name", "string"',
  'DT_COLUMN_ADD "T", "n", "int32"',
  'DT_ROW_ADD "T", "name", "alpha", "n", 5',
  'DT_ROW_ADD "T", "name", "be", "n", 12',
  'DT_ROW_ADD "T", "name", "gamma", "n", 3',
  ...body,
  'QUIT',
];
const sel = async (filter: string, sort = '') => {
  const r = await out(
    game([
      `LOCAL = DT_SELECT("T", "${filter.replace(/"/g, '""')}"${sort ? `, "${sort}"` : ''})`,
      'PRINTFORML {LOCAL}:{DT_CELL_GET("T", RESULT:1, "n", 1)},{DT_CELL_GET("T", RESULT:2, "n", 1)}',
    ]),
  );
  return r[0];
};

describe('DT_SELECT expression functions', () => {
  test('Len', async () => assert.equal(await sel('Len(name) = 2'), '1:12,0'));
  test('Substring is 1-based', async () => assert.equal(await sel("Substring(name, 1, 1) = 'g'"), '1:3,0'));
  test('Trim and IsNull', async () => assert.equal(await sel("Trim(IsNull(name, 'x')) = 'be'"), '1:12,0'));
  test('IIf', async () => assert.equal(await sel('IIf(n > 4, 1, 0) = 1', 'n DESC'), '2:12,5'));
  test('Convert', async () => assert.equal(await sel("Convert(n, 'System.String') = '12'"), '1:12,0'));
  test('aggregates over the table', async () => {
    assert.equal(await sel('n = Max(n)'), '1:12,0');
    assert.equal(await sel('n < Avg(n)', 'n'), '2:3,5');
    assert.equal(await sel('Count(*) = 3 AND n = Min(n)'), '1:3,0');
  });
  test('unknown function reports an error', async () => {
    const res = await run(game(['DT_SELECT "T", "Foo(n) = 1"']));
    assert.match(res.errors.join('|'), /unknown function/);
  });
});

describe('DT_SELECT number scanning', () => {
  // a number ends where its digits end, so a keyword may follow with no space (a filter built as "n = 5" + "OR n = 3")
  test('keyword right after a number', async () => assert.equal(await sel('n = 5OR n = 3'), '2:5,3'));
  test('keyword after a decimal number', async () => assert.equal(await sel('n > 2.5AND n < 6'), '2:5,3'));
  test('a column name starting with a letter is unchanged', async () => assert.equal(await sel('n = 12'), '1:12,0'));
});
