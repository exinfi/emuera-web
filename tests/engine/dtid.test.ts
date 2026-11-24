import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { out, run } from '../helpers.ts';

// Source: EM+EE DataTableRowSetMethod. CheckName throws only for the exact name "id"; the column lookup ignores case, so "ID" sets the id column.
const game = (body: string[]) => ['@SYSTEM_TITLE', ...body, 'QUIT'];

describe('DT_ROW_ADD / DT_ROW_SET with the id column spelled "ID"', () => {
  test('an explicit id is stored and returned (a row that shares its id with a row of another table)', async () => {
    const r = await out(
      game([
        'DT_CREATE "A"',
        'DT_COLUMN_ADD "A", "n", "int32"',
        'DT_CREATE "B"',
        'DT_COLUMN_ADD "B", "n", "int32"',
        'LOCAL = DT_ROW_ADD("A", "n", 7)',
        'LOCAL:1 = DT_ROW_ADD("B", "ID", LOCAL)',
        'PRINTFORML {LOCAL} {LOCAL:1} {DT_CELL_GET("B", LOCAL, "n", 1)} {DT_ROW_LENGTH("B")}',
      ]),
    );
    const [a, b, , len] = r[0].split(' ').map(Number);
    assert.equal(a, b);
    assert.equal(len, 1);
  });
  test('"id" in lower case is still refused', async () => {
    const res = await run(game(['DT_CREATE "A"', 'DT_ROW_ADD "A", "id", 5']));
    assert.match(res.errors.join('|'), /id column cannot be edited/);
  });
  test('a repeated id is refused (the column is unique); automatic ids skip past an explicit one', async () => {
    const dup = await run(game(['DT_CREATE "A"', 'DT_ROW_ADD "A", "ID", 5', 'DT_ROW_ADD "A", "ID", 5']));
    assert.match(dup.errors.join('|'), /unique/);
    const r = await out(game(['DT_CREATE "A"', 'DT_ROW_ADD "A", "ID", 5', 'PRINTFORML {DT_ROW_ADD("A") > 5}']));
    assert.deepEqual(r, ['1']);
  });
  test('DT_ROW_SET can renumber a row', async () => {
    const r = await out(
      game([
        'DT_CREATE "A"',
        'DT_COLUMN_ADD "A", "n", "int32"',
        'LOCAL = DT_ROW_ADD("A", "n", 1)',
        'DT_ROW_SET "A", LOCAL, "ID", 42',
        'PRINTFORML {DT_CELL_GET("A", 42, "n", 1)}',
      ]),
    );
    assert.deepEqual(r, ['1']);
  });
});
