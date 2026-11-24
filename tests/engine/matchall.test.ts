import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { out, run } from '../helpers.ts';

// MATCHALL exists only under the Emuera.NET profile (an empty setting.json selects it).
// Expected results are worked out by hand from Emuera.NET's MATCHALL_Instruction (GameProc.Function/FunctionIdentifier.cs) and SP_MATCHALL_ArgumentBuilder (ArgumentParser.cs).
const net = { csv: { 'setting.json': '{}' } };
const show = '{RESULT} {RESULT:1} {RESULT:2} {RESULT:3}';

describe('MATCHALL (Emuera.NET)', () => {
  test('plain 1-D array: every matching index, range [begin,end)', async () => {
    const head = ['@SYSTEM_TITLE', 'FLAG:1 = 5', 'FLAG:3 = 5', 'FLAG:5 = 5'];
    assert.deepEqual(await out([...head, 'MATCHALL FLAG, 5', `PRINTFORML ${show}`, 'QUIT'], net), ['3 1 3 5']);
    assert.deepEqual(await out([...head, 'MATCHALL FLAG, 5, 2, 5', `PRINTFORML ${show}`, 'QUIT'], net), ['1 3 0 0']);
  });
  test('every slot tied for the lowest value (MATCHALL with MINARRAY)', async () => {
    const r = await out(
      ['@SYSTEM_TITLE', 'VARI RATE, 6', 'RATE:0 = 30', 'RATE:1 = 10', 'RATE:2 = 10', 'RATE:3 = 40',
        'MATCHALL RATE, MINARRAY(RATE, 0, 4)', `PRINTFORML ${show}`, 'QUIT'],
      net,
    );
    assert.deepEqual(r, ['2 1 2 0']);
  });
  test('1-D character variable: constant index, scans that slot over the characters', async () => {
    const head = ['@SYSTEM_TITLE', 'ADDVOIDCHARA', 'ADDVOIDCHARA', 'ADDVOIDCHARA', 'CFLAG:0:7 = 1', 'CFLAG:1:7 = 2', 'CFLAG:2:7 = 1'];
    assert.deepEqual(await out([...head, 'MATCHALL CFLAG, 7, 1', `PRINTFORML ${show}`, 'QUIT'], net), ['2 0 2 0']);
    assert.deepEqual(await out([...head, 'MATCHALL CFLAG, 7, 1, 1, 3', `PRINTFORML ${show}`, 'QUIT'], net), ['1 2 0 0']);
    assert.deepEqual(await out([...head, 'MATCHALL CFLAG, 7, 9', `PRINTFORML ${show}`, 'QUIT'], net), ['0 0 0 0']);
  });
  test('character variable without an array: no index argument, string values', async () => {
    const r = await out(
      ['@SYSTEM_TITLE', 'ADDVOIDCHARA', 'ADDVOIDCHARA', 'ADDVOIDCHARA', 'NAME:1 = Bob', 'NAME:2 = Bob',
        'MATCHALL NAME, "Bob"', `PRINTFORML ${show}`, 'QUIT'],
      net,
    );
    assert.deepEqual(r, ['2 1 2 0']);
  });
  test('refusals the original makes', async () => {
    const bad = async (body: string[], needle: string) => {
      const r = await run(['@SYSTEM_TITLE', 'ADDVOIDCHARA', ...body, 'QUIT'], net);
      assert.ok(r.errors.join(' | ').includes(needle), `${body.join(';')} -> ${r.errors.join(' | ')}`);
    };
    await bad(['MATCHALL CFLAG, 1'], 'no value to look for');
    await bad(['MATCHALL CFLAG, LOCAL, 1'], '整数定数');
    await bad(['MATCHALL CFLAG, 7, "x"'], '型が一致しません');
    await bad(['MATCHALL CFLAG, 7, 1, 0, 5'], '変数のサイズを超えています');
    await bad(['MATCHALL CFLAG, 7, 1, 1, 0'], '範囲の指定が不正');
    await bad(['MATCHALL CDFLAG, 1, 2'], '次元が大きすぎます');
    await bad(['MATCHALL CFLAG, 99999, 1'], 'out of range');
  });
});
