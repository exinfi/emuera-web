import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { GameLoader, NoGameError } from '../../src/host/web/gamezip.ts';
import { scanPack } from '../../src/host/web/packs.ts';
import { classifyDrop } from '../../src/mobile/drop.ts';

/** a zip holding the given files ({ path: text }), as bytes */
async function zip(files: Record<string, string>): Promise<Uint8Array> {
  const z = new JSZip();
  for (const [p, t] of Object.entries(files)) z.file(p, t);
  return z.generateAsync({ type: 'uint8array' });
}

describe('pack structure', () => {
  test('a pack with a standard folder at its top is accepted and its files are counted by kind', async () => {
    const s = await scanPack(await zip({ 'resources/a.png': 'x', 'CSV/x.csv': 'y' }));
    assert.equal(s.root, '');
    assert.equal(s.counts.image, 1);
    assert.equal(s.counts.data, 1);
    assert.equal(s.hasData, true);
    assert.equal(s.hasCode, false);
  });

  test('a pack inside a single wrapper folder is found, and the wrapper is dropped from its paths', async () => {
    const s = await scanPack(await zip({ 'MyPack/ERB/a.ERB': '@A' }));
    assert.equal(s.root, 'MyPack');
    assert.equal(s.hasCode, true);
    assert.deepEqual(
      s.files.map((f) => f.path),
      ['ERB/a.ERB'],
    );
  });

  test('a zip with no standard folder is refused, and the message says how to fix it', async () => {
    await assert.rejects(scanPack(await zip({ 'face.png': 'x', 'body.png': 'x' })), (e: Error) => {
      assert.match(e.message, /none of erb\/, csv\/, resources\/, sound\/, font\/ or dat\//);
      assert.match(e.message, /zip it again/);
      return true;
    });
  });

  test('loose numbered character folders are not taken: they need a resources/ folder like everything else', async () => {
    await assert.rejects(scanPack(await zip({ '25Name/face.png': 'x' })), /none of erb\//);
  });

  test('the refusal names the top-level folders that were found', async () => {
    await assert.rejects(scanPack(await zip({ 'Portraits/face.png': 'x' })), /Portraits/);
  });

  test('pack.txt is read as the description and is not counted as a game file', async () => {
    const s = await scanPack(await zip({ 'resources/a.png': 'x', 'pack.txt': 'Name: Example' }));
    assert.equal(s.info, 'Name: Example');
    assert.equal(s.counts.image, 1);
    assert.equal(s.counts.text, 0);
  });
});

describe('packs merged into a game', () => {
  test('a pack without a standard folder is refused when it is merged, and the message names the pack', async () => {
    const loader = new GameLoader();
    await loader.add({ name: 'game.zip', blob: await zip({ 'ERB/A.ERB': '@A', 'CSV/GameBase.csv': '' }) });
    await assert.rejects(loader.add({ name: 'loose.zip', blob: await zip({ '25Name/face.png': 'x' }) }), (e: Error) => {
      assert.ok(e instanceof NoGameError);
      assert.match(e.message, /Pack "loose\.zip"/);
      assert.match(e.message, /zip it again/);
      return true;
    });
  });

  test('a later source replaces the earlier file at the same path', async () => {
    const loader = new GameLoader();
    await loader.add({ name: 'game.zip', blob: await zip({ 'ERB/A.ERB': 'from the game', 'CSV/GameBase.csv': '' }) });
    await loader.add({ name: 'pack.zip', blob: await zip({ 'ERB/A.ERB': 'from the pack' }) });
    assert.deepEqual(Object.values(loader.files.erb), ['from the pack']);
  });
});

describe('what a dropped zip is taken for', () => {
  const kind = async (files: Record<string, string>) =>
    classifyDrop(Object.assign(Buffer.from(await zip(files)), { name: 'x.zip' }) as unknown as File, async () => []);

  test('a zip with ERB or CSV folders is a game', async () => {
    assert.equal(await kind({ 'ERB/a.ERB': '@A', 'CSV/b.csv': '' }), 'game');
  });

  test('a zip with only resources/, sound/ or font/ folders is a pack', async () => {
    assert.equal(await kind({ 'resources/a.png': 'x' }), 'pack');
    assert.equal(await kind({ 'sound/a.wav': 'x' }), 'pack');
    assert.equal(await kind({ 'font/a.ttf': 'x' }), 'pack');
  });

  test('a zip with no standard folder is not recognised, loose numbered character folders included', async () => {
    assert.equal(await kind({ 'face.png': 'x' }), 'unknown');
    assert.equal(await kind({ '25Name/face.png': 'x' }), 'unknown');
  });

  test('a memory card zip stays a card, even when it holds a dat/ folder', async () => {
    assert.equal(await kind({ 'manifest.json': '{}', 'sav/save01.sav': 'x' }), 'card');
    assert.equal(await kind({ 'manifest.json': '{}', 'dat/notes.txt': 'x' }), 'card');
  });
});
