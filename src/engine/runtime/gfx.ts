/**
 * Graphics core: G* surfaces, sprites (resource CSVs, SPRITECREATE, animations) and the client background (CBG).
 * Pure logic; pixels go through an injected canvas factory (OffscreenCanvas in the worker, nothing in node tests).
 */
export interface Canvas2D {
  width: number;
  height: number;
  getContext(kind: '2d'): any;
}
export interface Bitmap {
  width: number;
  height: number;
}
export interface GfxBackend {
  makeCanvas(w: number, h: number): Canvas2D;
}

export const argbToCss = (c: number) => {
  const u = c >>> 0;
  const a = (u >>> 24) / 255;
  return `rgba(${(u >>> 16) & 255},${(u >>> 8) & 255},${u & 255},${a})`;
};

export interface Surface {
  id: number;
  w: number;
  h: number;
  canvas?: Canvas2D;
  ctx?: any;
  brush: number;
  pen: number;
  penW: number;
  font: string;
  fontSize: number;
  fontStyle: number;
  version: number;
  /** pen dash style / cap as .NET DashStyle / DashCap numbers (GDASHSTYLE) */
  dash?: number;
  cap?: number;
  /** accumulated GDI+ world transform [a,b,c,d,e,f] left behind by GDRAWGWITHROTATE; it applies to every later draw on the surface */
  xform?: number[];
}
export interface Frame {
  src: string | number;
  kind: 'file' | 'g';
  x: number;
  y: number;
  w: number;
  h: number;
  ox: number;
  oy: number;
  delay: number;
}
const PIN = '\u0001';
export interface Sprite {
  /** SPRITEDISPOSE was called on this very sprite (ASprite.Dispose): printed images that hold it stop drawing */
  disposed?: boolean;
  name: string;
  kind: 'file' | 'g' | 'anime';
  /** resource file path (lower-case key into Gfx.images) or surface id */
  file?: string;
  g?: number;
  x: number;
  y: number;
  w: number;
  h: number;
  frames?: Frame[];
  /** ASprite.DestBasePosition (SPRITEMOVE / SPRITESETPOS) */
  px?: number;
  py?: number;
  /** destination size (animation canvas) */
  dw?: number;
  dh?: number;
  version: number;
}
export interface CbgLayer {
  kind: 'g' | 'sprite';
  ref: string | number;
  x: number;
  y: number;
  z: number;
}
export interface CbgButton {
  index: number;
  normal: string;
  hover: string;
  x: number;
  y: number;
  z: number;
  tooltip?: string;
}

import { ImageStore } from './imagestore';
import { splitLines } from '../util/lines';
import { parseFixInfo, type FixInfo } from './fixedimg';

export class Gfx {
  backend?: GfxBackend;
  /** decoded resource images keyed by lower-case path (e.g. "resources/era.webp") */
  images = new ImageStore();
  /** draw operations waiting for an image to be decoded; replayed in order by flush() */
  private queue: { run: () => void; needs: string[] }[] = [];
  surfaces = new Map<number, Surface>();
  sprites = new Map<string, Sprite>();
  resourceSprites = new Map<string, Sprite>();
  cbg: CbgLayer[] = [];
  cbgButtons: CbgButton[] = [];
  cbgMapG = -1;
  version = 0;
  warnings: string[] = [];
  /** text colour used as default brush/pen */
  defaultColor = 0xffffffff;
  /** maps a requested font name to the registered family (set by the host when fonts are registered) */
  resolveFont: (name: string) => string = (n) => n;
  /** families tried after the requested one (the host passes its bundled metric-compatible font); empty = none */
  fallbackFonts: string[] = [];

  private bump() {
    this.version++;
  }

  /** run now when nothing is queued and every needed image is decoded; otherwise queue it behind earlier ops */
  private exec(needs: string[], run: () => void) {
    if (!this.backend) {
      run();
      return;
    }
    if (!this.queue.length && needs.every((p) => this.images.get(p) !== undefined || this.images.failed.has(p))) {
      run();
      return;
    }
    this.queue.push({ run, needs });
  }
  get pendingOps() {
    return this.queue.length;
  }
  /** decode what the queued draws need, then replay them in their original order */
  async flush() {
    while (this.queue.length) {
      const ops = this.queue;
      this.queue = [];
      await this.images.ensure(ops.flatMap((o) => o.needs));
      for (const o of ops) o.run();
    }
  }
  /** make every image the given sprites are drawn from decodable synchronously (call before renderSprite) */
  async prepare(names: Iterable<string>) {
    const files = new Set<string>();
    for (const n of names) {
      const sp = this.sprites.get(n.toUpperCase());
      if (!sp) continue;
      if (sp.kind === 'file' && sp.file) files.add(sp.file);
      else if (sp.kind === 'anime') {
        for (const f of sp.frames ?? []) if (f.kind === 'file') files.add(f.src as string);
      }
    }
    await this.flush();
    await this.images.ensure(files);
  }
  /** runs a draw with the surface's accumulated world transform (GDI+ keeps it on the Graphics object) */
  private withX(s: Surface, draw: (ctx: any) => void) {
    if (!s.ctx) return;
    if (!s.xform) {
      draw(s.ctx);
      return;
    }
    s.ctx.save();
    s.ctx.setTransform(...(s.xform as [number, number, number, number, number, number]));
    draw(s.ctx);
    s.ctx.restore();
  }
  private style(s: Surface) {
    return { brush: s.brush, pen: s.pen, penW: s.penW, font: s.font, fontSize: s.fontSize, fontStyle: s.fontStyle };
  }

