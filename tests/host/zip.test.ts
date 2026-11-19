import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { loadThin, readEntryRef, readHeadSync, readEntrySync, crc32 } from '../../src/host/web/zipindex.ts';
import { sniffSize } from '../../src/engine/runtime/imagestore.ts';
import { GameLoader, decodeZipName } from '../../src/host/web/gamezip.ts';

/** a hand-built zip (no library), so name bytes, flags and extra fields are exactly what a test says */
interface E {
  name: Uint8Array | string;
  data: Uint8Array | string;
  deflate?: boolean;
  utf8Flag?: boolean;
  extra?: Uint8Array;
  /** extra field of the local header only (the central one uses `extra`) */
  localExtra?: Uint8Array;
}
const te = new TextEncoder();
const u8 = (x: Uint8Array | string) => (typeof x === 'string' ? te.encode(x) : x);
function build(entries: E[], o: { zip64?: boolean; comment?: string } = {}): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  const push = (...b: (number | Uint8Array)[]) => {
    for (const x of b) typeof x === 'number' ? out.push(x) : out.push(...x);
  };
  const w16 = (n: number) => [n & 255, (n >> 8) & 255];
  const w32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  const w64 = (n: number) => [...w32(n), ...w32(0)];
  const central: number[][] = [];
  for (const e of entries) {
    const name = u8(e.name),
      data = u8(e.data),
      comp = e.deflate ? new Uint8Array(deflateRawSync(data)) : data,
      method = e.deflate ? 8 : 0,
      flags = e.utf8Flag ? 0x0800 : 0,
      off = out.length,
      lx = e.localExtra ?? new Uint8Array(0),
      cx = e.extra ?? new Uint8Array(0);
    push(...w32(0x04034b50), ...w16(20), ...w16(flags), ...w16(method), ...w16(0), ...w16(0x21), ...w32(crc32(data)));
    push(...w32(comp.length), ...w32(data.length), ...w16(name.length), ...w16(lx.length), name, lx, comp);
    central.push([
      ...w32(0x02014b50),
      ...w16(20),
      ...w16(20),
      ...w16(flags),
      ...w16(method),
      ...w16(0),
      ...w16(0x21),
      ...w32(crc32(data)),
      ...w32(comp.length),
      ...w32(data.length),
      ...w16(name.length),
      ...w16(cx.length),
      ...w16(0),
      ...w16(0),
      ...w16(0),
      ...w32(0),
      ...w32(off),
      ...name,
      ...cx,
    ]);
  }
  const cdOff = out.length;
  for (const c of central) push(...c);
  const cdSize = out.length - cdOff;
  const comment = te.encode(o.comment ?? '');
  if (o.zip64) {
    const z64At = out.length;
    push(
      ...w32(0x06064b50),
      ...w64(44),
      ...w16(45),
      ...w16(45),
      ...w32(0),
      ...w32(0),
      ...w64(entries.length),
      ...w64(entries.length),
      ...w64(cdSize),
      ...w64(cdOff),
    );
    push(...w32(0x07064b50), ...w32(0), ...w64(z64At), ...w32(1));
    push(
      ...w32(0x06054b50),
      ...w16(0),
      ...w16(0),
      ...w16(0xffff),
      ...w16(0xffff),
      ...w32(0xffffffff),
      ...w32(0xffffffff),
      ...w16(comment.length),
      comment,
    );
  } else {
    push(
      ...w32(0x06054b50),
      ...w16(0),
      ...w16(0),
      ...w16(entries.length),
      ...w16(entries.length),
      ...w32(cdSize),
      ...w32(cdOff),
      ...w16(comment.length),
      comment,
    );
  }
  return Uint8Array.from(out);
}
const text = (b: ArrayBuffer | Uint8Array) => new TextDecoder().decode(b instanceof Uint8Array ? b : new Uint8Array(b));
/** a PNG header (signature + IHDR): enough for a size sniff */
const png = (w: number, h: number) => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};

