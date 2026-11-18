/**
 * Screen view (host-web tier): turns `ScreenMsg` into DOM inside a container the shell owns, and answers "which game button is where".
 * What it does NOT do: read the window size, set zoom or fit the container, focus inputs, or attach document-level listeners.
 * The shell lays out the container (use `size`), translates its own pointer/key events into `Client` calls, and feeds `hoverAt`/`hideTip`.
 */
import type { ScreenMsg, ScreenCfg, TooltipCfg, Sprite } from '../protocol';
import { createFixedLayer, type FixedLayer } from './fixedlayer';
import { hex, animTotal, frameAt, tipText, stripTipText, tipLayout, type Bmp } from '../screen';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface ButtonInfo {
  kind: 'text' | 'image' | 'cbg';
  /** what to send to the game: the button's input value (text/image) or the CBG button index */
  value: string;
  /** one rectangle per line fragment, in stage coordinates (natural size, origin top-left of the container, y down); text buttons are clamped to the line height, so stacked lines never overlap */
  rects: Rect[];
  /** at least partly inside the visible container (always true in 'outer' scroll mode: the shell clips) */
  visible: boolean;
}
export interface ScreenViewOptions {
  /** a game button was pressed (text, image or CBG button): the shell sends `value` with `client.submit` */
  onPress(value: string): void;
  /** called on every render, after the natural size and fonts are applied and before layout is measured: the shell sizes/fits the container here */
  onConfig?(size: { w: number; h: number; font: string }): void;
  /** called after every render with the height of the text content (useful when scroll is 'outer') */
  onContentHeight?(h: number): void;
  /** 'inner' (default): the log scrolls inside the container (desktop). 'outer': the log is as tall as its content, the shell scrolls/pans it. */
  scroll?: 'inner' | 'outer';
  /** give the layers the ids stage/out/island/cbgbtn/bgback/bgfront (the desktop page's CSS and tests use them) */
  ids?: boolean;
  /** tooltips on (default true) */
  tooltips?: boolean;
  /** viewport used to place tooltips (default: the window) */
  bounds?(): { w: number; h: number };
  /** CSS font-family list for a requested family name (game config name, SETFONT, tooltip font). Default: the name, then MS Gothic, Noto Sans Mono CJK JP, monospace. The shell's FontRegistry supplies one that knows embedded and imported fonts. */
  fontStack?(family: string, role?: 'default' | 'segment' | 'tooltip'): string;
}
export interface ScreenView {
  readonly root: HTMLElement;
  /** natural size of the game window in stage pixels (from the game's config) */
  readonly size: { w: number; h: number };
  render(m: ScreenMsg): void;
  /** every game button currently on screen */
  buttons(): ButtonInfo[];
  /** the button under a stage point (x right, y down from the container's top-left), or null */
  buttonAt(x: number, y: number): ButtonInfo | null;
  /** the value of the topmost game button under a stage point (same coordinates as `buttonAt`), or '' when there is none. Layered buttons (island boxes over a full-screen catch-all) resolve to the one drawn on top, as a click would. Use it to fill `PointerDown.pointing` when the shell presses without a real DOM pointer event. */
  valueAt(x: number, y: number): string;
  /** the button nearest to a stage point within `reach` stage pixels (distance to the nearest rectangle), or null; ties go to the upper one */
  nearestButton(x: number, y: number, reach: number): { button: ButtonInfo; distance: number } | null;
  /** press a button as if it had been clicked (calls onPress) */
  press(b: ButtonInfo): void;
  contentHeight(): number;
  scrollToEnd(): void;
  /** pointer is over `target` at client coordinates: drives tooltip show/hide */
  hoverAt(target: Element | null, clientX: number, clientY: number): void;
  hideTip(): void;
  /** strip blank lines at the start and end of plain (non-custom) tooltips; presentation only, tooltips the game styles itself (TOOLTIP_*) are shown as written. Default false here; the desktop page turns it on. */
  stripTips: boolean;
  /** keep the DOM of lines that did not change between screens (needs `lineIds` in the message; falls back to a full redraw when a sprite changed or ids are missing). Output is identical either way. Default false here; the desktop page ties it to the interpreter-optimizations checkbox. */
  incremental: boolean;
  /** forget all sprite bitmaps (a new game is loading) */
  clearSprites(): void;
  /** re-apply the font stack to the log (call after the font override or the registered fonts change) */
  refreshFonts(): void;
  dispose(): void;
}

const STYLE_ID = 'emu-screenview-style';
const CSS = `.emu-screen{position:relative}.emu-screen.emu-inner{overflow:hidden}
.emu-screen>canvas.emu-bg{position:absolute;left:0;top:0;pointer-events:none}.emu-screen>.emu-bgfront{z-index:4}.emu-screen>.emu-bgback{z-index:0}
.emu-screen>.emu-out{white-space:pre-wrap;z-index:2;padding:0}.emu-screen.emu-inner>.emu-out{position:absolute;inset:0;overflow-y:auto;overflow-x:hidden}
/* EmueraConsole.OnPaint: the newest line sits on the bottom edge, so a screen shorter than the window piles up above the input box (taller ones scroll as before) */
.emu-screen.emu-inner>.emu-out{display:flex;flex-direction:column}.emu-screen.emu-inner>.emu-out>div{flex:none}.emu-screen.emu-inner>.emu-out>div:first-child{margin-top:auto}.emu-screen.emu-outer>.emu-out{position:relative;overflow:visible}
.emu-screen>.emu-island{position:absolute;inset:0;z-index:3;pointer-events:none;overflow:hidden;white-space:pre-wrap}.emu-screen>.emu-island *{pointer-events:auto}
.emu-screen>.emu-cbgbtn{position:absolute;inset:0;pointer-events:none;z-index:5}.emu-screen canvas.cbgb{position:absolute;pointer-events:auto;cursor:pointer}
.emu-screen canvas.img{vertical-align:text-bottom;pointer-events:none}.emu-screen canvas.imgbtn{cursor:pointer}.emu-screen a.btn,.emu-screen canvas.imgbtn{pointer-events:auto}.emu-screen a.btn{cursor:pointer}`;