  // ------------------------------------------------------------ resources --
  imageSize(path: string): { w: number; h: number } | undefined {
    const d = this.images.dim(path.toLowerCase());
    return d ? { w: d.w, h: d.h } : undefined;
  }
  /**
   * Profile 'puchi' only (PuchiEmuera, eraSumireTeru). PuchiEmuera's AppContents registers every image under resources/ in ONE dictionary keyed by upper-cased file name
   * (png recursively), so a resource CSV row finds its image whatever subfolder it sits in; stock EM+EE and Emuera.NET build the path as CSV folder + file name. When set, a
   * row whose folder + name is not found falls back to the file name alone. The exact path still wins; for two files of the same name the first one found is used (how PuchiEmuera
   * treats duplicates is not known). Off by default, so every other game resolves images exactly as before.
   */
  imageLookupByName = false;
  /** Profile 'puchi' only: a resource CSV row with FIXED in its 7th column is a fixed image (engine/runtime/fixedimg.ts); this maps its sprite name to the parsed 8th column */
  /** profile 'puchi': names of the resource CSV rows dropped because their image file does not exist (see loadResourceCsv) */
  droppedRows: string[] = [];
  fixedEnabled = false;
  fixedInfo = new Map<string, FixInfo>();
  private byName?: Map<string, string>;
  private findByName(file: string): string | undefined {
    if (!this.byName) {
      this.byName = new Map();
      for (const p of this.images.paths().sort()) {
        if (!p.startsWith('resources/')) continue;
        const b = p.slice(p.lastIndexOf('/') + 1);
        if (!this.byName.has(b)) this.byName.set(b, p);
      }
    }
    const f = file.replace(/\\/g, '/').toLowerCase();
    return this.byName.get(f.slice(f.lastIndexOf('/') + 1));
  }
  /** parse one resource CSV (dir = folder of the csv, with trailing slash) */
  loadResourceCsv(text: string, dir: string) {
    let anime: Sprite | null = null;
    for (const raw of splitLines(text)) {
      const line = raw.trim();
      if (!line || line.startsWith(';')) continue;
      const t = line.split(',');
      if (t.length < 2) continue;
      const name = t[0].trim().toUpperCase(),
        a2 = t[1].trim();
      if (!name || !a2) continue;
      if (a2.toUpperCase() === 'ANIME') {
        const w = parseInt(t[2]),
          h = parseInt(t[3]);
        if (!(w > 0 && h > 0)) continue;
        anime = { name, kind: 'anime', x: 0, y: 0, w, h, dw: w, dh: h, frames: [], version: 0 };
        this.resourceSprites.set(name, anime);
        continue;
      }
      let path = (dir + a2).toLowerCase();
      if (this.imageLookupByName && !this.images.has(path)) path = this.findByName(a2) ?? path;
      const sz = this.imageSize(path);
      if (!sz) {
        // PuchiEmuera drops such a row without a word (AppContents), and eraSumireTeru ships a few (old file names); the host reports them as one note instead of a warning each
        if (this.imageLookupByName) this.droppedRows.push(name);
        else this.warnings.push(`resource image not found: ${dir + a2} (${name})`);
        continue;
      }
      let x = 0,
        y = 0,
        w = sz.w,
        h = sz.h,
        ox = 0,
        oy = 0,
        delay = 1000,
        dw = 0,
        dh = 0;
      if (t.length >= 6) {
        const n = [2, 3, 4, 5].map((i) => parseInt(t[i]));
        if (n.every((v) => !Number.isNaN(v))) {
          [x, y, w, h] = n;
          dw = w;
          dh = h;
        }
        if (t.length >= 8) {
          const p = [6, 7].map((i) => parseInt(t[i]));
          if (p.every((v) => !Number.isNaN(v))) {
            ox = p[0];
            oy = p[1];
          }
        }
        if (t.length >= 9) {
          const d = parseInt(t[8]);
          if (!Number.isNaN(d) && d > 0) delay = d;
        }
        if (t.length >= 11) {
          const s = [9, 10].map((i) => parseInt(t[i]));
          if (s.every((v) => !Number.isNaN(v))) {
            dw = s[0];
            dh = s[1];
          }
        }
      }
      if (this.fixedEnabled && t.length >= 7 && t[6].trim().toUpperCase() === 'FIXED')
        this.fixedInfo.set(name, parseFixInfo(t[7] ?? ''));
      if (anime && anime.name === name) {
        anime.frames!.push({ kind: 'file', src: path, x, y, w, h, ox, oy, delay });
        continue;
      }
      anime = null;
      this.resourceSprites.set(name, {
        name,
        kind: 'file',
        file: path,
        x,
        y,
        w: dw || w,
        h: dh || h,
        version: 0,
        dw: dw || w,
        dh: dh || h,
        frames: undefined,
      });
      const sp = this.resourceSprites.get(name)!;
      // PATCH: the 7th and 8th columns (posx, posy) are the sprite's DestBasePosition (SpriteF(name, image, rect, pos, size) in AppContents.CreateSpriteF). They were parsed for animation
      // frames only, so a plain sprite lost its offset: SPRITEPOSX/Y read 0 and GDRAWSPRITE put every layer at the canvas origin (AnonTW's composed highres portraits came out as clipped fragments).
      if (ox || oy) {
        sp.px = ox;
        sp.py = oy;
      }
      (sp as any).sx = x;
      (sp as any).sy = y;
      (sp as any).sw = w;
      (sp as any).sh = h;
    }
    for (const [k, v] of this.resourceSprites) if (!this.sprites.has(k)) this.sprites.set(k, v);
  }

