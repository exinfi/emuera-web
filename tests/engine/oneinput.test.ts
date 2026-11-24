import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { out } from '../helpers.ts';

// Source: EmueraConsole.PressEnterKey: `if (inputReq.OneInput && (!Config.AllowLongInputByMouse || !changedByMouse) && inputs.Length > 1) inputs = inputs.Remove(1)`.
// So ONEINPUT/ONEINPUTS keep one character, except a clicked button when the config allows long input by mouse.
// "@label" in a test input is a button click; plain text is typed.
const game = (cmd: string) => [
  '@SYSTEM_TITLE',
  'PRINTBUTTON "[Go]", 9999999',
  'PRINTL',
  cmd,
  'PRINTFORML <%RESULTS%><{RESULT}>',
  'QUIT',
];
const allow = (on: boolean) => ({
  csv: { '_fixed.config': `ONEINPUT系命令でマウスによる2文字以上の入力を許可する:${on ? 'YES' : 'NO'}` },
});

describe('ONEINPUT / ONEINPUTS long values', () => {
  test('option on: a clicked button keeps its whole value', async () => {
    assert.deepEqual((await out(game('ONEINPUTS'), { ...allow(true), inputs: ['@Go'] })).slice(-1), ['<9999999><0>']);
    assert.deepEqual((await out(game('ONEINPUT'), { ...allow(true), inputs: ['@Go'] })).slice(-1), ['<><9999999>']);
  });
  test('option on: typed text is still cut to one character', async () => {
    assert.deepEqual((await out(game('ONEINPUTS'), { ...allow(true), inputs: ['9999999'] })).slice(-1), ['<9><0>']);
    assert.deepEqual((await out(game('ONEINPUT'), { ...allow(true), inputs: ['9999999'] })).slice(-1), ['<><9>']);
  });
  test('option off (the default): a clicked button is cut too', async () => {
    assert.deepEqual((await out(game('ONEINPUTS'), { ...allow(false), inputs: ['@Go'] })).slice(-1), ['<9><0>']);
    assert.deepEqual((await out(game('ONEINPUTS'), { inputs: ['@Go'] })).slice(-1), ['<9><0>']);
  });
});