export function createScreenView(root: HTMLElement, opts: ScreenViewOptions): ScreenView {
  const doc = root.ownerDocument;
  // A click bubbles from the innermost button to the ones around it (a <button> box whose text is itself a button): only the innermost presses
  const handled = new WeakSet<Event>();
  const fire = (ev: Event, v: string) => {
    if (handled.has(ev)) return;
    handled.add(ev);
    opts.onPress(v);
  };
  if (!doc.getElementById(STYLE_ID)) {
    const s = doc.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    doc.head.appendChild(s);
  }
  const outer = opts.scroll === 'outer',
    tooltipsOn = opts.tooltips !== false;
  const fontStack =
    opts.fontStack ?? ((f: string, _role?: string) => `"${f}", "MS Gothic", "Noto Sans Mono CJK JP", monospace`);
  const bounds = opts.bounds ?? (() => ({ w: window.innerWidth, h: window.innerHeight }));
  root.classList.add('emu-screen', outer ? 'emu-outer' : 'emu-inner');
  root.textContent = '';
  const mk = <T extends HTMLElement>(tag: string, cls: string, id: string): T => {
    const e = doc.createElement(tag) as T;
    e.className = cls;
    if (opts.ids) e.id = id;
    return e;
  };
  const back = mk<HTMLCanvasElement>('canvas', 'bg emu-bg emu-bgback', 'bgback'),
    out = mk<HTMLDivElement>('div', 'emu-out', 'out'),
    front = mk<HTMLCanvasElement>('canvas', 'bg emu-bg emu-bgfront', 'bgfront');
  const btnLayer = mk<HTMLDivElement>('div', 'emu-cbgbtn', 'cbgbtn'),
    island = mk<HTMLDivElement>('div', 'emu-island', 'island');
  root.append(back, out, front, btnLayer, island);

  let cfg: ScreenCfg = { w: 760, h: 480, fontSize: 16, lineHeight: 19, font: 'MS Gothic', fg: 0xc0c0c0, bg: 0 };
  const bitmaps = new Map<string, Bmp>(); // sprite name -> latest bitmap
  const reg = new WeakMap<Element, { kind: ButtonInfo['kind']; value: string }>();

  function drawBmp(c: HTMLCanvasElement | null, b: Bmp | undefined, w: number, h: number) {
    if (!c || !b) return;
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = true;
    g.drawImage(b.bmp, 0, 0, c.width, c.height);
  }

  // ---- animation: Emuera starts a sprite's clock the first time it is drawn and loops over the summed delays
  type Anim = { c: HTMLCanvasElement; key: string; w: number; h: number; last: number };
  let anims: Anim[] = [];
  /** the line nodes currently in `out`, with the id the worker gave each line (-1: never reused) */
  let shown: { id: number; el: HTMLElement }[] = [],
    shownSig = '';
  let cbgAnimKeys: string[] = [],
    cbgLast = '';
  let raf = 0;
  function tick(now: number) {
    raf = 0;
    anims = anims.filter((a) => a.c.isConnected);
    for (const a of anims) {
      const b = bitmaps.get(a.key);
      if (!b?.anim) continue;
      const i = frameAt(b, now);
      if (i === a.last) continue;
      a.last = i;
      drawBmp(a.c, { bmp: b.anim[i].bmp, w: b.w, h: b.h }, a.w, a.h);
    }
    if (cbgAnimKeys.length) {
      const sig = cbgAnimKeys
        .map((k) => {
          const b = bitmaps.get(k);
          return b ? frameAt(b, now) : 0;
        })
        .join(',');
      if (sig !== cbgLast) {
        cbgLast = sig;
        paintCbg(now);
      }
    }
    if (anims.length || cbgAnimKeys.length) raf = requestAnimationFrame(tick);
  }
  function ensureTick() {
    if (!raf && (anims.length || cbgAnimKeys.length)) raf = requestAnimationFrame(tick);
  }

  /** drawn size of an image part (ConsoleImagePart): height defaults to the font size, width keeps the aspect ratio; both are percent of the font size unless in px */
  function imgSize(im: any, b: { w: number; h: number } | undefined): { ww: number; hh: number } | null {
    if (!b) return null;
    const fs = cfg.fontSize;
    const hh = !im.h ? fs : im.hpx ? im.h : (fs * im.h) / 100;
    const ww = !im.w ? (b.w * hh) / b.h : im.wpx ? im.w : (fs * im.w) / 100;
    return { ww, hh };
  }
  /** `<shape type='space'>` width: percent of the font size, or px (ConsoleShapePart) */
  const spaceW = (l: { n: number; px: boolean }) => (l.px ? l.n : (cfg.fontSize * l.n) / 100);
  const measureCtx = document.createElement('canvas').getContext('2d')!;
  /** width of a text run in the font the page will draw it in */
  function textWidth(sg: { f?: string; b?: number; i?: number }, t: string): number {
    measureCtx.font = `${sg.i ? 'italic ' : ''}${sg.b ? 'bold ' : ''}${cfg.fontSize}px ${fontStack(sg.f ?? cfg.font, sg.f ? 'segment' : 'default')}`;
    return measureCtx.measureText(t).width;
  }
  /**
   * One logical line of a <div> split into display rows no wider than the box (PrintStringBuffer.ButtonsToDisplayLines with divWidth):
   * a part that does not fit moves to the next row whole; plain text and a lone button are split at the character that still fits.
   */
  function wrapDivLine(l: any[], width: number): any[][] {
    if (width <= 0) return [l];
    const rows: any[][] = [[]];
    let x = 0;
    const cur = () => rows[rows.length - 1];
    const next = () => {
      rows.push([]);
      x = 0;
    };
    for (const sg of l) {
      if (sg.al || sg.div) {
        cur().push(sg);
        continue;
      }
      if (sg.sp) {
        x += spaceW(sg.sp);
        cur().push(sg);
        continue;
      }
      if (sg.img) {
        const w = imgSize(sg.img, bitmaps.get(sg.img.n))?.ww ?? textWidth({}, `[IMG ${sg.img.alt ?? sg.img.n}]`);
        if (x > 0 && x + w > width) next();
        cur().push(sg);
        x += w;
        continue;
      }
      let t: string = sg.t;
      while (t !== '') {
        const w = textWidth(sg, t);
        if (x + w <= width) {
          cur().push(t === sg.t ? sg : { ...sg, t });
          x += w;
          break;
        }
        if (sg.v !== undefined && x > 0) {
          next();
          continue;
        } // a button is not split while it can still start a fresh row
        const chars = Array.from(t);
        let k = chars.length;
        while (k > 0 && x + textWidth(sg, chars.slice(0, k).join('')) > width) k--;
        if (k === 0) {
          if (x > 0) {
            next();
            continue;
          }
          k = 1;
        } // nothing fits even on an empty row: one character, as the original
        cur().push({ ...sg, t: chars.slice(0, k).join('') });
        next();
        t = chars.slice(k).join('');
      }
    }
    return rows;
  }

  function imgNode(im: any, v: string | undefined): HTMLElement {
    const b = bitmaps.get(im.n);
    const c = document.createElement('canvas');
    c.className = 'img';
    if (!b) {
      const sp = document.createElement('span');
      sp.textContent = `[IMG ${im.alt ?? im.n}]`;
      sp.style.color = '#c66';
      return sp;
    }
    const fs = cfg.fontSize;
    const { ww, hh } = imgSize(im, b)!;
    drawBmp(c, b, ww, hh);
    if (b.anim && v === undefined) {
      const now = performance.now();
      const i = frameAt(b, now);
      if (i) drawBmp(c, { bmp: b.anim[i].bmp, w: b.w, h: b.h }, ww, hh);
      anims.push({ c, key: im.n, w: ww, h: hh, last: i });
    }
    c.style.width = ww + 'px';
    c.style.height = hh + 'px';
    if (im.ypos) c.style.transform = `translateY(${im.ypx ? im.ypos : (fs * im.ypos) / 100}px)`;
    if (v !== undefined) {
      c.classList.add('imgbtn');
      c.dataset.v = v;
      reg.set(c, { kind: 'image', value: v });
      c.onclick = (ev) => fire(ev, v);
      const hb = im.srcb ? bitmaps.get(im.srcb) : undefined;
      if (hb) {
        c.onmouseenter = () => drawBmp(c, hb, ww, hh);
        c.onmouseleave = () => drawBmp(c, b, ww, hh);
      }
    }
    return c;
  }

  // profile 'puchi' only: the fixed-image layer is created when the first screen that carries `fixed` arrives, never for any other game
  let fixedLayer: FixedLayer | null = null;
  const fixedFor = () =>
    (fixedLayer ??= createFixedLayer({
      doc,
      root,
      out,
      edgeTargets: [out, island],
      bitmap: (n) => bitmaps.get(n),
      draw: drawBmp as any,
      cfg: () => cfg,
      ids: opts.ids,
    }));
  let bgList: { key: string; alpha: number }[] = [];
  let cbgLayers: { key: string; x: number; y: number; z: number }[] = [];
  function paintCbg(now: number) {
    for (const c of [back, front]) {
      c.width = cfg.w;
      c.height = cfg.h;
    }
    const bg = back.getContext('2d')!,
      fg = front.getContext('2d')!;
    for (const g of bgList) {
      const b = bitmaps.get(g.key);
      if (!b) continue;
      bg.globalAlpha = g.alpha;
      bg.drawImage(b.bmp, 0, 0, cfg.w, cfg.h);
      bg.globalAlpha = 1;
    } // SETBGIMAGE: stretched over the whole client area, under the text
    for (const l of [...cbgLayers].sort((a, b) => b.z - a.z)) {
      // EmueraConsole.OnPaint walks zdepth downwards: the bigger z is drawn first (further back), text is depth 0, negative z lands in front of the text and the smaller z is on top
      const b = bitmaps.get(l.key);
      if (!b) continue;
      (l.z < 0 ? fg : bg).drawImage(b.anim ? b.anim[frameAt(b, now)].bmp : b.bmp, l.x, l.y + cfg.h - b.h); // EmueraConsole.OnPaint: y is measured from the bottom edge, the image's bottom sits there
    }
  }
  function renderCbg(layers: { key: string; x: number; y: number; z: number }[], buttons: any[]) {
    cbgLayers = layers;
    cbgAnimKeys = layers.filter((l) => bitmaps.get(l.key)?.anim).map((l) => l.key);
    cbgLast = '';
    paintCbg(performance.now());
    btnLayer.textContent = '';
    for (const bt of buttons) {
      const n = bitmaps.get(bt.normal),
        h = bitmaps.get(bt.hover);
      if (!n) continue;
      const c = document.createElement('canvas');
      c.className = 'cbgb';
      c.style.left = bt.x + 'px';
      c.style.top = bt.y + cfg.h - n.h + 'px';
      c.style.zIndex = String(-bt.z); // bottom-anchored like CBG images; the smaller z is on top
      drawBmp(c, n.anim ? { bmp: n.anim[frameAt(n, performance.now())].bmp, w: n.w, h: n.h } : n, n.w, n.h);
      if (bt.tooltip) c.dataset.tip = bt.tooltip;
      if (h) {
        c.onmouseenter = () => drawBmp(c, h, n.w, n.h);
        c.onmouseleave = () => drawBmp(c, n, n.w, n.h);
      }
      reg.set(c, { kind: 'cbg', value: String(bt.index) });
      c.onclick = (ev) => fire(ev, String(bt.index));
      btnLayer.appendChild(c);
    }
  }

  function divNode(dv: any): HTMLElement {
    const fs = cfg.fontSize;
    const px = (l: any) => (l ? (l.px ? l.n : (l.n * fs) / 100) : 0);
    const ph = document.createElement('span');
    ph.style.cssText = 'position:relative;display:inline-block;width:0;height:0;vertical-align:top;pointer-events:none';
    const bx = document.createElement('div');
    const m = dv.box.margin as any[],
      bd = dv.box.border as any[],
      pd = dv.box.padding as any[],
      rd = dv.box.radius as any[];
    const four = (a: any[]) => [0, 1, 2, 3].map((i) => px(a[i]));
    const [mt, mr, mb, ml] = four(m),
      [bt, br, bb, bl] = four(bd),
      [pt, pr, pb, pl] = four(pd);
    const st = bx.style;
    st.position = 'absolute';
    st.boxSizing = 'border-box';
    st.overflow = dv.noclip ? 'visible' : 'hidden';
    st.pointerEvents = 'none';
    st.left = px(dv.x) + ml + 'px';
    st.top = px(dv.y) + mt + 'px';
    // a missing width/height (Emuera.NET <div>) fits the content: the absolute box shrink-wraps its rows
    if (dv.w) st.width = Math.max(0, px(dv.w) - ml - mr) + 'px';
    if (dv.h) st.height = Math.max(0, px(dv.h) - mt - mb) + 'px';
    // EM+EE (EmueraConsole.OnPaint): a <div> that reaches outside its own line (Top < 0 or Bottom > LineHeight, ConsoleButtonString.FilterEscaped) is not drawn with its line.
    // It is drawn afterwards as an "escaped part" by depth: the bigger depth first, so a positive depth goes behind the text, depth 0 lands right after the text (on top of every line, later ones included)
    // and a negative depth in front of that. A box that fits in its line is drawn in line order as before. Emuera.NET boxes (noclip) have no such pass: ConsoleDivElement is drawn with its line.
    // Lines are positioned with z-index auto (layer 0, document order), so the box needs z-index > 0 to sit above all of them and < 0 to sit behind them. (erablue: the clock and the side panel boxes over the rules.)
    const escaped = !dv.noclip && !dv.abs && (px(dv.y) < 0 || px(dv.y) + px(dv.h) > cfg.lineHeight);
    st.zIndex = String(escaped ? (dv.depth > 0 ? -dv.depth : 1 - dv.depth) : dv.depth);
    // display='absolute-lefttop' / 'absolute-leftbottom' (Emuera.NET): x,y are against the window's top-left / bottom-left corner, not the line (ConsoleDivElement.DrawTo); placeAbs() sets the pixel position
    if (dv.abs) {
      st.position = 'fixed';
      bx.dataset.abs = dv.abs;
      bx.dataset.ax = String(px(dv.x) + ml);
      bx.dataset.ay = String(px(dv.y) + mt);
    }
    st.whiteSpace = 'pre';
    // a <div> inside a <button> (Emuera.NET): the whole box is the button. The box lets pointer events through only for this case; the registry entry makes it a target for snapping, keyboard and tap controls like any other button.
    if (dv.v !== undefined) {
      const v: string = dv.v;
      bx.className = 'btn';
      bx.dataset.v = v;
      st.pointerEvents = 'auto';
      st.cursor = 'pointer';
      if (dv.tip) bx.dataset.tip = dv.tip;
      reg.set(bx, { kind: 'image', value: v });
      bx.onclick = (ev) => fire(ev, v);
    }
    if (dv.color !== undefined) st.background = hex(dv.color);
    st.borderStyle = 'solid';
    st.borderWidth = `${bt}px ${br}px ${bb}px ${bl}px`;
    const bc = dv.bcolor as number[] | undefined;
    st.borderColor = bc ? [0, 1, 2, 3].map((i) => hex(bc[i] ?? bc[0])).join(' ') : 'transparent';
    st.padding = `${pt}px ${pr}px ${pb}px ${pl}px`;
    const [r0, r1, r2, r3] = four(rd);
    st.borderRadius = `${r0}px ${r1}px ${r2}px ${r3}px`;
    // the content box: the div's width minus margin, border and padding (HtmlManager SubDivisionWidth)
    const inner = dv.w && !dv.noclip ? px(dv.w) - ml - mr - bl - br - pl - pr : 1e9;
    for (const l of dv.lines)
      for (const row of wrapDivLine(l, inner)) {
        const rn = lineNode(row);
        rn.style.height = cfg.lineHeight + 'px'; // ConsoleDivPart.DrawTo steps Config.LineHeight per child line, whatever the images in it measure
        for (const cv of rn.querySelectorAll('canvas')) (cv as HTMLElement).style.verticalAlign = 'top'; // an image's top edge sits on the row's top (plus its ypos)
        bx.appendChild(rn);
      }
    ph.appendChild(bx);
    return ph;
  }

  function lineNode(
    l: {
      t: string;
      v?: string;
      c?: number;
      img?: any;
      b?: number;
      f?: string;
      i?: number;
      s?: number;
      u?: number;
      tip?: string;
    }[],
    top = false,
  ): HTMLDivElement {
    const d = document.createElement('div');
    // Display lines are drawn top to bottom, so a later line's text paints over an earlier line's image that hangs down (a ypos or tall image).
    // A canvas with a transform is a positioned layer and would otherwise paint over every following in-flow line; making each line positioned
    // (z-index auto, so no stacking context) puts them all in the same document-order layer. (eraRanceK hero CG with its extinction-rate caption.)
    d.style.position = 'relative';
    // A positioned line paints above every earlier line's hanging <div> boxes, so by itself it would take the clicks meant for the buttons in
    // them (erablue's dungeon list is a box followed by 25 blank lines). A screen line lets pointer events through and only its own text
    // segments take them again, so buttons in a box work while the text can still be selected. Rows inside a box keep the box's own rule.
    if (top) d.style.pointerEvents = 'none';
    if (!l.length || (l.length === 1 && (l[0] as any).al)) d.innerHTML = '&nbsp;';
    const posLine = l.some((s: any) => s.pos !== undefined); // <button|nonbutton pos=N>: x is tracked so a locked part can step back or forward to N
    let px0 = 0;
    const widthOf = (s: any): number =>
      s.sp
        ? Math.max(0, spaceW(s.sp))
        : s.img
          ? (imgSize(s.img, bitmaps.get(s.img.n))?.ww ?? 0)
          : s.t
            ? textWidth(s, s.t)
            : 0;
    for (const s of l) {
      if ((s as any).nw) {
        d.style.whiteSpace = 'pre';
        continue;
      } // no wrapping, but runs of spaces stay (a map row starts with the menu column's blanks)
      const lockAt = posLine && (s as any).pos !== undefined ? (s as any).pos - px0 : undefined;
      if (posLine) {
        if (lockAt !== undefined) px0 = (s as any).pos;
        px0 += widthOf(s);
      }
      if ((s as any).al === 'line') {
        d.textContent = s.t.repeat(Math.floor(cfg.w / (cfg.fontSize / 2)));
        d.style.color = '#888';
        d.style.overflow = 'hidden';
        d.style.whiteSpace = 'nowrap';
        continue;
      }
      if ((s as any).al) {
        d.style.textAlign = (s as any).al;
        continue;
      }
      if ((s as any).div) {
        d.appendChild(divNode((s as any).div));
        continue;
      }
      if ((s as any).rc) {
        // ConsoleRectangleShapePart: the part is x+w wide and the rectangle is x,y,w,h from the line's top-left
        const r = (s as any).rc,
          pxl = (l: any) => (l.px ? l.n : (cfg.fontSize * l.n) / 100);
        const g = document.createElement('span');
        g.style.cssText = `display:inline-block;position:relative;vertical-align:top;width:${Math.max(0, spaceW((s as any).sp))}px;height:${cfg.lineHeight}px`;
        const q = document.createElement('span');
        q.style.cssText = `position:absolute;z-index:-1;left:${pxl(r.x)}px;top:${pxl(r.y)}px;width:${pxl(r.w)}px;height:${pxl(r.h)}px;background:${r.c !== undefined && r.c >= 0 ? hex(r.c) : hex(cfg.fg)}`;
        g.appendChild(q);
        d.appendChild(g);
        continue;
      }
      if ((s as any).sp) {
        const g = document.createElement('span');
        g.style.cssText = `display:inline-block;width:${Math.max(0, spaceW((s as any).sp))}px;height:1px`;
        d.appendChild(g);
        continue;
      }
      if (s.img) {
        const n = imgNode(s.img, s.v);
        if (lockAt) n.style.marginLeft = lockAt + 'px';
        d.appendChild(n);
        continue;
      }
      const e = document.createElement(s.v !== undefined ? 'a' : 'span');
      e.textContent = s.t;
      if (top) e.style.pointerEvents = 'auto';
      if (lockAt) e.style.marginLeft = lockAt + 'px';
      if (s.c !== undefined && s.c !== -1) e.style.color = hex(s.c);
      if (s.b) e.style.fontWeight = 'bold';
      if (s.f) {
        e.dataset.f = s.f;
        e.style.fontFamily = fontStack(s.f, 'segment');
      }
      if (s.i) e.style.fontStyle = 'italic';
      if (s.u || s.s)
        e.style.textDecoration = [s.u ? 'underline' : '', s.s ? 'line-through' : ''].filter(Boolean).join(' ');
      if (s.tip) e.dataset.tip = s.tip;
      if (s.v !== undefined) {
        e.className = 'btn';
        const v = s.v;
        e.dataset.v = v;
        reg.set(e, { kind: 'text', value: v });
        e.onclick = (ev) => fire(ev, v);
      }
      d.appendChild(e);
    }
    // A line is Config.LineHeight tall whatever its images measure (EmueraConsole display lines). Only a line holding an image with a ypos is pinned to that, so a portrait can overflow its row upwards; its top edge sits on the row's top plus the ypos.
    // An image taller than the line is an "escaped part" too (ConsoleEscapedParts): it hangs below its row instead of growing the row; later lines' text paints over it (document order), as before for ypos images (eraFGO K portrait: 1056% image + 9 line breaks).
    const tall = (s: any) => {
      if (!s.img || s.img.ypos) return false;
      const b = bitmaps.get(s.img.n);
      return !!b && (imgSize(s.img, b)?.hh ?? 0) > cfg.lineHeight;
    };
    if (l.some((s) => (s.img && (s as any).img.ypos) || tall(s))) {
      d.style.height = cfg.lineHeight + 'px';
      for (const cv of d.querySelectorAll('canvas')) (cv as HTMLElement).style.verticalAlign = 'top';
    }
    return d;
  }

  // ---- tooltips: delay, duration, colors, font and TOOLTIP_IMG come from the game's TOOLTIP_* state
  let tipCfg: {
    custom: boolean;
    font?: string;
    size?: number;
    fg?: number;
    bg?: number;
    delay: number;
    duration: number;
    format: number;
    img: boolean;
  } = { custom: false, delay: 500, duration: 0, format: 0, img: false };
  const tipEl = root.ownerDocument.createElement('div');
  tipEl.style.cssText =
    'position:fixed;z-index:100;display:none;pointer-events:none;white-space:pre;border:1px solid #555;padding:6px 10px;max-width:90vw;overflow:hidden;border-radius:3px;box-shadow:2px 3px 8px #0008;-webkit-font-smoothing:antialiased';
  if (tooltipsOn) root.ownerDocument.body.appendChild(tipEl);
  let tipTimer = 0,
    tipHide = 0,
    tipTarget: Element | null = null,
    tipX = 0,
    tipY = 0;
  function hideTip() {
    clearTimeout(tipTimer);
    clearTimeout(tipHide);
    tipEl.style.display = 'none';
    tipTarget = null;
  }
  function showTip(text: string) {
    tipEl.textContent = '';
    tipEl.style.padding = '6px 10px';
    const id = /^\s*(\d+)\s*$/.exec(text)?.[1],
      bmp = tipCfg.img && id ? bitmaps.get('#T' + id) : undefined;
    if (bmp) {
      const c = document.createElement('canvas');
      drawBmp(c, bmp, bmp.w, bmp.h);
      c.style.display = 'block';
      tipEl.style.padding = '0';
      tipEl.appendChild(c);
    } else {
      const fl = tipCfg.custom ? tipCfg.format : 0; // TOOLTIP_FORMAT only applies to owner-drawn (custom) tooltips
      if (tipCfg.custom) fillTip(tipEl, tipText(text), fl);
      else tipEl.textContent = view.stripTips ? stripTipText(tipText(text)) : tipText(text);
      // padding flags (TextFormatFlags.NoPadding 0x10000000, LeftAndRightPadding 0x20000000) change the margin the text sits in
      const lay = tipLayout(fl);
      if (tipCfg.custom) tipEl.style.padding = lay.padding;
      tipEl.style.textAlign = lay.textAlign;
      tipEl.style.direction = lay.direction;
      tipEl.style.color = hex(tipCfg.fg ?? 0);
      tipEl.style.background = hex(tipCfg.bg ?? 0xffffe1);
      // readable UI font unless the game names one (TOOLTIP_SETFONT); the original's default MS Gothic at 12 pt is hard to read in a browser
      const ui = '"Segoe UI", "Yu Gothic UI", "Meiryo UI", "Noto Sans CJK JP", system-ui, sans-serif';
      tipEl.style.font = tipCfg.custom
        ? `${Math.max(13, ((tipCfg.size ?? cfg.fontSize) * 4) / 3)}px/1.5 ${tipCfg.font ? `${fontStack(tipCfg.font, 'tooltip')}, ` : ''}${ui}`
        : `14px/1.5 ${ui}`;
    }
    tipEl.style.display = 'block';
    const w = tipEl.offsetWidth,
      h = tipEl.offsetHeight; // below the pointer, flipped above when it would leave the window
    tipEl.style.left = Math.max(0, Math.min(tipX + 2, bounds().w - w - 2)) + 'px';
    tipEl.style.top = (tipY + 32 + h > bounds().h ? Math.max(0, tipY - h - 8) : tipY + 32) + 'px';
    if (tipCfg.duration > 0) tipHide = window.setTimeout(hideTip, tipCfg.duration);
  }

  function render(m: ScreenMsg) {
    const lines = m.lines;
    if (m.cfg) cfg = m.cfg;
    if (m.tooltip) tipCfg = m.tooltip;
    hideTip();
    for (const [k, v] of Object.entries(m.sprites ?? {})) {
      const old = bitmaps.get(k);
      old?.bmp.close();
      old?.anim?.forEach((f) => f.bmp.close());
      const nb = v as Bmp;
      if (nb.anim) nb.total = animTotal(nb);
      bitmaps.set(k, nb);
    }
    for (const k of m.drop ?? []) {
      const old = bitmaps.get(k);
      if (!old) continue;
      old.bmp.close();
      old.anim?.forEach((f) => f.bmp.close());
      bitmaps.delete(k);
    } // sprites nothing on screen uses any more
    root.style.width = cfg.w + 'px';
    root.style.background = '#' + cfg.bg.toString(16).padStart(6, '0');
    out.style.isolation = 'isolate';
    out.style.color = '#' + cfg.fg.toString(16).padStart(6, '0');
    out.style.font = `${cfg.fontSize}px/${cfg.lineHeight}px ${fontStack(cfg.font, 'default')}`;
    opts.onConfig?.({ w: cfg.w, h: cfg.h, font: cfg.font });
    const keepBottom = flowMax() - out.scrollTop < 40;
    // Keep the nodes of lines drawn before when the message says they are the same lines (ids) and nothing they show can have changed: no new bitmaps
    // (a re-sent sprite must redraw every line that uses it), same line geometry inputs, and `out` holds exactly the nodes we put there.
    const ids = m.lineIds,
      sig = `${cfg.w}:${cfg.fontSize}:${cfg.lineHeight}`;
    const reuse =
      view.incremental &&
      !!ids &&
      ids.length === lines.length &&
      sig === shownSig &&
      Object.keys(m.sprites ?? {}).length === 0 &&
      out.childElementCount === shown.length;
    if (reuse && ids) {
      let j = 0;
      if (ids.length && ids[0] >= 0) {
        while (j < shown.length && shown[j].id !== ids[0]) j++;
      } else j = shown.length; // no overlap: everything is new
      for (let q = 0; q < j; q++) shown[q].el.remove();
      let p = j,
        i = 0;
      while (i < ids.length && p < shown.length && ids[i] >= 0 && shown[p].id === ids[i]) {
        i++;
        p++;
      }
      for (let q = p; q < shown.length; q++) shown[q].el.remove();
      const keep = shown.slice(j, p),
        add: typeof shown = [];
      const frag = document.createDocumentFragment();
      for (; i < lines.length; i++) {
        const el = lineNode(lines[i], true);
        frag.appendChild(el);
        add.push({ id: ids[i], el });
      }
      out.appendChild(frag);
      shown = [...keep, ...add];
      anims = anims.filter((a) => a.c.isConnected); // animated images of kept lines keep running
    } else {
      out.textContent = '';
      anims = [];
      const frag = document.createDocumentFragment();
      shown = [];
      for (let i = 0; i < lines.length; i++) {
        const el = lineNode(lines[i], true);
        frag.appendChild(el);
        shown.push({ id: ids && ids.length === lines.length ? ids[i] : -1, el });
      }
      out.appendChild(frag);
      shownSig = sig;
    }
    island.textContent = '';
    for (const l of m.island ?? []) island.appendChild(lineNode(l));
    island.style.font = out.style.font;
    island.style.color = out.style.color;
    bgList = m.bgs ?? [];
    if (m.fixed) fixedFor().update(m.fixed);
    renderCbg(m.layers ?? [], m.buttons ?? []);
    ensureTick();
    if (!outer && (keepBottom || m.kind === 'wait')) pinEnd();
    placeAbs();
    opts.onContentHeight?.(contentHeight());
  }
  /** boxes of <div display=absolute-*>: pixel position against the screen box (they are position:fixed so the scrolling log does not move them) */
  function placeAbs() {
    const els = root.querySelectorAll<HTMLElement>('[data-abs]');
    if (!els.length) return;
    const rr = root.getBoundingClientRect(),
      k = rr.width / (cfg.w || rr.width) || 1;
    for (const e of els) {
      const x = Number(e.dataset.ax),
        y = Number(e.dataset.ay);
      e.style.left = rr.left + x * k + 'px';
      e.style.top = (e.dataset.abs === 'lb' ? rr.bottom + y * k : rr.top + y * k) + 'px';
    }
  }
  const onWin = () => placeAbs();
  window.addEventListener('resize', onWin);
  window.addEventListener('scroll', onWin, true);
  const contentHeight = () => (outer ? out.offsetHeight : out.scrollHeight);
  const scrollToEnd = () => {
    if (!outer) pinEnd();
  };
  // The end of the log is the bottom of its last real line. Boxes of a <div rect=...> hang below their line and take no room (ConsoleDivPart), and Emuera clips them at the window edge, so they must not stretch the scroll range: scrolling to scrollHeight lifted the whole log by the overhang.
  function flowMax() {
    const l = out.lastElementChild as HTMLElement | null;
    return l ? Math.max(0, l.offsetTop + l.offsetHeight - out.clientHeight) : 0;
  }
  function pinEnd() {
    out.scrollTop = flowMax();
    atEnd = true;
    fixedLayer?.setBacklog(false);
  }
  let atEnd = true;
  if (!outer) {
    out.addEventListener('scroll', () => {
      const m = flowMax();
      if (out.scrollTop > m + 1) out.scrollTop = m;
      atEnd = m - out.scrollTop < 40;
      fixedLayer?.setBacklog(!atEnd);
    }); // 'puchi': fixed images are not drawn in the backlog
    if (typeof ResizeObserver !== 'undefined')
      new ResizeObserver(() => {
        if (atEnd) pinEnd();
      }).observe(out); // a taller or shorter window keeps the newest line on the bottom edge
  }

  // ---- button geometry (stage coordinates: natural size, origin top-left of the container)
  const SEL = 'a.btn,div.btn,canvas.imgbtn,canvas.cbgb';
  function buttons(): ButtonInfo[] {
    const rr = root.getBoundingClientRect();
    const k = cfg.w / (rr.width || cfg.w);
    const res: ButtonInfo[] = [];
    for (const el of root.querySelectorAll(SEL)) {
      const info = reg.get(el);
      if (!info) continue;
      const rects: Rect[] = [];
      let visible = outer;
      for (const r of el.getClientRects()) {
        if (!r.width || !r.height) continue;
        let y = (r.top - rr.top) * k,
          h = r.height * k;
        // an inline box is as tall as the font's content area, which can exceed the line (tall fallback fonts): clamp text buttons to the line box around their centre so stacked lines do not overlap
        if (info.kind === 'text' && h > cfg.lineHeight) {
          y += (h - cfg.lineHeight) / 2;
          h = cfg.lineHeight;
        }
        rects.push({ x: (r.left - rr.left) * k, y, w: r.width * k, h });
        if (r.right > rr.left && r.left < rr.right && r.bottom > rr.top && r.top < rr.bottom) visible = true;
      }
      if (rects.length) res.push({ kind: info.kind, value: info.value, rects, visible });
    }
    return res;
  }
  const dist = (r: Rect, x: number, y: number) =>
    Math.hypot(Math.max(r.x - x, 0, x - (r.x + r.w)), Math.max(r.y - y, 0, y - (r.y + r.h)));
  function nearest(x: number, y: number, reach: number) {
    let best: { button: ButtonInfo; distance: number; top: number } | null = null;
    for (const b of buttons()) {
      if (!b.visible) continue;
      for (const r of b.rects) {
        const d = dist(r, x, y);
        if (d <= reach && (!best || d < best.distance || (d === best.distance && r.y < best.top)))
          best = { button: b, distance: d, top: r.y };
      }
    }
    return best ? { button: best.button, distance: best.distance } : null;
  }
  const buttonAt = (x: number, y: number) => {
    const n = nearest(x, y, 0);
    return n ? n.button : null;
  };
  const press = (b: ButtonInfo) => opts.onPress(b.value);
  function valueAt(x: number, y: number): string {
    const rr = root.getBoundingClientRect();
    const k = cfg.w / (rr.width || cfg.w);
    const cx = rr.left + x / k,
      cy = rr.top + y / k;
    if (typeof document.elementsFromPoint !== 'function') return buttonAt(x, y)?.value ?? '';
    // topmost first; shell overlays and non-button boxes are skipped, as Emuera hit-tests button regions only
    for (const el of document.elementsFromPoint(cx, cy)) {
      const b = el.closest(SEL);
      if (b && root.contains(b)) return reg.get(b)?.value ?? (b as HTMLElement).dataset.v ?? '';
    }
    return '';
  }

  function hoverAt(target: Element | null, clientX: number, clientY: number) {
    if (!tooltipsOn) return;
    tipX = clientX;
    tipY = clientY;
    const t = target?.closest?.('[data-tip]') ?? null;
    if (t === tipTarget) return;
    hideTip();
    if (!t) return;
    tipTarget = t;
    const text = (t as HTMLElement).dataset.tip ?? '';
    tipTimer = window.setTimeout(() => showTip(text), tipCfg.delay);
  }
  function clearSprites() {
    bitmaps.clear();
    shown = [];
  }
  function refreshFonts() {
    out.style.font = `${cfg.fontSize}px/${cfg.lineHeight}px ${fontStack(cfg.font, 'default')}`;
    island.style.font = out.style.font;
    for (const e of root.querySelectorAll<HTMLElement>('[data-f]'))
      e.style.fontFamily = fontStack(e.dataset.f!, 'segment');
    opts.onContentHeight?.(contentHeight());
  }
  function dispose() {
    window.removeEventListener('resize', onWin);
    window.removeEventListener('scroll', onWin, true);
    hideTip();
    cancelAnimationFrame(raf);
    fixedLayer?.dispose();
    fixedLayer = null;
    tipEl.remove();
    root.textContent = '';
    root.classList.remove('emu-screen', 'emu-inner', 'emu-outer');
    for (const b of bitmaps.values()) {
      b.bmp.close();
      b.anim?.forEach((f) => f.bmp.close());
    }
    bitmaps.clear();
  }

  const view: ScreenView = {
    stripTips: false,
    incremental: false,
    root,
    get size() {
      return { w: cfg.w, h: cfg.h };
    },
    render,
    buttons,
    buttonAt,
    nearestButton: (x, y, reach) => nearest(x, y, reach),
    press,
    contentHeight,
    scrollToEnd,
    hoverAt,
    valueAt,
    hideTip,
    clearSprites,
    refreshFonts,
    dispose,
  };
  return view;
}

/** TextRenderer.DrawText prefix handling: "&&" is "&", "&c" underlines c (unless NoPrefix 0x800), HidePrefix 0x100000 hides the & without underline */
function fillTip(el: HTMLElement, text: string, flags: number) {
  if (flags & 0x20) text = text.replace(/\r?\n/g, ' '); // SingleLine
  if (flags & 0x800) {
    el.textContent = text;
    return;
  }
  const under = !(flags & 0x100000),
    only = !!(flags & 0x200000); // HidePrefix: no underline; PrefixOnly: draw only the underline
  let buf = '';
  const flush = () => {
    if (buf) {
      const n = document.createElement('span');
      n.textContent = buf;
      if (only) n.style.color = 'transparent';
      el.appendChild(n);
      buf = '';
    }
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '&' || i === text.length - 1) {
      buf += ch;
      continue;
    }
    const nx = text[++i];
    if (nx === '&') {
      buf += '&';
      continue;
    }
    flush();
    const u = document.createElement('span');
    u.textContent = nx;
    if (under) u.style.textDecoration = 'underline';
    if (only && !under) u.style.color = 'transparent';
    el.appendChild(u);
  }
  flush();
}