describe('thin zip reader', () => {
  test('stored and deflated entries read back, from bytes and from a Blob', async () => {
    const long = 'abcdefghij'.repeat(500);
    const zip = build([
      { name: 'a.txt', data: 'hello' },
      { name: 'dir/b.txt', data: long, deflate: true },
      { name: 'dir/', data: '' },
    ]);
    for (const src of [zip, new Blob([zip])]) {
      const z = await loadThin(src);
      assert.deepEqual(Object.keys(z.files).sort(), ['a.txt', 'dir/', 'dir/b.txt']);
      assert.equal(z.files['dir/'].dir, true);
      assert.equal(z.files['a.txt'].dir, false);
      assert.equal(text(await z.files['a.txt'].async('uint8array')), 'hello');
      assert.equal(await z.files['dir/b.txt'].async('string'), long);
      assert.equal(z.files['dir/b.txt']._data.uncompressedSize, 5000);
    }
  });

  test('a corrupted entry is refused when CRC checking is on', async () => {
    const zip = build([{ name: 'a.txt', data: 'hello' }]);
    zip[30 + 5] ^= 1; // a data byte
    const z = await loadThin(zip, { verifyCrc: true });
    await assert.rejects(z.files['a.txt'].async('string'), /CRC mismatch/);
    const ok = await loadThin(zip);
    assert.equal(await ok.files['a.txt'].async('string'), 'iello'); // not checked by default
  });

  test('names: UTF-8 flag, Unicode Path field, and the loader fallback for Shift_JIS', async () => {
    const sjis = Uint8Array.from([0x93, 0xfa, 0x96, 0x7b, 0x2e, 0x74, 0x78, 0x74]); // 日本.txt in Shift_JIS
    const jp = Uint8Array.from([...te.encode('日本'), ...te.encode('.txt')]);
    const plain = build([{ name: 'ascii.txt', data: '1' }]);
    assert.ok('ascii.txt' in (await loadThin(plain)).files);
    const flagged = build([{ name: jp, data: '1', utf8Flag: true }]);
    assert.ok('日本.txt' in (await loadThin(flagged)).files);
    // no flag, Shift_JIS bytes: the caller's decoder decides
    const old = build([{ name: sjis, data: '1' }]);
    assert.ok('日本.txt' in (await loadThin(old, { decodeFileName: decodeZipName })).files);
    // Unicode Path extra field (0x7075): version 1, CRC32 of the stored name, UTF-8 name
    const upath = te.encode('日本.txt');
    const f = new Uint8Array(5 + upath.length);
    f[0] = 1;
    new DataView(f.buffer).setUint32(1, crc32(sjis), true);
    f.set(upath, 5);
    const field = Uint8Array.from([0x75, 0x70, f.length & 255, f.length >> 8, ...f]);
    const withField = build([{ name: sjis, data: '1', extra: field }]);
    assert.ok('日本.txt' in (await loadThin(withField, { decodeFileName: () => 'WRONG' })).files);
    // the same field with a CRC that does not match the stored name is ignored
    const bad = Uint8Array.from(field);
    bad[5] ^= 1;
    const ignored = build([{ name: sjis, data: '1', extra: bad }]);
    assert.ok('FALLBACK' in (await loadThin(ignored, { decodeFileName: () => 'FALLBACK' })).files);
  });

  test('zip64 end records and an archive comment are handled', async () => {
    const zip = build(
      [
        { name: 'a.txt', data: 'x' },
        { name: 'b.txt', data: 'y', deflate: true },
      ],
      { zip64: true, comment: 'made by a test' },
    );
    const z = await loadThin(zip);
    assert.deepEqual(Object.keys(z.files).sort(), ['a.txt', 'b.txt']);
    assert.equal(await z.files['b.txt'].async('string'), 'y');
    const c = build([{ name: 'a.txt', data: 'x' }], { comment: 'PK\x05\x06 inside a comment' });
    assert.equal(await (await loadThin(c)).files['a.txt'].async('string'), 'x');
  });

  test('not a zip: a clear error', async () => {
    await assert.rejects(loadThin(new Uint8Array(100)), /not a zip/);
    await assert.rejects(loadThin(new Uint8Array(5)), /too small/);
  });

  test('head() gives the start of an entry, stored or deflated', async () => {
    const body = Uint8Array.from({ length: 70000 }, (_, i) => (i * 7 + (i >> 8)) & 255);
    const zip = build([
      { name: 's.bin', data: body },
      { name: 'd.bin', data: body, deflate: true },
    ]);
    const z = await loadThin(new Blob([zip]));
    for (const n of ['s.bin', 'd.bin']) {
      const h = await z.files[n].head(1000);
      assert.equal(h.length, 1000);
      assert.deepEqual(h, body.subarray(0, 1000));
    }
    const small = build([{ name: 'x', data: 'ab', deflate: true }]);
    assert.equal(text(await (await loadThin(small)).files['x'].head(100)), 'ab');
  });

  test('readEntryRef reads one entry from its position alone, including a local extra field longer than the guess', async () => {
    const body = te.encode('0123456789'.repeat(100));
    const zip = build([
      { name: 'a', data: 'first' },
      { name: 'b', data: body, deflate: true, localExtra: new Uint8Array(1000) }, // the local extra is far longer than the central one
      { name: 'c', data: body },
    ]);
    for (const src of [zip, new Blob([zip])]) {
      const z = await loadThin(src);
      assert.equal(text(await readEntryRef(src, z.files['a'].ref)), 'first');
      assert.equal(text(await readEntryRef(src, z.files['b'].ref)), text(body));
      assert.equal(text(await readEntryRef(src, z.files['c'].ref)), text(body));
    }
  });
});