  // ------------------------------------------------------------- surfaces --
  private newSurface(id: number, w: number, h: number): Surface {
    const s: Surface = {
      id,
      w,
      h,
      brush: this.defaultColor,
      pen: this.defaultColor,
      penW: 1,
      font: 'sans-serif',
      fontSize: 16,
      fontStyle: 0,
      version: 0,
    };
    if (this.backend) {
      s.canvas = this.backend.makeCanvas(w, h);
      s.ctx = s.canvas.getContext('2d');
    }
    this.surfaces.set(id, s);
    this.bump();
    return s;
  }
  create(id: number, w: number, h: number): number {
    if (id < 0 || w < 1 || h < 1 || w > 8192 || h > 8192) throw new Error('GCREATE: argument out of range');
    if (this.surfaces.has(id)) return 0;
    this.newSurface(id, w, h);
    return 1;
  }
  createFromFile(id: number, path: string): number {
    if (this.surfaces.has(id)) return 0;
    const key = this.findImage(path);
    if (!key) {
      this.warnings.push(`GCREATEFROMFILE: file not found: ${path}`);
      return 0;
    }
    const d = this.images.dim(key);
    if (!d) {
      this.warnings.push(`GCREATEFROMFILE: cannot read the size of ${path}`);
      return 0;
    }
    const s = this.newSurface(id, d.w, d.h);
    this.exec([key], () => {
      const img = this.images.get(key);
      if (img) s.ctx?.drawImage(img, 0, 0);
      this.touch(s);
    });
    return 1;
  }
  /** resolve a resources-relative path, trying common extensions */
  findImage(path: string): string | undefined {
    const p = path
      .replace(/\\/g, '/')
      .toLowerCase()
      .replace(/^\.?\//, '');
    for (const base of [p, 'resources/' + p]) {
      if (this.images.has(base)) return base;
    }
    return undefined;
  }
  exists(path: string): boolean {
    return !!this.findImage(path);
  }
  dispose(id: number): number {
    const s = this.surfaces.get(id);
    const had = this.surfaces.delete(id);
    if (s) this.exec([], () => this.release(s)); // GraphicsImage.GDispose frees the bitmap at once; queued behind pending draws so they still read it
    if (had) this.bump(); // CBG layers on this id stay in the list: GraphicsImage is one object per id, it draws nothing while disposed and again after GCREATE
    return had ? 1 : 0;
  }
  /** drop a disposed surface's pixels (a printed sprite may still hold the Surface object, as SpriteG holds the GraphicsImage; it draws nothing) */
  private release(s: Surface) {
    const c = s.canvas as any;
    s.canvas = undefined;
    s.ctx = undefined;
    try {
      if (c) {
        c.width = 0;
        c.height = 0;
      }
    } catch {
      /* not resizable */
    }
  }
  private uids = new WeakMap<object, number>();
  private uidSeq = 0;
  private uid(o: object) {
    let u = this.uids.get(o);
    if (!u) {
      u = ++this.uidSeq;
      this.uids.set(o, u);
    }
    return u;
  }
  /** identity + content version of a surface, for deciding whether a bitmap made from it must be sent again */
  surfaceToken(s?: Surface): string {
    return s ? `${this.uid(s)}.${s.version}.${s.w}x${s.h}` : '-';
  }
  /**
   * Changes whenever what renderSprite(name) would draw can change (the sprite object, its geometry, the surface or images it reads).
   * Lets the worker re-send only sprites that really changed instead of every sprite on screen after any graphics op.
   */
  renderToken(name: string): string {
    const sp = this.sprites.get(name.toUpperCase());
    if (!sp) return '';
    let t = `${this.uid(sp)}.${sp.version}.${sp.disposed ? 1 : 0}.${sp.x},${sp.y},${sp.w},${sp.h}.${sp.dw ?? ''}x${sp.dh ?? ''}.${sp.px ?? 0},${sp.py ?? 0}`;
    if (sp.kind === 'g')
      t += ':' + this.surfaceToken(this.surfaces.get(sp.g!)); // a sprite follows its graphic id (one GraphicsImage per id in Emuera)
    else if (sp.kind === 'file') t += ':' + sp.file;
    else
      t +=
        ':' +
        (sp.frames ?? [])
          .map((f) => (f.kind === 'g' ? this.surfaceToken(this.surfaces.get(f.src as number)) : String(f.src)))
          .join('|');
    return t;
  }
  get(id: number) {
    return this.surfaces.get(id);
  }
  touch(s: Surface) {
    s.version++;
    this.bump();
  }

  drawSprite(id: number, name: string, dx = 0, dy = 0, dw?: number, dh?: number, matrix?: number[]): number {
    const s = this.surfaces.get(id);
    const sp = this.sprites.get(name.toUpperCase());
    if (!s || !this.spriteCreated(sp)) return 0; // GDRAWSPRITE: dest not created, or sprite missing / not created: 0
    // a sprite made from a graphic reads that graphic as it is NOW in script order. The draw may be replayed later (behind a decode), after the script has disposed and recreated the id
    // (erablue's スプライト合成: draw the face sprite into a temp, GDISPOSE 1000, GCREATE 1000, draw the temp back), so bind the surface object at call time, not the id.
    const bound = sp.kind === 'g' ? this.surfaces.get(sp.g!) : undefined;
    const boundOk = sp.kind !== 'g' || !!bound;
    this.exec(sp.kind === 'file' && sp.file ? [sp.file] : [], () => {
      const src =
        sp.kind === 'g'
          ? boundOk && bound?.canvas
            ? { img: bound.canvas, x: sp.x, y: sp.y, w: sp.w, h: sp.h }
            : null
          : this.spriteSource(sp);
      if (src) {
        let w = dw && dw > 0 ? dw : (sp.dw ?? sp.w),
          h = dh && dh > 0 ? dh : (sp.dh ?? sp.h),
          x = dx,
          y = dy;
        const bw = sp.dw ?? sp.w,
          bh = sp.dh ?? sp.h;
        if (sp.px || sp.py) {
          // CroppedImage.GraphicsDraw(destRect): the base position scales with the destination
          x = dx + ((sp.px ?? 0) * w) / bw;
          y = dy + ((sp.py ?? 0) * h) / bh;
          w = (w * src.w) / bw;
          h = (h * src.h) / bh;
        }
        const t =
          matrix && matrix.length === 25 && src.w > 0 && src.h > 0
            ? this.matrixCopy(src.img, src.x, src.y, src.w, src.h, matrix)
            : null;
        if (t) this.withX(s, (c) => c.drawImage(t, 0, 0, src.w, src.h, x, y, w, h));
        else this.withX(s, (c) => c.drawImage(src.img, src.x, src.y, src.w, src.h, x, y, w, h));
      }
      this.touch(s);
    });
    return 1;
  }
  /** `cm` is the optional GDI+ ColorMatrix (25 values, row-major, already divided by 256): GraphicsImage.GDrawG(..., cm) */
  drawG(
    dest: number,
    src: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    cm?: number[],
  ): number {
    const d = this.surfaces.get(dest),
      s = this.surfaces.get(src);
    if (!d || !s) return 0;
    this.exec([], () => {
      if (s.canvas) {
        const t = cm && sw > 0 && sh > 0 ? this.matrixCopy(s.canvas, sx, sy, sw, sh, cm) : null; // a copy first: the source may be the destination
        if (t) this.withX(d, (c) => c.drawImage(t, 0, 0, sw, sh, dx, dy, dw, dh));
        else this.withX(d, (c) => c.drawImage(s.canvas, sx, sy, sw, sh, dx, dy, dw, dh));
      }
      this.touch(d);
    });
    return 1;
  }
  /** a copy of the source rectangle with the colour matrix applied: out = (R, G, B, A, 1) x M per pixel, components 0..1, not premultiplied (GDI+ ColorMatrix) */
  private matrixCopy(src: any, sx: number, sy: number, sw: number, sh: number, cm: number[]): any | null {
    if (!this.backend) return null;
    const w = Math.max(1, Math.round(sw)),
      h = Math.max(1, Math.round(sh));
    const tmp = this.backend.makeCanvas(w, h),
      tc = tmp.getContext('2d');
    tc.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
    const img = tc.getImageData(0, 0, w, h),
      px = img.data;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i] / 255,
        g = px[i + 1] / 255,
        b = px[i + 2] / 255,
        a = px[i + 3] / 255;
      for (let j = 0; j < 4; j++) {
        const v = r * cm[j] + g * cm[5 + j] + b * cm[10 + j] + a * cm[15 + j] + cm[20 + j];
        px[i + j] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
      }
    }
    tc.putImageData(img, 0, 0);
    return tmp;
  }
  drawGWithMask(dest: number, src: number, mask: number, dx: number, dy: number): number {
    const d = this.surfaces.get(dest),
      s = this.surfaces.get(src),
      m = this.surfaces.get(mask);
    if (!d || !s || !m) return 0;
    this.exec([], () => {
      if (d.ctx && s.canvas && m.canvas && this.backend) {
        const tmp = this.backend.makeCanvas(s.w, s.h),
          tc = tmp.getContext('2d');
        tc.drawImage(s.canvas, 0, 0);
        tc.globalCompositeOperation = 'destination-in';
        tc.drawImage(m.canvas, 0, 0, s.w, s.h);
        this.withX(d, (c) => c.drawImage(tmp as any, dx, dy));
      }
      this.touch(d);
    });
    return 1;
  }
  fillRect(id: number, x: number, y: number, w: number, h: number): number {
    const s = this.surfaces.get(id);
    if (!s) return 0;
    const brush = s.brush;
    this.exec([], () => {
      this.withX(s, (c) => {
        c.fillStyle = argbToCss(brush);
        c.fillRect(x, y, w, h);
      });
      this.touch(s);
    });
    return 1;
  }
  clear(id: number, argb: number): number {
    const s = this.surfaces.get(id);
    if (!s) return 0;
    this.exec([], () => {
      if (s.ctx) {
        s.ctx.clearRect(0, 0, s.w, s.h);
        if (argb >>> 24 !== 0) {
          s.ctx.fillStyle = argbToCss(argb);
          s.ctx.fillRect(0, 0, s.w, s.h);
        }
      }
      this.touch(s);
    });
    return 1;
  }
  drawLine(id: number, x1: number, y1: number, x2: number, y2: number): number {
    const s = this.surfaces.get(id);
    if (!s) return 0;
    const pen = s.pen,
      penW = s.penW;
    this.exec([], () => {
      this.withX(s, (c) => {
        c.strokeStyle = argbToCss(pen);
        c.lineWidth = penW;
        this.applyDash(c, s.dash ?? 0, s.cap ?? 0, penW);
        c.beginPath();
        c.moveTo(x1, y1);
        c.lineTo(x2, y2);
        c.stroke();
        c.setLineDash([]);
        c.lineCap = 'butt';
      });
      this.touch(s);
    });
    return 1;
  }
  /** GDI+ dash patterns, in multiples of the pen width: 0 solid, 1 dash, 2 dot, 3 dash-dot, 4 dash-dot-dot */
  private applyDash(c: any, style: number, cap: number, w: number) {
    const pat: Record<number, number[]> = { 1: [3, 1], 2: [1, 1], 3: [3, 1, 1, 1], 4: [3, 1, 1, 1, 1, 1] };
    c.setLineDash((pat[style] ?? []).map((k) => k * w));
    c.lineCap = cap === 2 ? 'round' : cap === 3 ? 'square' : 'butt';
  }
  /** GDASHSTYLE: stored on the pen; invalid enum values throw like .NET */
  setDash(id: number, style: number, cap: number): number {
    const s = this.surfaces.get(id);
    if (!s) return 0;
    if (!(style >= 0 && style <= 5)) throw new Error(`GDASHSTYLE: ${style} is not a valid DashStyle (0-5)`);
    if (![0, 2, 3].includes(cap))
      throw new Error(`GDASHSTYLE: ${cap} is not a valid DashCap (0 flat, 2 round, 3 triangle)`);
    s.dash = style;
    s.cap = cap;
    return 1;
  }
  /** GDRAWGWITHROTATE: append a rotation about (cx,cy) to the destination's world transform, then draw src unscaled at 0,0 */
  drawGWithRotate(dest: number, src: number, angle: number, cx: number | undefined, cy: number | undefined): number {
    const d = this.surfaces.get(dest),
      sf = this.surfaces.get(src);
    if (!d || !sf) return 0;
    const x = cx ?? sf.w / 2,
      y = cy ?? sf.h / 2;
    this.exec([], () => {
      const r = (angle * Math.PI) / 180,
        cs = Math.cos(r),
        sn = Math.sin(r);
      // translate(-x,-y), rotate, translate(x,y), each appended after the existing transform (GDI+ MatrixOrder.Append)
      const m = [cs, sn, -sn, cs, x - cs * x + sn * y, y - sn * x - cs * y];
      const o = d.xform ?? [1, 0, 0, 1, 0, 0];
      d.xform = [
        m[0] * o[0] + m[2] * o[1],
        m[1] * o[0] + m[3] * o[1],
        m[0] * o[2] + m[2] * o[3],
        m[1] * o[2] + m[3] * o[3],
        m[0] * o[4] + m[2] * o[5] + m[4],
        m[1] * o[4] + m[3] * o[5] + m[5],
      ];
      if (sf.canvas) this.withX(d, (c) => c.drawImage(sf.canvas, 0, 0));
      this.touch(d);
    });
    return 1;
  }
  /** SPRITEMOVE / SPRITESETPOS */
  spritePos(name: string, x: number, y: number, move: boolean): number {
    const sp = this.sprites.get(name.toUpperCase());
    if (!sp || !this.spriteCreated(sp)) return 0;
    sp.px = move ? (sp.px ?? 0) + x : x;
    sp.py = move ? (sp.py ?? 0) + y : y;
    sp.version++;
    this.bump();
    return 1;
  }
  private fontCss(s: { font: string; fontSize: number; fontStyle: number }) {
    const st = s.fontStyle;
    // same order as the page's stack (FontRegistry.stack): requested family, bundled fallback, installed MS Gothic, then a CJK sans
    const fb = this.fallbackFonts.map((f) => `"${f}", `).join('');
    return `${st & 2 ? 'italic ' : ''}${st & 1 ? 'bold ' : ''}${s.fontSize}px "${this.resolveFont(s.font)}", ${fb}"MS Gothic", "Noto Sans CJK JP", sans-serif`;
  }
  drawText(id: number, text: string, x = 0, y = 0): number {
    const s = this.surfaces.get(id);
    if (!s) return 0;
    const st = this.style(s); // surface state at call time (the draw may be replayed later)
    this.exec([], () => {
      this.withX(s, (c) => {
        c.font = this.fontCss(st);
        c.textBaseline = 'top';
        // Emuera: fill with the brush, outline with the pen (both default to the text colour)
        c.fillStyle = argbToCss(st.brush);
        c.strokeStyle = argbToCss(st.pen);
        c.lineWidth = st.penW;
        c.lineJoin = 'round';
        c.fillText(text, x, y);
        c.strokeText(text, x, y);
      });
      this.touch(s);
    });
    return 1;
  }
  textSize(text: string, font: string, size: number, style: number): { w: number; h: number } {
    if (this.backend) {
      const c = this.backend.makeCanvas(1, 1).getContext('2d');
      c.font = this.fontCss({ font, fontSize: size, fontStyle: style });
      return { w: Math.ceil(c.measureText(text).width), h: Math.ceil(size * 1.2) };
    }
    return { w: Math.ceil(text.length * size * 0.6), h: Math.ceil(size * 1.2) };
  }
  getColor(id: number, x: number, y: number): number {
    const s = this.surfaces.get(id);
    if (!s || x < 0 || y < 0 || x >= s.w || y >= s.h) return -1;
    if (!s.ctx) return 0;
    if (this.queue.length)
      this.warnings.push(
        'GGETCOLOR/GSETCOLOR read a surface with draws still waiting for image decoding (result may be stale)',
      );
    const d = s.ctx.getImageData(x, y, 1, 1).data;
    return ((d[3] << 24) | (d[0] << 16) | (d[1] << 8) | d[2]) >>> 0;
  }
  setColor(id: number, argb: number, x: number, y: number): number {
    const s = this.surfaces.get(id);
    if (!s) return 0;
    this.exec([], () => {
      if (s.ctx) {
        s.ctx.fillStyle = argbToCss(argb);
        s.ctx.clearRect(x, y, 1, 1);
        s.ctx.fillRect(x, y, 1, 1);
      }
      this.touch(s);
    });
    return 1;
  }

  // -------------------------------------------------------------- sprites --
  /**
   * ConsoleImagePart binds its sprite object when the line is printed. This returns a key that keeps resolving to that object even
   * after the name is disposed / re-created (SPRITEDISPOSEALL only empties the name table). Resource sprites keep their plain name.
   */
  private pins = new WeakMap<object, string>();
  private pinSeq = 0;
  /** the pin keys currently in `sprites` (always a subset of its keys) */
  private pinKeys = new Set<string>();
  pin(name: string, force = false): string {
    const key = name.toUpperCase();
    const sp = this.sprites.get(key);
    if (!sp || (!force && this.resourceSprites.get(key) === sp)) return name;
    let pk = this.pins.get(sp);
    if (!pk) {
      pk = `${PIN}${++this.pinSeq}${PIN}${key}`;
      this.pins.set(sp, pk);
    }
    if (!this.sprites.has(pk)) {
      this.sprites.set(pk, sp);
      this.pinKeys.add(pk);
    } // (re-)pin: a pruned key resolves again if the sprite is printed again
    return pk;
  }
  /**
   * Printed lines hold their sprite objects (ConsoleImagePart.cImage) and the .NET GC frees a sprite once no line references it. Here a line holds a pin key instead,
   * so the host passes the keys its lines (log, pending line, island) still use and every other pin is released.
   */
  prunePins(live: { has(k: string): boolean }): number {
    let n = 0;
    for (const k of this.pinKeys)
      if (!live.has(k)) {
        this.sprites.delete(k);
        this.pinKeys.delete(k);
        n++;
      }
    return n;
  }
  get pinCount() {
    return this.pinKeys.size;
  }
  /** the name a pin key was made from (for messages) */
  static baseName(key: string): string {
    return key.startsWith(PIN) ? key.slice(key.indexOf(PIN, 1) + 1) : key;
  }
  /** per-sprite-name history (create / dispose results) so a "missing sprite" report can say what happened to it */
  trace = new Map<string, string[]>();
  private seq = 0;
  note(key: string, ev: string) {
    const l = this.trace.get(key) ?? [];
    l.push(`#${++this.seq} ${ev}`);
    if (l.length > 6) l.shift();
    this.trace.set(key, l);
    if (this.trace.size > 3000) this.trace.delete(this.trace.keys().next().value as string); // diagnostics only: keep the newest names
  }
  spriteCreate(name: string, g: number, x?: number, y?: number, w?: number, h?: number): number {
    const key = name.toUpperCase();
    const s = this.surfaces.get(g);
    // SPRITECREATE: an existing sprite that is still created (resource sprites included) makes it fail; a dead one (disposed, or on a graphic that is not created) is replaced
    if (!s || this.spriteCreated(this.sprites.get(key))) {
      this.note(
        key,
        `SPRITECREATE from G${g} failed: ${!s ? `graphic ${g} does not exist` : 'a sprite with that name exists'}`,
      );
      return 0;
    }
    this.note(key, `SPRITECREATE from G${g} ok`);
    const sp: Sprite = { name: key, kind: 'g', g, x: x ?? 0, y: y ?? 0, w: w ?? s.w, h: h ?? s.h, version: 0 };
    sp.dw = sp.w;
    sp.dh = sp.h;
    this.sprites.set(key, sp);
    this.bump();
    return 1;
  }
  animeCreate(name: string, w: number, h: number): number {
    const key = name.toUpperCase();
    if (this.spriteCreated(this.sprites.get(key))) return 0;
    this.sprites.set(key, { name: key, kind: 'anime', x: 0, y: 0, w, h, dw: w, dh: h, frames: [], version: 0 });
    this.bump();
    return 1;
  }
  animeAddFrame(
    name: string,
    g: number,
    x: number,
    y: number,
    w: number,
    h: number,
    ox: number,
    oy: number,
    delay: number,
  ): number {
    const sp = this.sprites.get(name.toUpperCase());
    if (!sp || sp.kind !== 'anime' || !this.surfaces.has(g)) return 0;
    sp.frames!.push({ kind: 'g', src: g, x, y, w, h, ox, oy, delay: delay > 0 ? delay : 1000 });
    sp.version++;
    this.bump();
    return 1;
  }
  spriteDispose(name: string): number {
    const key = name.toUpperCase();
    if (this.resourceSprites.has(key)) return 0;
    const old = this.sprites.get(key);
    if (!this.spriteCreated(old)) {
      this.note(key, `SPRITEDISPOSE found nothing created`);
      return 0;
    } // SpriteDisposeMethod: missing or not created returns 0 and leaves the name table alone
    const had = this.sprites.delete(key);
    if (old) old.disposed = true; // C#: value.Dispose() empties the shared sprite object
    this.note(key, `SPRITEDISPOSE ${had ? 'removed it' : 'found nothing'}`);
    if (had) this.bump();
    return had ? 1 : 0;
  }
  spriteDisposeAll(delResources: boolean): number {
    const n = this.sprites.size - this.pinKeys.size;
    for (const k of this.sprites.keys())
      if (!this.pinKeys.has(k) && (delResources || !this.resourceSprites.has(k)))
        this.note(k, 'SPRITEDISPOSEALL removed it');
    const pinned: [string, Sprite][] = []; // printed images keep their sprite (the name table is all SpriteDisposeAll touches)
    for (const k of this.pinKeys) pinned.push([k, this.sprites.get(k)!]);
    this.sprites = delResources ? new Map() : new Map(this.resourceSprites);
    for (const [k, v] of pinned) this.sprites.set(k, v);
    if (delResources) this.resourceSprites = new Map();
    this.bump();
    return n - (this.sprites.size - pinned.length);
  }
  /** where to read pixels for a plain (non-anime) sprite */
  spriteSource(sp: Sprite): { img: any; x: number; y: number; w: number; h: number } | null {
    if (sp.kind === 'file') {
      const img = this.images.get(sp.file!);
      const a = sp as any;
      return img ? { img, x: a.sx ?? sp.x, y: a.sy ?? sp.y, w: a.sw ?? sp.w, h: a.sh ?? sp.h } : null;
    }
    if (sp.kind === 'g') {
      const s = this.surfaces.get(sp.g!);
      return s?.canvas ? { img: s.canvas, x: sp.x, y: sp.y, w: sp.w, h: sp.h } : null;
    }
    return null;
  }
  /** pixel size of a sprite as shown in text */
  spriteSize(name: string): { w: number; h: number } | undefined {
    const sp = this.sprites.get(name.toUpperCase());
    return sp ? { w: sp.dw ?? sp.w, h: sp.dh ?? sp.h } : undefined;
  }
  /** draws a sprite (frame 0 for animations, or the frame active at time t) into a new canvas */
  renderSprite(name: string, t = 0): Canvas2D | null {
    const sp = this.sprites.get(name.toUpperCase());
    if (!sp || !this.backend || sp.disposed) return null;
    const w = sp.dw ?? sp.w,
      h = sp.dh ?? sp.h;
    const c = this.backend.makeCanvas(Math.max(1, w), Math.max(1, h));
    const ctx = c.getContext('2d');
    if (sp.kind === 'anime') {
      const fr = sp.frames ?? [];
      if (!fr.length) return c;
      const total = fr.reduce((a, f) => a + f.delay, 0);
      let m = total ? t % total : 0,
        f = fr[0];
      for (const x of fr) {
        if (m < x.delay) {
          f = x;
          break;
        }
        m -= x.delay;
      }
      const img = f.kind === 'file' ? this.images.get(f.src as string) : this.surfaces.get(f.src as number)?.canvas;
      if (img) ctx.drawImage(img, f.x, f.y, f.w, f.h, f.ox, f.oy, f.w, f.h);
      return c;
    }
    const src = this.spriteSource(sp);
    if (src) ctx.drawImage(src.img, src.x, src.y, src.w, src.h, sp.px ?? 0, sp.py ?? 0, w, h); // GraphicsDraw(g, offset): offset += DestBasePosition
    return c;
  }
  spriteVersion(name: string): number {
    const sp = this.sprites.get(name.toUpperCase());
    if (!sp) return -1;
    if (sp.kind === 'g') return (this.surfaces.get(sp.g!)?.version ?? 0) + 1;
    return sp.version;
  }
  /** frame table of an animated sprite: the time (ms from the start of the loop) at which each frame begins */
  animeFrames(name: string): { t: number; delay: number }[] | null {
    const sp = this.sprites.get(name.toUpperCase());
    if (!sp || sp.kind !== 'anime' || (sp.frames?.length ?? 0) < 2) return null;
    let t = 0;
    return sp.frames!.map((f) => {
      const r = { t, delay: f.delay };
      t += f.delay;
      return r;
    });
  }
  animeDuration(name: string): number {
    const sp = this.sprites.get(name.toUpperCase());
    return sp?.kind === 'anime' ? (sp.frames ?? []).reduce((a, f) => a + f.delay, 0) : 0;
  }
  spriteGetColor(name: string, x: number, y: number): number {
    const c = this.renderSprite(name);
    const sp = this.liveSprite(name);
    if (!c || !sp || x < 0 || y < 0 || x >= c.width || y >= c.height) return -1;
    const d = c.getContext('2d').getImageData(x, y, 1, 1).data;
    return ((d[3] << 24) | (d[0] << 16) | (d[1] << 8) | d[2]) >>> 0;
  }

  // ------------------------------------------------------------------ CBG --
  /** the sprite under that name when it exists and is created (AppContents.GetSprite + IsCreated), else undefined */
  liveSprite(name: string): Sprite | undefined {
    const sp = this.sprites.get(name.toUpperCase());
    return this.spriteCreated(sp) ? sp : undefined;
  }
  /** ASprite.IsCreated: a disposed sprite, or one on a graphic that is not created now, is not */
  spriteCreated(sp: Sprite | undefined): boolean {
    if (!sp || sp.disposed) return false;
    return sp.kind !== 'g' || this.surfaces.has(sp.g!);
  }
  /** CBG_SetImage / CBG_SetGraphics: the layer holds the sprite OBJECT (ClientBackGroundImage.Img), here as a pin key; a graphic layer follows its id (an anonymous SpriteG on the id's one GraphicsImage) */
  cbgSet(kind: 'g' | 'sprite', ref: string | number, x: number, y: number, z: number): number {
    if (z === 0 || z < -2147483648 || z > 2147483647)
      throw new Error(
        `CBGSET${kind === 'g' ? 'G' : 'SPRITE'}: argument 4 (${z}) is out of range (-2147483648 to 2147483647, not 0)`,
      );
    if (kind === 'g') {
      if (!this.surfaces.has(ref as number)) return 0;
      this.cbg.push({ kind, ref, x, y, z });
    } else {
      const key = String(ref).toUpperCase();
      if (!this.spriteCreated(this.sprites.get(key))) return 0;
      this.cbg.push({ kind, ref: this.pin(key, true), x, y, z });
    }
    this.bump();
    return 1;
  }
  cbgSetButton(
    index: number,
    normal: string,
    hover: string,
    x: number,
    y: number,
    z: number,
    tooltip?: string,
  ): number {
    if (index < 0 || index > 0xffffff) return 0;
    if (z === 0 || z < -2147483648 || z > 2147483647)
      throw new Error(`CBGSETBUTTONSPRITE: argument 6 (${z}) is out of range (-2147483648 to 2147483647, not 0)`);
    const bind = (n: string) => {
      const k = n.toUpperCase();
      return this.sprites.has(k) ? this.pin(k, true) : k;
    }; // a missing sprite is simply not drawn (GetSprite = null)
    this.cbgButtons.push({ index, normal: bind(normal), hover: bind(hover), x, y, z, tooltip });
    this.bump();
    return 1;
  }
  cbgClearButton() {
    this.cbgButtons = [];
    this.cbgMapG = -1;
    this.bump();
    return 1;
  } // CBG_ClearButton also drops the button map
  cbgSetButtonMap(id: number): number {
    if (!this.surfaces.has(id)) return 0;
    this.cbgMapG = id;
    return 1;
  }
  cbgClear() {
    this.cbg = [];
    this.cbgButtons = [];
    this.cbgMapG = -1;
    this.bump();
    return 1;
  }
  cbgRemoveRange(a: number, b: number) {
    if (a > b) return 1; // CBG_ClearRange: zmin > zmax does nothing
    const lo = a,
      hi = b;
    this.cbg = this.cbg.filter((l) => l.z < lo || l.z > hi);
    this.cbgButtons = this.cbgButtons.filter((l) => l.z < lo || l.z > hi);
    this.bump();
    return 1;
  }
}
