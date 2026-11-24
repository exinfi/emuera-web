import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { engine } from '../../src/engine/adapter.ts';
import { out, run } from '../helpers.ts';

// Source: string * integer is MultStrInt in both Emuera sources (Expression/OperatorMethod.cs in EM+EE; OperatorMethodManager.cs in Emuera.NET):
// either operand order, a negative count or 10000 or more is an error, an empty string or 0 gives "".
describe('string times integer', () => {
  test('in a run-time expression, both operand orders', async () => {
    assert.deepEqual(
      await out(
        ['LOCAL:0 = 3', 'PRINTFORML [{"ab" * LOCAL}][{LOCAL * "x"}][{"ab" * 0}]'].map((s) =>
          s
            .replace('{"ab" * LOCAL}', '%"ab" * LOCAL:0%')
            .replace('{LOCAL * "x"}', '%LOCAL:0 * "x"%')
            .replace('{"ab" * 0}', '%"ab" * 0%'),
        ),
      ),
      ['[ababab][xxx][]'],
    );
  });
  test('a negative count and 10000 are refused', async () => {
    for (const n of ['-1', '10000']) {
      const r = await run(['LOCAL:0 = ' + n, 'PRINTFORML %"a" * LOCAL:0%', 'PRINTL after']);
      assert.ok(
        r.errors.some((e) => /乗算/.test(e)),
        n + ' ' + r.errors.join('|'),
      );
    }
  });
  test('in a constant: #DIMS CONST (a tooltip header kept as a constant string)', async () => {
    const erh = '#DIMS CONST HEAD = "ab" + " " * 3 + "|"\n';
    assert.deepEqual(await out(['PRINTSL HEAD', 'QUIT'], { erh }), ['ab   |']);
  });
});

describe('SETTEXTBOX and PRINT_RECT', () => {
  test('SETTEXTBOX returns 1 and GETTEXTBOX reads it back', async () => {
    assert.deepEqual(await out(['SETTEXTBOX "hello"', 'PRINTFORML {RESULT}', 'PRINTSL GETTEXTBOX()']), ['1', 'hello']);
  });
  test('SETANIMETIMER accepts int16 max and refuses more', async () => {
    assert.deepEqual(await out(['SETANIMETIMER 1000', 'PRINTL ok']), ['ok']);
    const r = await run(['SETANIMETIMER 40000', 'PRINTL after']);
    assert.ok(r.errors.length > 0);
  });
  test('PRINT_RECT: one value is a width, four are x y w h; the host gets the numbers', async () => {
    const r: any = await engine.runGame(
      { erb: { 'ERB/MAIN.ERB': '@SYSTEM_TITLE\nPRINT_RECT 50\nPRINT_RECT 0, 30, 30, 45\nQUIT' }, csv: {} },
      { inputs: [] } as any,
    );
    assert.deepEqual(r.rects, [
      { v: [50], px: [false] },
      { v: [0, 30, 30, 45], px: [false, false, false, false] },
    ]);
  });
  test('PRINT_RECT with a wrong number of values is an error', async () => {
    const r = await run(['PRINT_RECT 1, 2', 'PRINTL after']);
    assert.ok(r.errors.length > 0);
  });
});

// STRFORM parses its text while the game runs. A CSV name used as an index inside {} must resolve like it does in source text
// (an XML condition such as "{TALENT:CHARA_ID:正妻 == 1 || TALENT:CHARA_ID:妾 == 1}" was refused with "unknown variable '正妻'").
describe('STRFORM with CSV names', () => {
  test('a name as the last index, with a variable as the character index', async () => {
    const csv = { 'CSV/Talent.csv': '0,A,\n161,正妻,;\n162,妾,;', 'CSV/Chara0.csv': '番号,0\n名前,x' };
    const prog = [
      '@SYSTEM_TITLE',
      'ADDCHARA 0',
      'TALENT:0:正妻 = 1',
      'CALL F, 0',
      'QUIT',
      '@F(CID)',
      '#DIM CID',
      `LOCALS '= "{" + "TALENT:CID:正妻 == 1 || TALENT:CID:妾 == 1" + "}"`,
      'PRINTFORML [%STRFORM(LOCALS)%][{TOINT(STRFORM(LOCALS))}]',
    ].join('\n');
    assert.deepEqual(await out(prog, { csv }), ['[1][1]']);
  });
});