describe('lazy images in the game loader', () => {
  const game = (extra: E[] = []) =>
    build([
      { name: 'ERB/MAIN.ERB', data: '@SYSTEM_TITLE\nQUIT' },
      { name: 'CSV/GameBase.csv', data: 'コード,1' },
      { name: 'resources/a.png', data: png(48, 96) },
      { name: 'resources/b.png', data: png(7, 9), deflate: true },
      ...extra,
    ]);

  test('with lazyImages the images are references with their size, and read back the same bytes', async () => {
    const zip = game();
    const l = new GameLoader(undefined, { lazyImages: true });
    await l.add({ name: 'game.zip', blob: new Blob([zip]) });
    const f = l.finish();
    assert.deepEqual(Object.keys(f.images), []);
    assert.deepEqual(Object.keys(f.imageRefs!).sort(), ['resources/a.png', 'resources/b.png']);
    const a = f.imageRefs!['resources/a.png'];
    assert.equal(a.dim, undefined); // no image bytes are read at load: the size is read when first asked
    assert.equal(a.size, 33);
    assert.equal(a.ext, 'png');
    assert.equal(f.imageRefs!['resources/b.png'].dim, undefined);
    const bytes = new Uint8Array(await readEntryRef(f.imageSources![a.src], a));
    assert.deepEqual(bytes, png(48, 96));
  });

  test('without the option the images are held as before', async () => {
    const l = new GameLoader(undefined, {});
    await l.add({ name: 'game.zip', blob: new Blob([game()]) });
    const f = l.finish();
    assert.deepEqual(Object.keys(f.images).sort(), ['resources/a.png', 'resources/b.png']);
    assert.equal(f.imageRefs, undefined);
    assert.deepEqual(new Uint8Array(f.images['resources/a.png']), png(48, 96));
  });

  test('a pack image replaces the game image of the same path, and each reads from its own zip', async () => {
    const pack = build([
      { name: 'resources/a.png', data: png(10, 20) },
      { name: 'resources/c.png', data: png(3, 4) },
    ]);
    const l = new GameLoader(undefined, { lazyImages: true });
    await l.add({ name: 'game.zip', blob: new Blob([game()]) });
    await l.add({ name: 'pack.zip', blob: new Blob([pack]) });
    const f = l.finish();
    assert.deepEqual(Object.keys(f.imageRefs!).sort(), ['resources/a.png', 'resources/b.png', 'resources/c.png']);
    const a = f.imageRefs!['resources/a.png'];
    assert.equal(a.src, 1);
    assert.deepEqual(new Uint8Array(await readEntryRef(f.imageSources![a.src], a)), png(10, 20));
    const b = f.imageRefs!['resources/b.png'];
    assert.equal(b.src, 0);
  });

  test('an image whose header is cut short: the first bytes give no size and the whole file is read', async () => {
    // a JPEG whose SOF marker comes after 20000 bytes of comment: past the 16 KB header read
    const comment = new Uint8Array(20000);
    const jpeg = Uint8Array.from([
      0xff,
      0xd8,
      0xff,
      0xfe,
      (20002 >> 8) & 255,
      20002 & 255,
      ...comment,
      0xff,
      0xc0,
      0,
      17,
      8,
      0,
      5,
      0,
      6,
      3,
      1,
      0x11,
      0,
      2,
      0x11,
      0,
      3,
      0x11,
      0,
    ]);
    const l = new GameLoader(undefined, { lazyImages: true });
    await l.add({ name: 'g.zip', blob: new Blob([game([{ name: 'resources/j.jpg', data: jpeg }])]) });
    const f = l.finish();
    const r = f.imageRefs!['resources/j.jpg'];
    assert.equal(r.dim, undefined);
    const src = new Uint8Array(await new Blob([game([{ name: 'resources/j.jpg', data: jpeg }])]).arrayBuffer());
    assert.equal(sniffSize(readHeadSync(src, r, 16384)!), undefined);
    assert.deepEqual(sniffSize(readEntrySync(src, r)!), { w: 6, h: 5 });
  });

  test('readHeadSync gives the first bytes of an entry, stored or deflated, without reading the rest', () => {
    const big = Uint8Array.from({ length: 70000 }, (_, i) => (i * 7) & 255);
    const zip = build([
      { name: 'a.bin', data: big },
      { name: 'b.bin', data: big, deflate: true },
      { name: 'p.png', data: png(48, 96), deflate: true },
    ]);
    return loadThin(zip).then(async ({ files }) => {
      for (const n of ['a.bin', 'b.bin']) {
        const h = readHeadSync(zip, files[n].ref, 1000)!;
        assert.deepEqual(h, big.subarray(0, 1000));
        assert.deepEqual(h, await files[n].head(1000));
      }
      assert.deepEqual(sniffSize(readHeadSync(zip, files['p.png'].ref, 16384)!), { w: 48, h: 96 });
      assert.deepEqual(readEntrySync(zip, files['a.bin'].ref), big);
      assert.deepEqual(readEntrySync(zip, files['b.bin'].ref), big);
    });
  });

  test('readHeadSync on a Blob uses FileReaderSync when the worker has it, and says undefined when not', async () => {
    const zip = build([{ name: 'p.png', data: png(48, 96) }]);
    const { files } = await loadThin(zip);
    const blob = { size: zip.length, slice: (s: number, e: number) => ({ s, e }) } as unknown as Blob;
    assert.equal(readHeadSync(blob, files['p.png'].ref, 16384), undefined);
    const g = globalThis as { FileReaderSync?: unknown };
    g.FileReaderSync = class {
      readAsArrayBuffer(b: { s: number; e: number }) {
        return zip.slice(b.s, b.e).buffer;
      }
    };
    try {
      assert.deepEqual(sniffSize(readHeadSync(blob, files['p.png'].ref, 16384)!), { w: 48, h: 96 });
    } finally {
      delete g.FileReaderSync;
    }
  });
});

