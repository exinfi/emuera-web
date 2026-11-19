import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { ImageStore, sniffSize } from '../../src/engine/runtime/imagestore.ts';

const png = (w: number, h: number) => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};
/** a stand-in decoder: the "image" is its header size */
const backend = {
  decode: async (bytes: ArrayBuffer) => {
    const d = sniffSize(new Uint8Array(bytes))!;
    return { width: d.w, height: d.h };
  },
};

describe('image store: images registered by reference', () => {
  test('the size is known without reading, the bytes are read on first use, and a decoded image is kept', async () => {
    const s = new ImageStore();
    s.backend = backend;
    let reads = 0;
    s.addRef('resources/a.png', 'png', 33, { w: 5, h: 6 }, async () => (reads++, png(5, 6).buffer as ArrayBuffer));
    assert.deepEqual(s.dim('resources/a.png'), { w: 5, h: 6 });
    assert.equal(s.has('resources/a.png'), true);
    assert.equal(reads, 0);
    await s.ensure(['resources/a.png']);
    assert.equal(reads, 1);
    assert.equal(s.get('resources/a.png').width, 5);
    await s.ensure(['resources/a.png']);
    assert.equal(reads, 1); // decoded already
  });

  test('encoded bytes past the budget are dropped, least recently used first, and read again when needed', async () => {
    const s = new ImageStore();
    s.backend = backend;
    s.budget = 0; // nothing stays decoded, so every use needs the bytes again
    s.encodedBudget = 66; // room for two 33-byte files
    const reads: Record<string, number> = {};
    for (const n of ['a', 'b', 'c'])
      s.addRef(
        n,
        'png',
        33,
        { w: 1, h: 1 },
        async () => ((reads[n] = (reads[n] ?? 0) + 1), png(1, 1).buffer as ArrayBuffer),
      );
    await s.ensure(['a']);
    await s.ensure(['b']);
    await s.ensure(['c']); // a is the oldest resident: dropped
    assert.equal(s.stats.evictions, 1);
    assert.equal(s.encodedBytes, 66);
    await s.ensure(['b']); // still resident: no read
    assert.equal(reads.b, 1);
    await s.ensure(['a']); // read again
    assert.equal(reads.a, 2);
  });

  test('images added with their bytes are never dropped, and nothing is dropped without a budget', async () => {
    const s = new ImageStore();
    s.backend = backend;
    s.budget = 0;
    s.encodedBudget = 0;
    s.add('k', png(2, 2).buffer as ArrayBuffer, 'png');
    await s.ensure(['k']);
    await s.ensure(['k']);
    assert.equal(s.stats.evictions, 0);
    const t = new ImageStore();
    t.backend = backend;
    t.budget = 0;
    let n = 0;
    t.addRef('x', 'png', 33, undefined, async () => (n++, png(3, 3).buffer as ArrayBuffer));
    await t.ensure(['x']);
    await t.ensure(['x']);
    assert.equal(n, 1); // infinite budget: the file stays
    assert.deepEqual(t.dim('x'), { w: 3, h: 3 }); // no header size was given: learnt on decode
  });

  test('an image that is being asked for now is not dropped by the same call', async () => {
    const s = new ImageStore();
    s.backend = backend;
    s.budget = 0;
    s.encodedBudget = 1; // smaller than one file
    for (const n of ['a', 'b']) s.addRef(n, 'png', 33, { w: 1, h: 1 }, async () => png(1, 1).buffer as ArrayBuffer);
    await s.ensure(['a', 'b']);
    assert.equal(s.stats.loads, 2);
    assert.equal(s.encodedBytes, 66); // both pinned while the call ran; dropped by the next call that needs room
    await s.ensure(['a']);
    assert.ok(s.encodedBytes <= 33 + 33);
  });
  test('a size not given at registration is read by `sniff` the first time it is asked, once', () => {
    const s = new ImageStore();
    let calls = 0;
    s.addRef('a', 'png', 33, undefined, async () => png(5, 6).buffer as ArrayBuffer, () => (calls++, { w: 5, h: 6 }));
    assert.equal(calls, 0);
    assert.deepEqual(s.dim('a'), { w: 5, h: 6 });
    assert.deepEqual(s.dim('a'), { w: 5, h: 6 });
    assert.equal(calls, 1);
    let n = 0;
    s.addRef('b', 'png', 33, undefined, async () => png(1, 1).buffer as ArrayBuffer, () => (n++, undefined));
    assert.equal(s.dim('b'), undefined);
    assert.equal(s.dim('b'), undefined);
    assert.equal(n, 1);
    s.addRef('c', 'png', 33, undefined, async () => png(1, 1).buffer as ArrayBuffer, () => {
      throw new Error('unreadable');
    });
    assert.equal(s.dim('c'), undefined);
    s.addRef('d', 'png', 33, { w: 2, h: 3 }, async () => png(2, 3).buffer as ArrayBuffer, () => {
      throw new Error('not to be called');
    });
    assert.deepEqual(s.dim('d'), { w: 2, h: 3 });
  });
});
