import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { engine } from '../../src/engine/adapter.ts';

// Source: EM+EE LoadTextMethod, SaveTextMethod and EnumFilesMethod (Creator.Method.cs).
// Text files the host left in their zip (option "extra file check") are read when the game first asks for them.
// Expected values follow from what the game folder is in Emuera: every file in it exists, LOADTEXT returns its text
// (carriage returns removed), ENUMFILES lists it, and a file the game saved with SAVETEXT replaces the shipped one.
interface Out {
  output: string[];
  errors: string[];
}
const go = async (body: string[], o: Record<string, unknown>): Promise<Out> =>
  (await engine.runGame({ erb: { 'ERB/MAIN.ERB': ['@SYSTEM_TITLE', ...body, 'QUIT'].join('\n') }, csv: {} }, {
    inputs: [],
    ...o,
  } as any)) as unknown as Out;
const shown = (r: Out) => r.output.map((l) => l.trimEnd()).filter(Boolean);
const counted = (texts: Record<string, string>) => {
  const reads: string[] = [];
  const lazy: Record<string, () => string | undefined> = {};
  for (const [k, v] of Object.entries(texts))
    lazy[k] = () => {
      reads.push(k);
      return v;
    };
  return { reads, lazy };
};

describe('text files left in their zip', () => {
  test('LOADTEXT reads the file when asked, once, and strips carriage returns', async () => {
    const { reads, lazy } = counted({ 'data/a.txt': 'one\r\ntwo' });
    const r = await go(
      [
        'PRINTFORML read nothing yet',
        'LOADTEXT "data/a.txt"',
        'PRINTFORML [%RESULTS%]',
        'LOADTEXT "Data/A.TXT"',
        'PRINTFORML [%RESULTS%]',
      ],
      { lazyTextFiles: lazy },
    );
    assert.deepEqual(r.errors, []);
    assert.deepEqual(shown(r), ['read nothing yet', '[one', 'two]', '[one', 'two]']);
    assert.deepEqual(reads, ['data/a.txt'], 'the second ask is served from the cache');
  });
  test('a file that was never asked for is never read', async () => {
    const { reads, lazy } = counted({ 'data/a.txt': 'A', 'data/b.txt': 'B' });
    await go(['LOADTEXT "data/b.txt"'], { lazyTextFiles: lazy });
    assert.deepEqual(reads, ['data/b.txt']);
  });
  test('EXISTFILE and ENUMFILES see it without reading it', async () => {
    const { reads, lazy } = counted({ 'data/a.txt': 'A', 'data/b.txt': 'B' });
    const r = await go(
      ['PRINTFORML {EXISTFILE("data/a.txt")} {EXISTFILE("data/zzz.txt")}', 'PRINTFORML {ENUMFILES("data", "*.txt")}'],
      { lazyTextFiles: lazy },
    );
    assert.deepEqual(r.errors, []);
    assert.deepEqual(shown(r), ['1 0', '2']);
    assert.deepEqual(reads, []);
  });
  test('the cache keeps recent files and reads a dropped one again', async () => {
    const { reads, lazy } = counted({ 'a.txt': 'aaaaaa', 'b.txt': 'bbbbbb', 'c.txt': 'cccccc' });
    // room for two files of six characters
    await go(
      [
        'LOADTEXT "a.txt"',
        'LOADTEXT "b.txt"',
        'LOADTEXT "b.txt"',
        'LOADTEXT "c.txt"',
        'LOADTEXT "b.txt"',
        'LOADTEXT "a.txt"',
      ],
      { lazyTextFiles: lazy, textCacheBudget: 12 },
    );
    // a, b read; b hit; c read and a (oldest) dropped; b hit; a read again (and c, now oldest, dropped)
    assert.deepEqual(reads, ['a.txt', 'b.txt', 'c.txt', 'a.txt']);
  });
  test('a file the game saves over it wins, and the reader is not used', async () => {
    const { reads, lazy } = counted({ 'a.txt': 'shipped' });
    const r = await go(['SAVETEXT "mine", "a.txt"', 'LOADTEXT "a.txt"', 'PRINTFORML [%RESULTS%]'], {
      lazyTextFiles: lazy,
    });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(shown(r), ['[mine]']);
    assert.deepEqual(reads, []);
  });
  test('a file that cannot be read gives an empty text and the game carries on', async () => {
    const r = await go(['LOADTEXT "a.txt"', 'PRINTFORML [%RESULTS%]', 'PRINTL still running'], {
      lazyTextFiles: { 'a.txt': () => undefined },
    });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(shown(r), ['[]', 'still running']);
  });
  test('held files and lazy files can be mixed', async () => {
    const { lazy } = counted({ 'b.txt': 'lazy' });
    const r = await go(['LOADTEXT "a.txt"', 'PRINTFORML %RESULTS%', 'LOADTEXT "b.txt"', 'PRINTFORML %RESULTS%'], {
      textFiles: { 'a.txt': 'held' },
      lazyTextFiles: lazy,
    });
    assert.deepEqual(shown(r), ['held', 'lazy']);
  });
});
