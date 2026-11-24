import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { out } from '../helpers.ts';

// Source: EM+EE RegexpMatchMethod. REGEXPMATCH(str, pattern, countVar, outArray) puts Regex.GetGroupNumbers().Length in countVar and, for every match, one entry per group
// (group 0 = the whole match) into outArray from index 0, stopping at the array's end. The flag form fills RESULT:1 / RESULTS the same way. It returns the number of matches.
const game = (body: string[]) => ['@SYSTEM_TITLE', ...body, 'QUIT'];

describe('REGEXPMATCH four-argument form', () => {
  test('tag extraction: lookaround pattern, no capture group', async () => {
    const r = await out(
      game([
        '#DIMS TAGS, 10',
        '#DIM GC',
        '#DIM N',
        'N = REGEXPMATCH("{[$JOB:魔術師]} && [$X:y]", "(?<=\\\\[\\\\$).*?(?=\\\\])", GC, TAGS)',
        'PRINTFORML N={N} GC={GC} <%TAGS:0%> <%TAGS:1%> <%TAGS:2%>',
      ]),
    );
    assert.deepEqual(r, ['N=2 GC=1 <JOB:魔術師> <X:y> <>']);
  });
  test('capture groups: one entry per group per match, group 0 first', async () => {
    const r = await out(
      game([
        '#DIMS S, 10',
        '#DIM GC',
        'PRINTFORML {REGEXPMATCH("a1 b2", "([a-z])(\\\\d)", GC, S)} GC={GC} <%S:0%> <%S:1%> <%S:2%> <%S:3%> <%S:4%> <%S:5%>',
      ]),
    );
    assert.deepEqual(r, ['2 GC=3 <a1> <a> <1> <b2> <b> <2>']);
  });
  test('the array is filled only as far as it goes', async () => {
    const r = await out(
      game(['#DIMS S, 2', '#DIM GC', 'PRINTFORML {REGEXPMATCH("a b c", "[a-z]", GC, S)} <%S:0%> <%S:1%>']),
    );
    assert.deepEqual(r, ['3 <a> <b>']);
  });
  test('no match: the count is set, the array is left alone', async () => {
    const r = await out(
      game([
        '#DIMS S, 3',
        '#DIM GC',
        'GC = 9',
        'S:0 = keep',
        'PRINTFORML {REGEXPMATCH("abc", "\\\\d", GC, S)} GC={GC} <%S:0%>',
      ]),
    );
    assert.deepEqual(r, ['0 GC=1 <keep>']);
  });
  test('RESULTS as the output array', async () => {
    const r = await out(
      game(['#DIM GC', 'PRINTFORML {REGEXPMATCH("x-y", "[a-z]", GC, RESULTS)} <%RESULTS:0%> <%RESULTS:1%>']),
    );
    assert.deepEqual(r, ['2 <x> <y>']);
  });
  test('an array passed by reference starts at its own first element', async () => {
    // not through game(): its trailing QUIT would end the game inside @F
    const r = await out([
      '@SYSTEM_TITLE',
      '#DIMS BIG, 10',
      'BIG:0 = pre',
      'CALL F, BIG',
      'PRINTFORML <%BIG:0%> <%BIG:1%> <%BIG:2%>',
      'QUIT',
      '@F(A)',
      '#DIMS REF A, 5',
      '#DIM GC',
      'GC = REGEXPMATCH("p q", "[a-z]", GC, A)',
    ]);
    assert.deepEqual(r, ['<p> <q> <>']);
  });
});

describe('REGEXPMATCH flag form', () => {
  test('RESULT:1 is the group count and RESULTS the matches', async () => {
    const r = await out(
      game([
        'PRINTFORML {REGEXPMATCH("a1 b2", "([a-z])(\\\\d)", 1)} {RESULT:1} <%RESULTS:0%> <%RESULTS:1%> <%RESULTS:3%>',
      ]),
    );
    assert.deepEqual(r, ['2 3 <a1> <a> <b2>']);
  });
  test('the count is reported even when nothing matches', async () => {
    const r = await out(game(['PRINTFORML {REGEXPMATCH("abc", "(\\\\d)", 1)} {RESULT:1}']));
    assert.deepEqual(r, ['0 2']);
  });
});

describe('REGEXPMATCH as a statement', () => {
  test('the statement form fills the variables the same way', async () => {
    const r = await out(
      game([
        '#DIMS S, 10',
        '#DIM GC',
        'REGEXPMATCH "a b", "[a-z]", GC, S',
        'PRINTFORML {RESULT} GC={GC} <%S:0%> <%S:1%>',
      ]),
    );
    assert.deepEqual(r, ['2 GC=1 <a> <b>']);
  });
});