describe('a file supplied again by a later zip', () => {
  const base = () =>
    build([
      { name: 'ERB/MAIN.ERB', data: '@SYSTEM_TITLE\nQUIT' },
      { name: 'CSV/GameBase.csv', data: 'コード,1' },
      { name: 'resources/a.png', data: png(1, 1) },
      { name: 'resources/keep.png', data: png(5, 5) },
      { name: 'resources/sprites.csv', data: 'old' },
      { name: 'dat/note.txt', data: 'old note' },
    ]);
  // paths that differ only in letter case count as the same file; the later zip wins and the earlier copy is gone
  const pack = () =>
    build([
      { name: 'Resources/A.PNG', data: png(2, 3) },
      { name: 'Resources/Sprites.CSV', data: 'new' },
      { name: 'DAT/Note.txt', data: 'new note' },
      { name: 'resources/b.png', data: png(4, 4) },
    ]);

  for (const lazy of [false, true]) {
    test(`replaces the earlier copy, also across letter case (${lazy ? 'images left in their zips' : 'images held'})`, async () => {
      const l = new GameLoader(undefined, { lazyImages: lazy });
      await l.add({ name: 'game.zip', blob: new Blob([base()]) });
      await l.add({ name: 'pack.zip', blob: new Blob([pack()]) });
      const f = l.finish();
      const imgs = Object.keys(lazy ? f.imageRefs! : f.images);
      assert.deepEqual(imgs.map((k) => k.toLowerCase()).sort(), ['resources/a.png', 'resources/b.png', 'resources/keep.png']);
      assert.equal(imgs.filter((k) => k.toLowerCase() === 'resources/a.png').length, 1);
      assert.ok(imgs.includes('Resources/A.PNG'), 'the later zip supplies the surviving key');
      if (lazy) assert.equal(f.imageRefs!['Resources/A.PNG'].src, 1);
      else assert.deepEqual(new Uint8Array(f.images['Resources/A.PNG']), png(2, 3));
      assert.deepEqual(Object.keys(f.rescsv), ['Resources/Sprites.CSV']);
      assert.equal(f.rescsv['Resources/Sprites.CSV'], 'new');
      assert.deepEqual(Object.keys(f.texts), ['DAT/Note.txt']);
      assert.equal(f.texts['DAT/Note.txt'], 'new note');
    });
  }
});
