/**
 * Resource images: encoded bytes + header-sniffed sizes always, decoded bitmaps only on demand.
 * The full erablue_resort_en set is 23.6 MB encoded but ~660 MB as decoded RGBA, so decoded images live in a
 * bounded LRU cache. Decoding is async; Gfx queues draw operations that need an image that is not decoded yet
 * and replays them after `ensure()` (see Gfx.flush).
 */
export interface DecodeBackend {
  decode(bytes: ArrayBuffer, ext: string): Promise<any>;
  dispose?(img: any): void;
}

export interface Size {
  w: number;
  h: number;
}

/** read width/height from the file header without decoding pixels; undefined when unrecognised */
export function sniffSize(b: Uint8Array): Size | undefined {
  const u16 = (o: number) => b[o] | (b[o + 1] << 8),
    u16be = (o: number) => (b[o] << 8) | b[o + 1];
  const u32be = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const u32 = (o: number) => ((b[o + 3] << 24) | (b[o + 2] << 16) | (b[o + 1] << 8) | b[o]) >>> 0;
  const tag = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
    return true;
  };
  if (b.length >= 24 && b[0] === 0x89 && tag(1, 'PNG')) return { w: u32be(16), h: u32be(20) };
  if (b.length >= 10 && tag(0, 'GIF8')) return { w: u16(6), h: u16(8) };
  if (b.length >= 26 && tag(0, 'BM')) return { w: u32(18), h: Math.abs(u32(22) | 0) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const m = b[o + 1];
      if (m === 0xff) {
        o++;
        continue;
      }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: u16be(o + 5), w: u16be(o + 7) };
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
        o += 2;
        continue;
      }
      o += 2 + u16be(o + 2);
    }
    return undefined;
  }
  if (b.length >= 30 && tag(0, 'RIFF') && tag(8, 'WEBP')) {
    if (tag(12, 'VP8X'))
      return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (tag(12, 'VP8L')) {
      const v = u32(21);
      return { w: 1 + (v & 0x3fff), h: 1 + ((v >>> 14) & 0x3fff) };
    }
    if (tag(12, 'VP8 ')) return { w: u16(26) & 0x3fff, h: u16(28) & 0x3fff };
  }
  return undefined;
}

export class ImageStore {
  backend?: DecodeBackend;
  /** decoded-pixel budget in bytes (RGBA) */
  budget = 256 * 1024 * 1024;
  private encoded = new Map<string, { bytes: ArrayBuffer; ext: string }>();
  private dims = new Map<string, Size>();
  private cache = new Map<string, any>(); // insertion order = LRU order (oldest first)
  private inflight = new Map<string, Promise<void>>();
  private used = 0;
  failed = new Set<string>();

  /** register an encoded image (path is the lower-case key) */
  add(path: string, bytes: ArrayBuffer, ext: string) {
    this.encoded.set(path, { bytes, ext });
    const sz = sniffSize(new Uint8Array(bytes));
    if (sz) this.dims.set(path, sz);
  }
  /** register an already-decoded image (tests, or hosts that decode eagerly) */
  set(path: string, img: any) {
    this.dims.set(path, { w: img.width, h: img.height });
    this.cache.set(path, img);
    return this;
  }
  /** every stored path (encoded or decoded), lower case as added */
  paths(): string[] {
    return [...new Set([...this.encoded.keys(), ...this.cache.keys()])];
  }
  has(path: string) {
    return this.encoded.has(path) || this.cache.has(path);
  }
  get size() {
    return new Set([...this.encoded.keys(), ...this.cache.keys()]).size;
  }
  /** header size: no decode */
  dim(path: string): Size | undefined {
    return this.dims.get(path);
  }
  /** decoded image if it is in the cache (marks it recently used) */
  get(path: string): any | undefined {
    const v = this.cache.get(path);
    if (v !== undefined) {
      this.cache.delete(path);
      this.cache.set(path, v);
    }
    return v;
  }
  get decodedCount() {
    return this.cache.size;
  }
  get decodedBytes() {
    return this.used;
  }

  private bytesOf(img: any) {
    return (img.width | 0) * (img.height | 0) * 4;
  }

  /** decode the given images (those not cached), then evict least-recently-used ones outside `pin` down to the budget */
  async ensure(paths: Iterable<string>) {
    const pin = new Set<string>();
    const jobs: Promise<void>[] = [];
    for (const p of paths) {
      pin.add(p);
      if (this.cache.has(p)) {
        this.get(p);
        continue;
      }
      const e = this.encoded.get(p);
      if (!e || !this.backend || this.failed.has(p)) continue;
      let job = this.inflight.get(p);
      if (!job) {
        job = this.backend
          .decode(e.bytes, e.ext)
          .then(
            (img) => {
              if (img) {
                this.cache.set(p, img);
                this.used += this.bytesOf(img);
                if (!this.dims.has(p)) this.dims.set(p, { w: img.width, h: img.height });
              } else this.failed.add(p);
            },
            () => {
              this.failed.add(p);
            },
          )
          .finally(() => this.inflight.delete(p));
        this.inflight.set(p, job);
      }
      jobs.push(job);
    }
    await Promise.all(jobs);
    for (const [k, v] of this.cache) {
      if (this.used <= this.budget) break;
      if (pin.has(k) || !this.encoded.has(k)) continue; // never evict pinned images or ones we could not re-decode
      this.cache.delete(k);
      this.used -= this.bytesOf(v);
      this.backend?.dispose?.(v);
    }
  }
}
