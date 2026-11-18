import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { out, run } from '../helpers.ts';

describe('printing and formatting', () => {
  test('PRINTL, PRINTFORML with {expr} and %str%', async () => {
    assert.deepEqual(await out(['PRINTL hello', 'PRINTFORML {1 + 2} and %"x" + "y"%']), ['hello', '3 and xy']);
  });
  test('PRINT without a newline joins the next print', async () => {
    assert.deepEqual(await out(['PRINT a', 'PRINT b', 'PRINTL c']), ['abc']);
  });
  test('{expr, width} pads, left or right', async () => {
    assert.deepEqual(await out('PRINTFORML [{7, 4}] [{7, 4, LEFT}]'), ['[   7] [7   ]']);
  });
});

describe('integer arithmetic', () => {
  test('precedence and parentheses', async () => {
    assert.deepEqual(await out('PRINTFORML {2 + 3 * 4} {(2 + 3) * 4} {2 * 3 % 4}'), ['14 20 2']);
  });
  test('division truncates toward zero and % takes the sign of the left side', async () => {
    assert.deepEqual(await out('PRINTFORML {7 / 2} {-7 / 2} {7 % 3} {-7 % 3}'), ['3 -3 1 -1']);
  });
  test('comparison and logic operators yield 1 or 0', async () => {
    assert.deepEqual(await out('PRINTFORML {1 < 2} {2 < 1} {1 && 0} {1 || 0} {!0}'), ['1 0 0 1 1']);
  });
  test('bit operators and shifts', async () => {
    assert.deepEqual(await out('PRINTFORML {6 & 3} {6 | 3} {6 ^ 3} {1 << 4} {256 >> 2}'), ['2 7 5 16 64']);
  });
});

describe('variables and arrays', () => {
  test('assignment, compound assignment, ++ and --', async () => {
    assert.deepEqual(await out(['A = 5', 'A += 3', 'A *= 2', 'A++', 'A--', 'A -= 1', 'PRINTFORML {A}']), ['15']);
  });
  test('#DIM arrays and #DIMS string variables', async () => {
    const o = await out([
      '@SYSTEM_TITLE',
      '#DIM ARR, 4',
      '#DIMS NAME',
      'ARR:2 = 9',
      'NAME \'= "bob"',
      'PRINTFORML {ARR:2} {ARR:0} %NAME%',
      'QUIT',
    ]);
    assert.deepEqual(o, ['9 0 bob']);
  });
  test('an index past the end is reported as an error', async () => {
    const r = await run(['@SYSTEM_TITLE', '#DIM ARR, 2', 'ARR:5 = 1', 'QUIT']);
    assert.ok(r.errors.length > 0);
  });
});

describe('control flow', () => {
  test('IF / ELSEIF / ELSE', async () => {
    const prog = (n: number) => [
      'A = ' + n,
      'IF A < 0',
      'PRINTL neg',
      'ELSEIF A == 0',
      'PRINTL zero',
      'ELSE',
      'PRINTL pos',
      'ENDIF',
    ];
    assert.deepEqual(await out(prog(-1)), ['neg']);
    assert.deepEqual(await out(prog(0)), ['zero']);
    assert.deepEqual(await out(prog(5)), ['pos']);
  });
  test('SELECTCASE with values, ranges and CASEELSE', async () => {
    const prog = (n: number) => [
      'SELECTCASE ' + n,
      'CASE 1, 2',
      'PRINTL low',
      'CASE 3 TO 5',
      'PRINTL mid',
      'CASEELSE',
      'PRINTL other',
      'ENDSELECT',
    ];
    assert.deepEqual(await out(prog(2)), ['low']);
    assert.deepEqual(await out(prog(4)), ['mid']);
    assert.deepEqual(await out(prog(9)), ['other']);
  });
  test('FOR, REPEAT (COUNT), WHILE and DO/LOOP', async () => {
    assert.deepEqual(await out(['FOR LOCAL, 0, 3', 'PRINTFORM {LOCAL}', 'NEXT']), ['012']);
    assert.deepEqual(await out(['REPEAT 3', 'PRINTFORM {COUNT}', 'REND']), ['012']);
    assert.deepEqual(await out(['A = 0', 'WHILE A < 3', 'A++', 'WEND', 'PRINTFORML {A}']), ['3']);
    assert.deepEqual(await out(['A = 0', 'DO', 'A += 2', 'LOOP A < 5', 'PRINTFORML {A}']), ['6']);
  });
  test('BREAK and CONTINUE inside loops', async () => {
    assert.deepEqual(
      await out([
        'REPEAT 6',
        'IF COUNT == 1',
        'CONTINUE',
        'ENDIF',
        'IF COUNT == 4',
        'BREAK',
        'ENDIF',
        'PRINTFORM {COUNT}',
        'REND',
      ]),
      ['023'],
    );
  });
  test('GOTO to a $label', async () => {
    assert.deepEqual(await out(['GOTO SKIP', 'PRINTL no', '$SKIP', 'PRINTL yes']), ['yes']);
  });
});

