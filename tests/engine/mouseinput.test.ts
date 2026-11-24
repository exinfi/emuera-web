import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { out } from '../helpers.ts';

// Source: EM+EE MainWindow.MouseUp. A click that answers a mouse-flagged INPUT(S) sets RESULT:1 (1 left, 2 right, 3 middle), RESULT:2 (modifier bits) and RESULTS:1 (the clicked button's text).
// Test input: "@label" a left click, "@@label" a right click on that button, "@@" a right click on no button.
const show = '<%RESULTS%><{RESULT}><{RESULT:1}><{RESULT:2}><%RESULTS:1%>';
const game = (cmd: string) => ['@SYSTEM_TITLE', 'PRINTBUTTON "[Go]", 77', 'PRINTL', cmd, `PRINTFORML ${show}`, 'QUIT'];

describe('mouse input fills RESULT:1, RESULT:2, RESULTS:1', () => {
  test('left click on a button', async () => {
    assert.deepEqual((await out(game('INPUTS , 1'), { inputs: ['@Go'] })).slice(-1), ['<77><0><1><0><77>']);
  });
  test('right click on a button', async () => {
    assert.deepEqual((await out(game('INPUTS , 1'), { inputs: ['@@Go'] })).slice(-1), ['<77><0><2><0><77>']);
  });
  test('right click on no button: RESULTS empty, RESULT:1 = 2', async () => {
    assert.deepEqual((await out(game('INPUTS , 1'), { inputs: ['@@'] })).slice(-1), ['<><0><2><0><>']);
  });
  test('integer INPUT with the mouse flag', async () => {
    assert.deepEqual((await out(game('INPUT , 1'), { inputs: ['@@Go'] })).slice(-1), ['<><77><2><0><>']);
  });
  test('typed text leaves them alone', async () => {
    assert.deepEqual((await out(game('INPUTS , 1'), { inputs: ['5'] })).slice(-1), ['<5><0><0><0><>']);
  });
  test('no mouse flag: a click does not set them', async () => {
    assert.deepEqual((await out(game('INPUTS'), { inputs: ['@@Go'] })).slice(-1), ['<77><0><0><0><>']);
  });
});

// a typical option popup loop (WHILE 1, INPUTS with the mouse flag): clicks other than an option button are swallowed, a left click on [OPTION:n] ends it
describe('option popup loop', () => {
  const popup = [
    '@SYSTEM_TITLE',
    'PRINTBUTTON "[A]", "[OPTION:3]"',
    'PRINTBUTTON "[X]", "stray"',
    'PRINTL',
    'VARI N = 0',
    'WHILE 1',
    '  INPUTS , 1',
    '  VARI B = RESULT:1',
    '  IF RESULTS == ""',
    '    BREAK',
    '  ENDIF',
    '  IF B == 1 && STRCOUNT(RESULTS, "OPTION") > 0',
    '    N = 1',
    '    BREAK',
    '  ELSEIF B == 2',
    '    BREAK',
    '  ENDIF',
    'WEND',
    'PRINTFORML done:{N}:{B}',
    'QUIT',
  ];
  test('a stray click is ignored, then an option click ends it', async () => {
    assert.deepEqual((await out(popup, { inputs: ['@X', '@A'] })).slice(-1), ['done:1:1']);
  });
  test('a right click ends it without choosing', async () => {
    assert.deepEqual((await out(popup, { inputs: ['@X', '@@'] })).slice(-1), ['done:0:2']);
  });
});