describe('functions', () => {
  test('CALL with arguments and RETURN through RESULT', async () => {
    const o = await out([
      '@SYSTEM_TITLE',
      'CALL ADD, 2, 3',
      'PRINTFORML {RESULT}',
      'QUIT',
      '@ADD(ARG, ARG:1)',
      '#FUNCTION',
      'RETURN ARG + ARG:1',
    ]);
    assert.deepEqual(o, ['5']);
  });
  test('an expression function is usable inside an expression, and recursion works', async () => {
    const o = await out([
      '@SYSTEM_TITLE',
      'PRINTFORML {FACT(5)}',
      'QUIT',
      '@FACT(ARG)',
      '#FUNCTION',
      'IF ARG <= 1',
      'RETURN 1',
      'ENDIF',
      'RETURN ARG * FACT(ARG - 1)',
    ]);
    assert.deepEqual(o, ['120']);
  });
  test('RETURN in an expression function evaluates its value once, so nested calls do not clobber it', async () => {
    const o = await out(
      [
        '@SYSTEM_TITLE',
        'PRINTFORML {FACT(5)}',
        'PRINTFORML {BUMP()} {BUMP()} {COUNTER}',
        'QUIT',
        '@FACT(ARG)',
        '#FUNCTION',
        'IF ARG <= 1',
        'RETURN 1',
        'ENDIF',
        'RETURN ARG * FACT(ARG - 1)',
        '@BUMP()',
        '#FUNCTION',
        'COUNTER++',
        'RETURN COUNTER',
      ],
      { erh: '#DIM COUNTER' },
    );
    assert.deepEqual(o, ['120', '1 2 2']);
  });
  test('calling a function that does not exist is reported', async () => {
    const r = await run(['@SYSTEM_TITLE', 'CALL NOPE', 'QUIT']);
    assert.ok(r.errors.length > 0);
  });
});

describe('strings', () => {
  test('length, slicing, case and replace', async () => {
    const o = await out([
      'PRINTFORML {STRLENS("hello")} %SUBSTRING("hello", 1, 3)% %TOUPPER("abc")% %TOLOWER("ABC")%',
      'PRINTFORML %REPLACE("a-b-c", "-", "+")%',
    ]);
    assert.deepEqual(o, ['5 ell ABC abc', 'a+b+c']);
  });
  test('string comparison and concatenation', async () => {
    assert.deepEqual(await out('PRINTFORML {"a" == "a"} {"a" == "b"} %"x" + "y" + "z"%'), ['1 0 xyz']);
  });
  test('TOSTR and TOINT convert between text and numbers', async () => {
    assert.deepEqual(await out('PRINTFORML %TOSTR(42)%! {TOINT("17") + 1}'), ['42! 18']);
  });
});

describe('input', () => {
  test('INPUT reads the scripted answer into RESULT', async () => {
    const r = await run(['INPUT', 'PRINTFORML got {RESULT}'], { inputs: ['42'] });
    assert.deepEqual(r.output.map((l) => l.trim()).filter(Boolean), ['42', 'got 42']);
    assert.equal(r.finished, true);
  });
  test('INPUTS reads text, and a finished script reports finished', async () => {
    const r = await run(['INPUTS', 'PRINTFORML hi %RESULTS%'], { inputs: ['ann'] });
    assert.ok(r.output.some((l) => l.trim() === 'hi ann'));
    assert.equal(r.finished, true);
  });
  test('a script that waits for more input than provided is starved, not finished', async () => {
    const r = await run(['INPUT', 'INPUT', 'PRINTL done'], { inputs: ['1'] });
    assert.equal(r.finished, false);
  });
});

describe('variables survive across the program', () => {
  test('readVars returns the final value of a variable', async () => {
    const r = await run(['FLAG:1 = 3', 'FLAG:2 = FLAG:1 * 2'], { readVars: ['FLAG:1', 'FLAG:2'] });
    assert.equal(r.vars['FLAG:1'], 3);
    assert.equal(r.vars['FLAG:2'], 6);
  });
});
