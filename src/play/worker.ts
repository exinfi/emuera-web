/** Web Worker: parses the game, decodes resources, drives the VM; talks to the page by messages. */
import { cfg as compilerCfg } from '../engine/compiler/config';
import { describeProfile } from '../engine/profile';
import { FixedImages } from '../engine/runtime/fixedimg';
import { cssColor } from './color';
import { unescapeHtml } from './unescape';
import { parseProgram, bodySource } from '../engine/compiler/parser';
import { decodeText } from '../engine/textdecode';
import { Tables } from '../engine/compiler/tables';
import { VM } from '../engine/runtime/vm';
import { PATCHES as ERABLUE_PATCHES, installPatches } from '../engine/patches/erablue';
import { RANCEK_PATCHES, installRanceKPatches, whyNotRanceK } from '../engine/patches/rancek';
import { gameCode as patchGameCode, patchWidth, patchesFor } from '../engine/patches/registry';
import { applySourcePatch, sourcePatchesFor, type SourcePatch } from '../engine/patches/sourcepatch';
import { addFormFolderAliases } from '../engine/patches/formfolders';
import { loadConfig, applyLogCap } from '../engine/runtime/config';
import { CharaTemplates } from '../engine/runtime/charatemplates';
import { EmueraError } from '../engine/runtime/value';
import { MK_PREFIX, TIMEOUT, type Renderer, type SoundMsg } from '../engine/runtime/host';
import type { Gfx } from '../engine/runtime/gfx';
import { buttonize as bz, Seg as BSeg } from './buttonize';
import type {
  ToWorker,
  ToPage,
  StartMsg,
  ScreenKind,
  FontFile,
  Rc,
  Seg as WireSeg,
  NativeImported,
  NativeExported,
} from '../host/protocol';
import { ExprParser } from '../engine/compiler/expr';
import { OPTION_DEFS } from '../host/protocol';
import { splitLines } from '../engine/util/lines';
import {
  fromNative,
  toNativeGlobal,
  toNativeSlot,
  selfCheck,
  slotKeyOfFile,
  fileOfSlotKey,
} from '../engine/runtime/nativesave';
import { gameCode, gameVer } from '../engine/runtime/charas';
import { Cursor } from '../engine/compiler/cursor';
import { compile } from '../engine/runtime/eval';
import { formatStack } from '../engine/runtime/errctx';
import { ENGINE_NAME } from '../version';

type Img = {
  n: string;
  alt?: string;
  h?: number;
  w?: number;
  hpx?: boolean;
  wpx?: boolean;
  ypos?: number;
  ypx?: boolean;
  srcb?: string;
};
type Len = { n: number; px: boolean };
type Div = {
  x?: Len;
  y?: Len;
  w?: Len;
  h?: Len;
  color?: number;
  depth: number;
  box: { [k: string]: Len[] };
  bcolor?: number[];
  lines: Seg[][];
};
type Seg = BSeg & { img?: Img; div?: Div; sp?: Len; rc?: Rc };
const buttonize = (l: Seg[]): Seg[] => bz(l as BSeg[]) as Seg[];

const parseNum = (s: string | undefined) => {
  if (s === undefined) return undefined;
  const m = /^\s*(-?\d+)\s*(px)?\s*$/i.exec(s);
  return m ? { n: Number(m[1]), px: !!m[2] } : undefined;
};
const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:'([^']*)'|"([^"]*)"|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
};
const unesc = (t: string | undefined) => (t === undefined ? undefined : unescape(t));
const baseName = (k: string) => (k.startsWith('\u0001') ? k.slice(k.indexOf('\u0001', 1) + 1) : k);
const fontKey = (s: string) => s.toLowerCase().replace(/[\s\-_]+/g, ''); // same rule as host/screen.ts familyKey
const unescape = (t: string) => unescapeHtml(t, compilerCfg.profile);
const decode = unescape;

/** per-game patches in effect for the loaded game (ids) and the line the reports carry */
let activePatches: string[] = [],
  patchNote = '',
  profileNote = '',
  optionsNote = '';

export class WebRenderer implements Renderer {
  lines: Seg[][] = [];
  cur: Seg[] = [];
  color = -1;
  bold = 0;
  notes = new Set<string>();
  /** SETFONT name ('' = the game's default font), FONTSTYLE italic / strikeout / underline (bold is `bold`) */
  font = '';
  ital = 0;
  strike = 0;
  under = 0;
  private sty(): Partial<Seg> {
    const o: Partial<Seg> = {};
    if (this.font) o.f = this.font;
    if (this.ital) o.i = 1;
    if (this.strike) o.s = 1;
    if (this.under) o.u = 1;
    return o;
  }
  /** Emuera.NET ConsoleStyledString removes every tab from printed text (EM+EE keeps it); the page would otherwise draw a tab as a tab stop wider than the measured text */
  private notab(t: string) {
    return compilerCfg.profile === 'emuera-net' && t.includes('\t') ? t.replace(/\t/g, '') : t;
  }
  private add(t: string, v?: string) {
    t = this.notab(t);
    if (t !== '' || v !== undefined) this.cur.push({ t, v, c: this.color, b: this.bold || undefined, ...this.sty() });
  }
  print(t: string) {
    this.add(t);
  }
  align = 'left';
  /** per-game patch `rancek-html-align`: a plain HTML_PRINT follows the console's ALIGNMENT instead of starting LEFT */
  htmlFollowsAlign = false;
  /** the last line came from REUSELASTLINE: the next line replaces it (EmueraConsole.addDisplayLine) */
  tempLast = false;
  /** 履歴ログの行数 (EmueraConsole.addDisplayLine drops the oldest display line once the list is longer than this) */
  maxLog = 5000;
  /** how many of the oldest lines were dropped by that limit; LINECOUNT is the logical line count (EmueraConsole.logicalLineCount), which the limit does not change */
  dropped = 0;
  newline() {
    this.cur = buttonize(this.cur);
    if (this.align !== 'left') this.cur.unshift({ t: '', al: this.align });
    if (this.tempLast) {
      this.lines.pop();
      this.tempLast = false;
    }
    this.lines.push(this.cur);
    this.cur = [];
    if (this.lines.length > this.maxLog) {
      this.lines.shift();
      this.dropped++;
    }
  }
  clearScreen() {
    this.lines = [];
    this.cur = [];
    this.tempLast = false;
    this.dropped = 0;
    theVm?.fixed?.clearAll();
  } // 'puchi' only: CLS also removes the fixed images
  clearLines(n: number) {
    if (!(n > 0)) return; // deleteLine(num): a zero or negative count removes nothing (a negative one used to leave empty slots in the line list)
    this.tempLast = false;
    const have = this.lines.length,
      take = Math.min(n, have);
    this.lines.length = have - take;
    // lines already dropped by the limit still count for LINECOUNT: CLEARLINE LINECOUNT-start keeps removing the right number
    if (n > take) this.dropped = Math.max(0, this.dropped - (n - take));
    theVm?.fixed?.clearFromLine(this.lines.length + this.dropped); // 'puchi' only: fixed images printed on the removed lines go with them
  }
  pending() {
    return this.cur.length > 0;
  }
  lineCount() {
    return this.lines.length + this.dropped;
  }
  /** a stable id per printed line (unique across workers); the unfinished line gets -1. A view may keep the DOM of lines whose id it already drew. */
  private ids = new WeakMap<Seg[], number>();
  private nextId = 0;
  private idBase = (() => {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return (a[0] % 1_000_000) * 4_000_000_000;
  })();
  lineIds(snap: Seg[][]): number[] {
    return snap.map((l, i) => {
      if (i >= this.lines.length) return -1; // the pending line is a fresh array in every snapshot
      let id = this.ids.get(l);
      if (id === undefined) {
        id = this.idBase + this.nextId++;
        this.ids.set(l, id);
      }
      return id;
    });
  }
  private segHtml(line: Seg[], wrap: boolean): string {
    const esc = (t: string) =>
      t.replace(/[&><"']/g, (c) => ({ '&': '&amp;', '>': '&gt;', '<': '&lt;', '"': '&quot;', "'": '&apos;' })[c]!);
    let b = '';
    for (const g of line) {
      // DRAWLINE / CUSTOMDRAWLINE: Emuera keeps the bar as a ConsoleStyledString of the line character repeated to the drawable width,
      // so HTML_GETPRINTEDSTR returns it as text (HtmlManager.DisplayLine2Html, EM+EE and Emuera.NET alike). Games test it for a run of
      // repeated characters to avoid stacking separators (eraRanceK @SINGLE_DRAWLINE).
      if (g.al === 'line' && !g.img) {
        const n = Math.max(
          16,
          Math.floor(
            (theVm?.config.windowWidth ?? 760) / ((theVm?.config.fontSize ?? 16) / 2) / Math.max(1, g.t.length),
          ),
        );
        b += esc(g.t.repeat(n));
        continue;
      }
      if (g.al === 'line' || g.img) continue;
      if (g.rc) {
        const L = (l: Len) => `${l.n}${l.px ? 'px' : ''}`,
          r = g.rc;
        b += `<shape type='rect' param='${L(r.x)}, ${L(r.y)}, ${L(r.w)}, ${L(r.h)}'${r.c !== undefined && r.c >= 0 ? ` color='#${(r.c & 0xffffff).toString(16).toUpperCase().padStart(6, '0')}'` : ''}>`;
        continue;
      }
      if (g.sp) {
        b += `<shape type='space' param='${g.sp.n}${g.sp.px ? 'px' : ''}'>`;
        continue;
      }
      let t = esc(g.t);
      // HtmlManager.getStringStyleStartingTag: <font face color> then <s><u><i><b> (closed in reverse)
      if (g.b) t = `<b>${t}</b>`;
      if (g.i) t = `<i>${t}</i>`;
      if (g.u) t = `<u>${t}</u>`;
      if (g.s) t = `<s>${t}</s>`;
      const face = g.f ? ` face='${esc(g.f)}'` : '',
        col =
          g.c !== undefined && g.c >= 0
            ? ` color='#${(g.c & 0xffffff).toString(16).toUpperCase().padStart(6, '0')}'`
            : '';
      if (face || col) t = `<font${face}${col}>${t}</font>`;
      if (g.v !== undefined) t = `<button value='${esc(g.v)}'>${t}</button>`;
      b += t;
    }
    if (!wrap) return b;
    const al = line.find((x) => x.al && x.al !== 'line')?.al ?? 'left';
    return `<p align='${al}'><nobr>${b}</nobr></p>`;
  }
  displayLine(n: number) {
    const l = this.lines[n];
    return l ? l.map((g) => g.t).join('') : '';
  }
  htmlLine(n: number) {
    const l = this.lines[this.lines.length - 1 - n];
    return l ? this.segHtml(l, true) : '';
  }
  popPendingHtml() {
    if (!this.cur.length) return '';
    const h = this.segHtml(this.cur, false);
    this.cur = [];
    return h;
  }
  lastLine() {
    const l = this.lines[this.lines.length - 1];
    return { temp: this.tempLast, empty: !!l && !l.some((x) => x.img || x.t.trim() !== '') };
  }
  drawLine(ch = '-') {
    const a = this.align;
    this.align = 'left';
    if (this.cur.length) this.newline();
    this.cur = [{ t: ch, c: -2, al: 'line' }];
    this.newline();
    this.align = a;
  }
  setColor(c: number) {
    this.color = c;
  }
  setBgColor() {}
  resetColor() {
    this.color = -1;
  }
  /**
   * PATCH (host-web font override): only an empty name means "the default font". A game that asks for the config font BY NAME
   * (AnonTW draws every map row with `<font face='ＭＳ ゴシック'>` and the config font is ＭＳ ゴシック) is making an explicit choice, so the
   * segment keeps that face. Collapsing it to "default" let the Controls font override (e.g. Saitamaar, wanted for the title screen) restyle
   * the maps, whose box-drawing/kanji layout needs the fixed-width font the game named. With no override both render identically, so this is
   * invisible unless the user replaced the default font, which is exactly Emuera's behaviour if the user had edited the config font instead.
   */
  setFont(name: string) {
    this.font = name;
  }
  setStyle(bits: number) {
    this.bold = bits & 1;
    this.ital = (bits >> 1) & 1;
    this.strike = (bits >> 2) & 1;
    this.under = (bits >> 3) & 1;
  }
  setAlign(a: 'left' | 'center' | 'right') {
    this.align = a;
  }
  button(t: string, v: string) {
    this.add(t, v);
  }
  reuseLastLine(t: string) {
    if (t === '') return;
    if (this.cur.length) this.newline();
    if (this.tempLast) {
      this.lines.pop();
      this.tempLast = false;
    }
    this.cur = [{ t }];
    this.newline();
    this.tempLast = true;
  }
  image(n: string, h?: number, w?: number, o?: Partial<Img>) {
    const pin = (x: string) => theVm?.gfx.pin(x) ?? x; // the sprite is bound when the line is printed (ConsoleImagePart)
    this.cur.push({ t: '', img: { n: pin(n).toUpperCase(), alt: n, h, w, ...o } });
  }
  /** HTML_PRINT text starts from the HTML state (default font, regular style), not from SETFONT/FONTSTYLE (HtmlAnalzeState.GetSS) */
  private htmlOwnLines = false;
  html(m: string, noNl = false) {
    const keep = { font: this.font, ital: this.ital, strike: this.strike, under: this.under };
    this.font = '';
    this.ital = 0;
    this.strike = 0;
    this.under = 0;
    // Html2DisplayLine: the lines of a plain HTML_PRINT are aligned by <p align=...> only (LEFT without it); SetAlignment is one-shot, so the console's ALIGNMENT does not reach them.
    // The buffer form (HTML_PRINT x, 1) joins the pending line and follows ALIGNMENT like any printed text.
    // PATCH rancek-html-align: for that game one plain HTML_PRINT keeps the console's ALIGNMENT (a <p align> in the markup still wins)
    const consoleAlign = this.align;
    if (!noNl) {
      if (this.cur.length) this.newline();
      if (!this.htmlFollowsAlign) this.align = 'left';
      this.htmlOwnLines = true;
    }
    try {
      this.htmlInner(m, noNl);
    } finally {
      if (!noNl) {
        this.align = consoleAlign;
        this.htmlOwnLines = false;
      }
      this.font = keep.font;
      this.ital = keep.ital;
      this.strike = keep.strike;
      this.under = keep.under;
    }
  }
  private inheritBtn: { v: string; tip?: string } | null = null;
  private htmlInner(m: string, noNl = false) {
    // Emuera: HTML_PRINT (without the no-newline flag) first completes the pending line
    if (!noNl && this.cur.length) this.newline();
    // a div nested inside a <button> (Emuera.NET profile only, see the PATCH in case 'div') starts with the enclosing button still open
    const stack: { c: number; f: string }[] = [];
    let btn: string | null = this.inheritBtn ? this.inheritBtn.v : null;
    let btnTip: string | undefined = this.inheritBtn?.tip;
    let nbTip: string | undefined;
    let nb = false;
    let btnImgs: Seg[] = [];
    let pendPos: number | undefined;
    let fixedHit = false;
    const startLines = this.lines.length + this.dropped;
    const push = (seg: Seg) => {
      if (pendPos !== undefined) {
        seg.pos = pendPos;
        pendPos = undefined;
      }
      if (btn !== null) {
        seg.v = btn;
        if (btnTip) seg.tip = btnTip;
      } else if (nb) {
        seg.nb = true;
        if (nbTip) seg.tip = nbTip;
      }
      this.cur.push(seg);
    };
    // a quoted attribute value may contain '>' (command tooltips hold <br> markup)
    const re = /<(?:[^>'"]|'[^']*'|"[^"]*")*>|[^<]+/g;
    const toks = [...m.matchAll(re)].map((x) => x[0]);
    for (let ti = 0; ti < toks.length; ti++) {
      const tk = toks[ti];
      if (tk[0] !== '<') {
        const t = this.notab(decode(tk));
        if (btn !== null || nb) push({ t, c: this.color, b: this.bold || undefined, ...this.sty() });
        else this.add(t);
        continue;
      }
      const name = /^<\s*\/?\s*([a-z0-9]+)/i.exec(tk)?.[1]?.toLowerCase();
      const close = /^<\s*\//.test(tk);
      switch (name) {
        case 'br':
          this.newline();
          break;
        case 'nobr':
          if (!close) this.cur.push({ t: '', nw: true });
          break; // <nobr>: the line is never wrapped (the part past the window edge is cut off)
        case 'button':
        case 'nonbutton':
          if (!close) {
            const pv = attr(tk, 'pos');
            if (pv !== undefined && /^\s*-?\d+\s*$/.test(pv)) pendPos = parseInt(pv, 10);
          } // pos=N: the first part of the tag starts at x=N px
          if (name === 'button') {
            if (close) {
              btn = null;
              btnTip = undefined;
            } else {
              btn = unesc(attr(tk, 'value')) ?? '';
              btnTip = unesc(attr(tk, 'title'));
            }
          } else if (close) {
            nb = false;
            nbTip = undefined;
          } else {
            nb = true;
            nbTip = unesc(attr(tk, 'title'));
          } // <nonbutton title='...'>: plain text that carries a tooltip and is never turned into [N] buttons
          break;
        case 'p':
          if (!close && this.htmlOwnLines) {
            const al = attr(tk, 'align')?.toLowerCase();
            if (al === 'left' || al === 'center' || al === 'right') this.align = al;
          }
          break;
        case 'font':
          if (close) {
            const p = stack.pop();
            this.color = p?.c ?? -1;
            this.font = p?.f ?? '';
          } else {
            stack.push({ c: this.color, f: this.font });
            const c = cssColor(attr(tk, 'color'));
            if (c !== undefined) this.color = c;
            const face = unesc(attr(tk, 'face'));
            if (face) this.setFont(face);
          }
          break; // an inner <font> inherits what it does not set (HtmlAnalzeStateFontTag)
        case 'b':
          this.bold = close ? 0 : 1;
          break;
        case 'i':
          this.ital = close ? 0 : 1;
          break;
        case 'u':
          this.under = close ? 0 : 1;
          break;
        case 's':
          this.strike = close ? 0 : 1;
          break;
        case 'shape': {
          // ConsoleShapePart: only type='space' exists, a gap of param (percent of the font size, or px)
          if (close) break;
          const ty = (attr(tk, 'type') ?? '').toLowerCase();
          const ps = (attr(tk, 'param') ?? '').split(',').map((v) => parseNum(v.trim()));
          if (ps.some((v) => !v)) {
            this.notes.add(`<shape type='${ty}'> with bad param ignored`);
            break;
          }
          const P = ps as Len[];
          if (ty === 'space') {
            if (P.length === 1) this.cur.push({ t: '', sp: P[0] });
            break;
          }
          if (ty === 'rect') {
            // ConsoleShapePart.CreateShape: one param = width (height one font size), four = x,y,w,h
            const fs = theVm?.config.fontSize ?? 16,
              px = (l: Len) => (l.px ? l.n : (fs * l.n) / 100);
            const z: Len = { n: 0, px: true };
            const r =
              P.length === 1 && P[0].n > 0
                ? { x: z, y: z, w: P[0], h: { n: fs, px: true } }
                : P.length === 4 && px(P[0]) >= 0 && px(P[2]) > 0 && px(P[3]) > 0
                  ? { x: P[0], y: P[1], w: P[2], h: P[3] }
                  : null;
            if (!r) break; // Emuera shows an error part here; an empty gauge (width 0) is common, so draw nothing
            const c = cssColor(attr(tk, 'color'));
            this.cur.push({ t: '', sp: { n: px(r.x) + px(r.w), px: true }, rc: { ...r, c } });
            break;
          }
          this.notes.add(`<shape type='${ty}'> ignored`);
          break;
        }
        case 'div': {
          if (close) break; // stray </div>
          let j = ti + 1,
            depth = 1; // nested <div>s (Emuera.NET status panels put a div of divs inside one HTML_PRINT): the matching close tag, not the first one
          for (; j < toks.length; j++) {
            if (/^<\s*div(?![a-z])/i.test(toks[j])) depth++;
            else if (/^<\s*\/\s*div/i.test(toks[j]) && --depth === 0) break;
          }
          const inner = toks.slice(ti + 1, j).join('');
          ti = j;
          const sub = new WebRenderer();
          sub.color = this.color;
          // PATCH (eraMegaten Rag shop lottery, @RAG_SPECIAL_TICKET_INV): the game wraps a whole group of boxes in ONE <button value='１'> (and never closes the first <div>, so the
          // label boxes end up inside it). In Emuera.NET's DOM parse every descendant of the button is part of that button: a click anywhere on the box presses it, and its text is
          // not turned into "[1]" number buttons. Without this the label "[1] Name" became a separate button 1 that the game ignores, and only the picture square worked.
          // EM+EE gives a div's content a fresh state (see the next PATCH), so this too is under the profile.
          if (compilerCfg.profile === 'emuera-net' && btn !== null) sub.inheritBtn = { v: btn, tip: btnTip };
          sub.html(inner, true);
          for (const n of sub.notes) this.notes.add(n);
          const lens = (n: string) =>
            (attr(tk, n) ?? '')
              .split(',')
              .map((v) => parseNum(v.trim()?.replace(/[{}]/g, '')))
              .filter((v): v is Len => !!v);
          const one = (n: string) => parseNum(attr(tk, n));
          let x = one('xpos'),
            y = one('ypos'),
            w = one('width'),
            h = one('height');
          const rect = lens('rect');
          if (rect.length === 4) [x, y, w, h] = rect;
          const size = lens('size');
          if (size.length === 2) [w, h] = size;
          // Emuera.NET (profile 'emuera-net', HtmlManager "DIV"): width/height are optional (the box then fits its content: widest row, one line height per row, plus padding),
          // one `padding`, `border_width` + `border_color` (white), `background_color`; sizes are px or percent of the font size like ours. EM+EE requires width and height.
          const net = compilerCfg.profile === 'emuera-net';
          if (!net && (!w || !h)) {
            this.notes.add('<div> without width/height ignored');
            break;
          }
          if (net) {
            // PATCH (eraMegaten @INPUT_MANY numpad): Emuera.NET parses <button value=..> as a DOM node whose children are the <div> boxes, so the whole box (border box and label box
            // alike) is the button and a click anywhere on it presses it. We carry the enclosing button's value/tooltip on the div itself (Div.v / Div.tip) and the view makes the box clickable.
            // EM+EE does not do this: its HtmlManager gives a div's content a fresh state (no CurrentButtonTag) and only buttons inside the div are hit-tested (ConsoleDivPart.TestChildHitbox), so it stays under the profile.
            const bw = one('border_width'),
              pad = one('padding');
            const seg: Seg = {
              t: '',
              div: {
                x,
                y,
                w,
                h,
                color: cssColor(attr(tk, 'background_color')),
                depth: 0,
                box: {
                  border: bw ? [bw, bw, bw, bw] : [],
                  padding: pad ? [pad, pad, pad, pad] : [],
                  margin: [],
                  radius: [],
                },
                bcolor: bw ? Array(4).fill(cssColor(attr(tk, 'border_color')) ?? 0xffffff) : undefined,
                lines: sub.snapshot(),
                noclip: true,
                v: btn !== null ? btn : undefined,
                tip: btn !== null ? btnTip : undefined,
                abs:
                  attr(tk, 'display')?.toLowerCase() === 'absolute-lefttop'
                    ? 'lt'
                    : attr(tk, 'display')?.toLowerCase() === 'absolute-leftbottom'
                      ? 'lb'
                      : undefined,
              } as any,
            }; // absolute-*: placed against the window, not the line   // noclip: ConsoleDivElement draws its children without clipping to the box
            const disp = attr(tk, 'display')?.toLowerCase();
            if (disp && disp !== 'relative' && disp !== 'absolute-lefttop' && disp !== 'absolute-leftbottom')
              this.notes.add(`<div display=${disp}> treated as relative`);
            if (attr(tk, 'hover-background-color')) this.notes.add('<div hover-background-color> ignored');
            this.cur.push(seg);
            break;
          }
          const css = (n: string) => {
            const l = lens(n);
            return l.length === 1
              ? [l[0], l[0], l[0], l[0]]
              : l.length === 2
                ? [l[0], l[1], l[0], l[1]]
                : l.length === 3
                  ? [l[0], l[1], l[2], l[1]]
                  : l.slice(0, 4);
          };
          const bc = (attr(tk, 'bcolor') ?? '')
            .split(',')
            .map((v) => cssColor(v.trim()))
            .filter((v): v is number => v !== undefined);
          const box: { [k: string]: Len[] } = {
            border: css('border'),
            padding: css('padding'),
            margin: css('margin'),
            radius: css('radius'),
          };
          const seg: Seg = {
            t: '',
            div: {
              x,
              y,
              w,
              h,
              color: cssColor(attr(tk, 'color')),
              depth: one('depth')?.n ?? 0,
              box,
              bcolor: bc.length ? (bc.length === 1 ? [bc[0], bc[0], bc[0], bc[0]] : bc) : undefined,
              lines: sub.snapshot(),
            },
          };
          if (attr(tk, 'display')?.toLowerCase() === 'absolute')
            this.notes.add('<div display=absolute> treated as relative');
          this.cur.push(seg);
          break;
        }
        case 'img': {
          // PuchiEmuera (profile 'puchi', vm.fixed exists only then): a FIXED resource is not printed, it is toggled in the fixed-image layer (engine/runtime/fixedimg.ts). HtmlManager.Html2ButtonList never adds a fixed image to the line's parts, and PrintStringBuffer.ButtonsToDisplayLines returns ZERO lines for an empty part list, so an HTML_PRINT that holds only fixed images adds no line at all (see the end of htmlInner). The game prints dozens of these and positions the close-up windows from LINECOUNT, so a blank line per tag pushed the whole text block down and the windows overlapped it
          if (
            theVm?.fixed &&
            !close &&
            theVm.fixed.printTag((k) => attr(tk, k), theVm.gfx.fixedInfo, this.lines.length + this.dropped)
          ) {
            fixedHit = true;
            break;
          }
          const h = parseNum(attr(tk, 'height')),
            w = parseNum(attr(tk, 'width')),
            y = parseNum(attr(tk, 'ypos'));
          const pin = (x: string) => theVm?.gfx.pin(x) ?? x;
          const src = attr(tk, 'src') ?? '',
            srcb = attr(tk, 'srcb');
          const seg: Seg = {
            t: '',
            img: {
              n: pin(src).toUpperCase(),
              alt: src,
              h: h?.n,
              hpx: h?.px,
              w: w?.n,
              wpx: w?.px,
              ypos: y?.n,
              ypx: y?.px,
              srcb: srcb === undefined ? undefined : pin(srcb).toUpperCase(),
            },
          };
          push(seg);
          break;
        }
        default:
          break;
      }
    }
    void btnImgs;
    // 'puchi' only: nothing but fixed images (no text, no <br>) was printed: the original creates no display line for that (see case 'img')
    if (!noNl && !(fixedHit && !this.cur.length && this.lines.length + this.dropped === startLines)) this.newline();
  }
  note(m: string) {
    this.notes.add(m);
  }
  sound(m: SoundMsg) {
    post({ type: 'sound', m });
  }
  // ---- UI hooks (island overlay, background images, title, text box)
  /** overlay markup in print order, each with its layer (always 0 unless the game is an Emuera.NET one that gives layers) */
  islandParts: { layer: number; markup: string }[] = [];
  get islandMarkup(): string[] {
    return this.islandParts.map((p) => p.markup);
  }
  // PATCH (eraMegaten popups): Emuera.NET keeps HTML_PRINT_ISLAND content per layer number (EmueraConsole._htmlElementListDict, a SortedDictionary): layers are drawn from the lowest number up
  // (the highest is on top) and hit-tested from the highest down, and HTML_PRINT_ISLAND_CLEAR n empties only layer n (no argument empties all). The game's popups rely on it: INPUT_YN_POPUP prints the
  // box on layer 99 and then a dimming filter on layer 98, which must sit BEHIND the box; in print order the filter covered the box and washed it out. EM+EE has one list and ignores the layer, so it stays that way under that profile.
  island(markup: string, layer?: number) {
    this.islandParts.push({ layer: compilerCfg.profile === 'emuera-net' && layer !== undefined ? layer : 0, markup });
  }
  clearIsland(layer?: number) {
    this.islandParts =
      compilerCfg.profile === 'emuera-net' && layer !== undefined
        ? this.islandParts.filter((p) => p.layer !== layer)
        : [];
  }
  /** island markup rendered to lines with a scratch renderer, lowest layer first (equal layers keep print order) */
  islandLines(): Seg[][] {
    const t = new WebRenderer();
    for (const p of this.islandParts.map((x, i) => ({ ...x, i })).sort((a, b) => a.layer - b.layer || a.i - b.i))
      t.html(p.markup);
    return t.snapshot();
  }
  bgs: { name: string; depth: number; opacity: number }[] = [];
  setBgImage(name: string, depth: number, opacity: number) {
    if (!theVm?.gfx.sprites.has(name.toUpperCase())) return; // AddBackgroundImage ignores unknown / non-whole-image sprites
    this.bgs.push({ name: name.toUpperCase(), depth, opacity });
    this.bgs.sort((a, b) => (a.depth >= b.depth ? -1 : 1)); // deepest first, as in the original
  }
  clearBgImage() {
    this.bgs = [];
  }
  removeBgImage(name: string) {
    const i = this.bgs.findIndex((b) => b.name === name.toUpperCase());
    if (i >= 0) this.bgs.splice(i, 1);
  }
  setTitle(t: string) {
    post({ type: 'title', title: t });
  }
  inputText = '';
  getTextBox() {
    return this.inputText;
  }
  clearText() {
    this.inputText = '';
    post({ type: 'textbox', op: 'clear' });
  }
  moveTextBox(x: number, y: number, width: number) {
    post({ type: 'textbox', op: 'move', x, y, width });
  }
  resumeTextBox() {
    post({ type: 'textbox', op: 'resume' });
  }
  snapshot() {
    if (!this.cur.length) return this.lines;
    const c = buttonize(this.cur);
    return [...this.lines, this.align !== 'left' ? [{ t: '', al: this.align } as Seg, ...c] : c];
  }
}

let pending: ((s: string | null) => void) | null = null;
/** what the pending wait is for: an INPUTMOUSEKEY wait takes only mouse/key events, any other input only text (a click's late text press must not become a key press) */
let pendingKind = '';
let theVm: VM | null = null;
let theR: WebRenderer | null = null;
let theGameId = '';
let erbSources: Record<string, string> = {};
const recentInputs: { kind: string; prompt: string; value: string }[] = []; // the last answers (5000 at most), with the prompt each one answered; the log prints 25, or all in its verbose form
let lastScreen: Seg[][] = [];
/** what the last screen message carried besides its lines (island overlay, backgrounds, CBG layers and buttons, tooltip settings, image sizes): names and numbers only, for the verbose log's screen dump */
let lastExtras: Record<string, unknown> = {};
/** every image segment on the given lines, including those inside <div> boxes */
function* imgSegs(lines: Seg[][]): Generator<Seg> {
  for (const l of lines)
    for (const g of l) {
      if (g.img) yield g;
      if (g.div) yield* imgSegs(g.div.lines);
    }
}
const lineText = (l: Seg[] | undefined): string =>
  (l ?? [])
    .map((x) =>
      x.img
        ? `[img ${x.img.alt ?? x.img.n}]`
        : x.sp || x.rc
          ? ' '
          : x.div
            ? (x.div.lines ?? []).map(lineText).join(' ')
            : x.t,
    )
    .join('');
/** names evaluated for the "game state" block of an error report; ones this game does not define are skipped */
const CONTEXT_VARS = [
  'DAY',
  'TIME',
  'MONEY',
  'MASTER',
  'PLAYER',
  'TARGET',
  'ASSI',
  'SELECTCOM',
  'NEXTCOM',
  'PREVCOM',
  'NO:TARGET',
  'NO:MASTER',
  'SAVESTR:ゲームフェイズ管理',
  'CHARANUM',
  'RESULT',
  'RESULTS',
];
/** a message with its quoted names and numbers blanked: messages of one kind (the same error on many lines) share it */
const blank = (t: string) => t.replace(/'[^']*'/g, "'…'").replace(/\d+/g, '#');
interface Kind {
  kind: string;
  n: number;
  ex: string[];
}
/** repeated messages grouped by kind, most frequent first; `split` gives a message's kind and its example text */
function kindsOf(items: string[], split: (t: string) => [string, string], maxEx: number): Kind[] {
  const by = new Map<string, Kind>();
  for (const t of items) {
    const [kind, ex] = split(t);
    let k = by.get(kind);
    if (!k) by.set(kind, (k = { kind, n: 0, ex: [] }));
    k.n++;
    if (k.ex.length < maxEx) k.ex.push(ex);
  }
  return [...by.values()].sort((a, b) => b.n - a.n);
}
/** `file:line message` (a load diagnostic): the kind is the message with names and numbers blanked, the example is the whole line */
const loadKind = (t: string): [string, string] => [blank(t.replace(/^\S+?:\d+ /, '')), t];
/** graphics warnings: the kind is the text before the last ': ' (the file or name is the example) */
const gfxKind = (t: string): [string, string] => {
  const i = t.lastIndexOf(': ');
  return i < 0 ? [blank(t), t] : [blank(t.slice(0, i)), t.slice(i + 2)];
};
/** the short form lists at most this many entries of each long list and says how many more the verbose form has */
const more = (shown: number, total: number) =>
  total > shown ? [`  ... ${total - shown} more (the verbose export lists all)`] : [];
function buildReport(err: any, vm: VM, sourceNote: string, userNote = '', verbose = false): string {
  const out: string[] = [];
  const gfx = vm.gfx;
  // errors found while reading the ERB; functions are parsed when first reached, so the list grows during play
  const loadErrs = vm.prog.diagnostics.filter((d) => d.level === 'error').map((d) => `${d.file}:${d.line} ${d.msg}`);
  const loadKinds = kindsOf(loadErrs, loadKind, verbose ? 3 : 1);
  const gfxKinds = kindsOf(gfx.warnings, gfxKind, verbose ? 5 : 2);
  const miss = new Set<string>();
  for (const g of imgSegs(lastScreen)) if (g.img && !gfx.sprites.has(g.img.n)) miss.add(baseName(g.img.n));
  out.push(
    err ? '# Engine error report' : '# Playtest log (manual export)',
    '',
    ...(userNote ? [`player note: ${userNote}`] : []),
    ...(err ? [`error: ${String(err?.message ?? err).split('\n')[0]}`] : []),
    `engine: ${ENGINE_NAME} | ${sourceNote} | ${new Date().toISOString()}`,
    `BEGIN state: ${vm.system.state}`,
    `detail: ${verbose ? 'verbose' : 'standard'}`,
    ...(profileNote ? [`engine profile: ${profileNote}`] : []),
    ...(patchNote ? [`per-game patches: ${patchNote}`] : []),
    ...(optionsNote ? [`options: ${optionsNote}`] : []),
    '',
    '## Summary',
    `- runtime error: ${err ? String(err?.message ?? err).split('\n')[0] : 'none'}`,
    `- load errors: ${loadErrs.length ? `${loadErrs.length} in ${loadKinds.length} kind${loadKinds.length === 1 ? '' : 's'} (functions are parsed when first used, so more can appear)` : 'none so far'}`,
    `- graphics warnings: ${gfx.warnings.length ? `${gfx.warnings.length}${gfx.warnings.length >= 100 ? '+' : ''} in ${gfxKinds.length} kind${gfxKinds.length === 1 ? '' : 's'}` : 'none'}; images missing on the screen: ${miss.size}`,
    `- unimplemented commands hit: ${vm.unimplemented.size}`,
    `- DEBUGPRINT lines: ${vm.debugLines.size} distinct`,
    '',
  );
  const info = err?.erb;
  if (!err) {
    const last = lastScreen
      .filter(Boolean)
      .map(lineText)
      .filter((t) => t.trim() !== '')
      .slice(-1)[0];
    out.push(
      '## Where',
      `${pending ? `waiting for input (kind ${pendingKind}${last ? `; the screen ends with: ${last.trim().slice(0, 70)}` : ''})` : 'not waiting for input (the game is running)'}; BEGIN state ${vm.system.state}; no error`,
    );
  } else if (info?.stack?.length) {
    out.push('## Where (ERB)', '```', formatStack(info), '```');
    const top = info.stack[0],
      text = erbSources[top.file];
    const kept = text
      ? undefined
      : (vm.prog.funcs.get(top.fn.toUpperCase()) ?? [])
          .map((f) => bodySource(f, top.line))
          .find((x) => x && x.file === top.file);
    if (kept)
      out.push(
        '',
        `source ${top.file} (parsed form, comments removed):`,
        '```',
        ...kept.lines.map(([n, x]) => `${n === top.line ? '>' : ' '} ${n}: ${x}`),
        '```',
      );
    else if (text) {
      const ls = splitLines(text);
      const a = Math.max(0, top.line - 5),
        b = Math.min(ls.length, top.line + 2);
      out.push(
        '',
        `source ${top.file}:`,
        '```',
        ...ls.slice(a, b).map((x, i) => `${a + i + 1 === top.line ? '>' : ' '} ${a + i + 1}: ${x}`),
        '```',
      );
    }
  } else out.push('## Where', 'no ERB frame recorded (error raised outside script execution)');
  if (err?.stack && !(err instanceof EmueraError))
    out.push('', '## Engine (JS) stack', '```', String(err.stack).split('\n').slice(0, 8).join('\n'), '```');
  const fn = vm.findFunc('SYSTEM_TITLE') ?? [...vm.prog.funcs.values()][0]?.[0];
  const st: string[] = [];
  for (const name of CONTEXT_VARS) {
    try {
      const v = fn ? compile(new ExprParser(new Cursor(name)).expr(), fn, vm)(vm.newFrame(fn, false)) : undefined;
      if (v !== undefined) st.push(`${name}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`);
    } catch {
      /* not defined in this game */
    }
  }
  out.push('', '## Game state', st.join('  '));
  // consecutive identical answers (a mouse event repeated as the pointer moves) are one entry with a count; the short form keeps the last 25 entries, the verbose form the first 50 and the last 50
  const grouped: { x: (typeof recentInputs)[number]; n: number }[] = [];
  for (const x of recentInputs) {
    const g = grouped[grouped.length - 1];
    if (g && g.x.kind === x.kind && g.x.prompt === x.prompt && g.x.value === x.value) g.n++;
    else grouped.push({ x, n: 1 });
  }
  const fmt = ({ x, n }: { x: (typeof recentInputs)[number]; n: number }) =>
    `[${x.kind}] ${x.prompt}  <-  ${x.value === '' ? '<enter>' : x.value}${n > 1 ? `  (x${n})` : ''}`;
  const insLines = verbose
    ? grouped.length > 100
      ? [
          ...grouped.slice(0, 50).map(fmt),
          `... ${grouped.length - 100} entries left out ...`,
          ...grouped.slice(-50).map(fmt),
        ]
      : grouped.map(fmt)
    : grouped.slice(-25).map(fmt);
  out.push(
    '',
    `## Inputs (oldest first, each with the prompt it answered; ${recentInputs.length} kept of this session${
      verbose ? ', first 50 and last 50 entries' : ', last 25 entries; the verbose export adds the first 50'
    }; repeats are counted)`,
    '```',
    ...insLines,
    '```',
  );
  const tail = lastScreen
    .filter(Boolean)
    .map(lineText)
    .filter((t, i, a) => t.trim() !== '' || (i > 0 && a[i - 1].trim() !== ''))
    .slice(verbose ? -200 : -30);
  const nLines = verbose ? 200 : 30;
  out.push(
    '',
    err ? `## Screen text before the error (last ${nLines} lines)` : `## Screen text (last ${nLines} lines)`,
    '```',
    ...tail,
    '```',
  );
  if (verbose) {
    // the last screen lines as the page receives them (image and sprite names, never bitmaps), one JSON line per screen line, so a layout or click problem can be replayed
    // through the screen view without the game; newest lines first claim the budget, so a long dump is cut at its old end
    const MAX_LINES = 100,
      MAX_BYTES = 200_000,
      MAX_EXTRA = 50_000;
    const rows = lastScreen.filter(Boolean).slice(-MAX_LINES);
    const kept: string[] = [];
    let bytes = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const j = JSON.stringify(rows[i]);
      if (bytes + j.length > MAX_BYTES) break;
      bytes += j.length;
      kept.unshift(j);
    }
    // the other parts of the screen message, smallest first, until the extra budget is used; image sizes (one entry per image on screen) are the part that can grow
    const extra: Record<string, unknown> = {};
    const left: string[] = [];
    let xb = 0;
    for (const k of ['tooltip', 'bgs', 'layers', 'buttons', 'island', 'sizes']) {
      const v = lastExtras[k];
      if (v === undefined) continue;
      const n = JSON.stringify(v).length;
      if (xb + n > MAX_EXTRA) left.push(k);
      else {
        extra[k] = v;
        xb += n;
      }
    }
    out.push(
      '',
      `## Screen dump (the last ${kept.length} of ${lastScreen.filter(Boolean).length} screen lines, one JSON array of segments per line; ${(bytes / 1024).toFixed(0)} KB${kept.length < rows.length ? `, cut at ${MAX_BYTES / 1000} KB` : ''}; first line: window settings and ${Object.keys(extra).join(', ') || 'no other parts'} (${(xb / 1024).toFixed(0)} KB)${left.length ? `; left out as too large: ${left.join(', ')}` : ''})`,
      '```json',
      JSON.stringify({
        w: vm.config.windowWidth,
        h: vm.config.windowHeight,
        fontSize: vm.config.fontSize,
        lineHeight: vm.config.lineHeight,
        font: vm.config.fontName,
        fg: vm.config.textColor,
        bg: vm.config.backColor,
        ...extra,
      }),
      ...kept,
      '```',
    );
  }
  out.push(
    '',
    `## Recent ERB functions entered (oldest first, last ${verbose ? 200 : 40})`,
    '```',
    vm
      .recentCalls(verbose ? 200 : 40)
      .map((n) => '@' + n)
      .join(' > '),
    '```',
  );
  // diagnostics that matter for display problems
  const extra: string[] = [];
  // the same message on many lines is one line with a count and an example; the verbose form adds every entry after the groups
  const showKinds = (kinds: Kind[], ex: (k: Kind) => string) => {
    const n = verbose ? kinds.length : 8;
    return [...kinds.slice(0, n).map((k) => `  ${k.n}× ${k.kind}${ex(k)}`), ...more(n, kinds.length)];
  };
  if (loadErrs.length) {
    extra.push(
      `load diagnostics (${loadErrs.length} ERB errors found so far, in ${loadKinds.length} kinds, most frequent first):`,
      ...showKinds(loadKinds, (k) => `\n      e.g. ${k.ex.join('\n           ')}`),
    );
    if (verbose) extra.push('  all load diagnostics:', ...loadErrs.slice(0, 2000).map((w) => '    ' + w));
  }
  if (gfx.warnings.length) {
    extra.push(
      `graphics warnings (${gfx.warnings.length}${gfx.warnings.length >= 100 ? '+' : ''}, in ${gfxKinds.length} kinds):`,
      ...showKinds(gfxKinds, (k) => `  (e.g. ${k.ex.join(', ')})`),
    );
    if (verbose) extra.push('  all graphics warnings:', ...gfx.warnings.map((x) => '    ' + x));
  }
  if (miss.size)
    extra.push(
      'missing sprites on screen:',
      ...[...miss]
        .slice(0, verbose ? 100 : 12)
        .map((n) => `  ${n} [${(gfx.trace.get(n) ?? ['never created']).join('; ')}]`),
      ...more(verbose ? 100 : 12, miss.size),
    );
  if (vm.unimplemented.size)
    extra.push('unimplemented hits:', ...[...vm.unimplemented].map(([k, n]) => `  ${k} x${n}`));
  // the list itself is noise (games probe many folders that rightly do not exist), so only a count is printed; vm.fileMisses still holds the entries for a debugger
  if (vm.fileMisses.size)
    extra.push(
      `file queries that found nothing: ${vm.fileMisses.size >= 60 ? '60+' : vm.fileMisses.size} distinct (ENUMFILES on a folder or pattern with no match; normal for most games${verbose ? '' : '; the list is in the verbose export'})`,
      ...(verbose ? [...vm.fileMisses].map(([t, n]) => `  ${t.slice(0, 200)}${n > 1 ? `  (x${n})` : ''}`) : []),
    );
  if (vm.debugLines.size)
    extra.push(
      `DEBUGPRINT output (not shown on the game screen; distinct lines, ${verbose ? 'all kept' : 'last 25'}):`,
      ...[...vm.debugLines]
        .slice(verbose ? -500 : -25)
        .map(([t, n]) => `  ${t.slice(0, 200)}${n > 1 ? `  (x${n})` : ''}`),
      ...(verbose ? [] : more(25, vm.debugLines.size)),
    );
  if (theR?.notes.size) {
    const n = verbose ? theR.notes.size : 10;
    extra.push('host notes:', ...[...theR.notes].slice(0, n).map((x) => '  ' + x), ...more(n, theR.notes.size));
  }
  out.push('', '## Diagnostics', ...(extra.length ? extra : ['nothing recorded']));
  return out.join('\n');
}
/** colour of the CBG button map under a click: -1 when there is no map, the point is outside it or the pixel is not opaque; else 0xRRGGBB */
async function mapColor(x: number, y: number): Promise<number> {
  const gfx = theVm?.gfx;
  if (!gfx || gfx.cbgMapG < 0) return -1;
  await gfx.flush();
  const s = gfx.get(gfx.cbgMapG);
  if (!s?.canvas) return -1;
  const py = y + s.h; // y arrives measured from the bottom of the client area
  if (x < 0 || py < 0 || x >= s.w || py >= s.h) return -1;
  const d = (s.canvas as any).getContext('2d').getImageData(x, py, 1, 1).data;
  return d[3] === 255 ? (d[0] << 16) | (d[1] << 8) | d[2] : -1;
}
/** swap the mounted memory card: replaces slot records and SAVETEXT files */
function setCard(saves: Record<string, { info: string; data: string }>, files: Record<string, string>) {
  const vm = theVm;
  if (!vm) return;
  vm.saves.clear();
  for (const [k, v] of Object.entries(saves)) vm.saves.set(k, v);
  for (const k of vm.userFiles) vm.textFiles.delete(k);
  vm.userFiles.clear();
  for (const [k, t] of Object.entries(files)) {
    vm.textFiles.set(k, t);
    vm.userFiles.add(k);
  }
}
/** native Emuera save files <-> slot records of the running game (host stores / downloads the results) */
async function nativeOp(m: Extract<ToWorker, { type: 'native' }>) {
  const vm = theVm;
  if (!vm) {
    post({ type: 'native', id: m.id, error: 'no game is running' });
    return;
  }
  try {
    if (m.op === 'import') {
      const imported: NativeImported[] = [];
      for (const f of m.files) {
        const key0 = slotKeyOfFile(f.name);
        try {
          const r = await fromNative(vm, new Uint8Array(f.bytes));
          const key = r.kind === 'global' ? 'global' : key0;
          if (!key) {
            imported.push({
              name: f.name,
              key: null,
              ok: false,
              error: 'cannot tell which slot this is from the file name (expected saveNN.sav)',
            });
            continue;
          }
          imported.push({
            name: f.name,
            key,
            ok: true,
            info: r.kind === 'global' ? '' : r.info,
            data: r.data,
            fileCode: r.code,
            fileVer: r.ver,
            fmt: r.fmt,
            gameCode: gameCode(vm),
            gameVer: gameVer(vm),
            skipped: r.skipped,
            warnings: r.warnings,
          });
        } catch (e: any) {
          imported.push({ name: f.name, key: key0, ok: false, error: String(e?.message ?? e) });
        }
      }
      post({ type: 'native', id: m.id, imported });
    } else {
      const exported: NativeExported[] = [];
      const tr: Transferable[] = [];
      for (const key of m.keys) {
        const name = fileOfSlotKey(key);
        const rec = vm.saves.get(key);
        if (!name || !rec) {
          exported.push({ key, name: name ?? key, ok: false, error: name ? 'slot is empty' : 'not a save slot' });
          continue;
        }
        try {
          const bytes = key === 'global' ? toNativeGlobal(vm, rec) : toNativeSlot(vm, rec);
          const bad = await selfCheck(vm, key === 'global' ? 'global' : 'slot', rec, bytes);
          if (bad) {
            exported.push({ key, name, ok: false, error: 'self-check failed: ' + bad });
            continue;
          }
          const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
          tr.push(buf);
          exported.push({ key, name, ok: true, bytes: buf });
        } catch (e: any) {
          exported.push({ key, name, ok: false, error: String(e?.message ?? e) });
        }
      }
      post({ type: 'native', id: m.id, exported }, tr);
    }
  } catch (e: any) {
    post({ type: 'native', id: m.id, error: String(e?.message ?? e) });
  }
}
self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === 'native') {
    void nativeOp(m);
    return;
  }
  if (m.type === 'start') start(m).catch((err) => post({ type: 'fatal', msg: String(err?.stack ?? err) }));
  else if (m.type === 'exportlog' && theVm) {
    let text = '';
    try {
      text = buildReport(null, theVm, String(theGameId), String(m.note ?? ''), !!m.verbose);
    } catch (e2) {
      text = 'log failed: ' + e2;
    }
    let snapshot = '';
    if (m.withState) {
      try {
        snapshot = theVm.snapshot();
      } catch {
        /* state not capturable right now */
      }
    }
    post({ type: 'logexport', text, snapshot });
  } else if (m.type === 'exportsnapshot' && theVm) {
    let snapshot = '';
    try {
      snapshot = theVm.snapshot();
    } catch {
      /* state not capturable right now */
    }
    post({ type: 'logexport', text: '', snapshot });
  } else if (m.type === 'card') setCard(m.saves, m.files);
  else if (m.type === 'input' && pending && (pendingKind !== 'mousekey' || m.value.startsWith(MK_PREFIX))) {
    const p = pending;
    pending = null;
    p(m.value);
  } else if (m.type === 'keystate' && theVm) {
    const k = m.code & 255,
      is = theVm.inputState;
    if (m.down) {
      is.keys.add(k);
      is.toggleBit[k] ^= 1;
    } else is.keys.delete(k);
  } else if (m.type === 'active' && theVm) theVm.inputState.active = !!m.active;
  else if (m.type === 'inputtext' && theVm) (theVm.host as WebRenderer).inputText = String(m.value ?? '');
  else if (m.type === 'pointing' && theVm) theVm.inputState.pointing = String(m.value ?? '');
  else if (m.type === 'mousepos' && theVm) theVm.mouse = { x: m.x, y: m.y };
  else if (m.type === 'mousekey' && pending && pendingKind === 'mousekey') {
    // INPUTMOUSEKEY event; clicks look up the hit-map colour (CBGSETBMAPG) under the pointer
    const p = pending;
    pending = null;
    const ev: number[] = m.ev;
    (async () => {
      if (ev[0] === 1 && theVm) {
        theVm.mouse = { x: ev[2], y: ev[3] };
        ev[4] = await mapColor(ev[2], ev[3]);
      }
      if (ev[0] === 1 && theVm) {
        // EmueraConsole.MouseDown: a click on a button gives its value in RESULT:5 (an integer button) or RESULTS (a string button)
        const pv = theVm.inputState.pointing;
        // Emuera.NET (InputMouseKey) clears RESULTS:5 on every click and puts a string button's value in RESULTS:5; EM+EE puts it in RESULTS (index 0), which is what its own games read.
        // eraMegaten's popups test GROUPMATCH(RESULTS:5, "キャンセル") to tell a click outside the box from "Yes", so under the Emuera.NET profile index 5 is the one that matters.
        const net = compilerCfg.profile === 'emuera-net';
        if (net) theVm.setResult('', 5);
        if (pv !== '') {
          if (/^\s*-?\d+\s*$/.test(pv)) ev[5] = Number(pv);
          else theVm.setResult(pv, net ? 5 : 0);
        }
      }
      p(MK_PREFIX + JSON.stringify(ev));
    })();
  }
};
const post = (m: ToPage, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
const status = (msg: string) => post({ type: 'status', msg });

/** Lines are immutable once printed, so what a line needs (sprite names, numeric tooltip ids) is worked out once and cached: a screen of thousands of lines is not walked again for every command. */
const needCache = new WeakMap<Seg[], { names: string[]; tips: number[] }>();
const isTipId = (t?: string) => !!t && /^\s*\d+\s*$/.test(t);
function lineNeeds(l: Seg[]): { names: string[]; tips: number[] } {
  let n = needCache.get(l);
  if (!n) {
    n = { names: [], tips: [] };
    for (const s of imgSegs([l])) {
      n.names.push(s.img!.n);
      if (s.img!.srcb) n.names.push(s.img!.srcb);
    }
    const walk = (ls: Seg[][]) => {
      for (const x of ls)
        for (const g of x) {
          if (isTipId(g.tip)) n!.tips.push(Number(g.tip));
          if (g.div) walk(g.div.lines);
        }
    };
    walk([l]);
    needCache.set(l, n);
  }
  return n;
}
/** every sprite name the given lines need bitmaps for */
function lineNames(lines: Seg[][]): Set<string> {
  const need = new Set<string>();
  for (const l of lines) for (const x of lineNeeds(l).names) need.add(x);
  return need;
}
/** every sprite name the screen needs bitmaps for */
function spriteNames(gfx: Gfx, names: Set<string>): string[] {
  const need = new Set<string>(names);
  for (const b of gfx.cbgButtons) {
    need.add(b.normal);
    need.add(b.hover);
  }
  for (const l of gfx.cbg) if (l.kind === 'sprite') need.add(l.ref as string);
  return [...need];
}

/** build the screen message: lines + the bitmaps (sprites, CBG layers) they reference */
function collect(gfx: Gfx, names: Set<string>, sent: Map<string, string>) {
  const sprites: Record<
    string,
    { bmp: ImageBitmap; w: number; h: number; anim?: { bmp: ImageBitmap; delay: number }[] }
  > = {};
  const transfer: Transferable[] = [];
  const need = new Set<string>(names);
  for (const b of gfx.cbgButtons) {
    need.add(b.normal);
    need.add(b.hover);
  }
  const ensure = (name: string) => {
    const ver = gfx.renderToken(name);
    if (sent.get(name) === ver) return;
    const sz = gfx.spriteSize(name);
    if (!sz) return;
    const c = gfx.renderSprite(name) as unknown as OffscreenCanvas | null;
    if (!c) return;
    const bmp = c.transferToImageBitmap();
    sprites[name] = { bmp, w: sz.w, h: sz.h };
    transfer.push(bmp);
    sent.set(name, ver);
    const ft = gfx.animeFrames(name);
    if (ft) {
      // animated: ship every frame once; the page runs the clock
      sprites[name].anim = ft.map((f) => {
        const fc = gfx.renderSprite(name, f.t) as unknown as OffscreenCanvas;
        const fb = fc.transferToImageBitmap();
        transfer.push(fb);
        return { bmp: fb, delay: f.delay };
      });
    }
  };
  const missing: string[] = [];
  for (const n of need) {
    if (gfx.sprites.has(n)) ensure(n);
    else missing.push(n);
  }
  const layers: { key: string; x: number; y: number; z: number }[] = [];
  for (const l of gfx.cbg) {
    if (l.kind === 'sprite') {
      const sp = gfx.sprites.get((l.ref as string).toUpperCase());
      if (!gfx.spriteCreated(sp)) continue; // a disposed sprite (or one on a disposed graphic) draws nothing: no layer, and the page lets go of its bitmap
      ensure(l.ref as string);
      layers.push({ key: l.ref as string, x: l.x, y: l.y, z: l.z });
      continue;
    }
    const s = gfx.get(l.ref as number);
    if (!s?.canvas) continue; // graphic disposed: nothing to draw until it is created again
    const key = `#G${l.ref}`;
    const ver = gfx.surfaceToken(s);
    if (sent.get(key) !== ver) {
      const c = gfx.backend!.makeCanvas(s.w, s.h) as unknown as OffscreenCanvas;
      (c.getContext('2d') as any).drawImage(s.canvas as any, 0, 0);
      const bmp = c.transferToImageBitmap();
      sprites[key] = { bmp, w: s.w, h: s.h };
      transfer.push(bmp);
      sent.set(key, ver);
    }
    layers.push({ key, x: l.x, y: l.y, z: l.z });
  }
  const sizes: Record<string, { w: number; h: number }> = {};
  for (const n of need) {
    const s = gfx.spriteSize(n);
    if (s) sizes[n] = s;
  }
  const live = new Set<string>(need); // every key the page must keep a bitmap for (layers too)
  for (const l of layers) live.add(l.key);
  return { sprites, transfer, layers, buttons: gfx.cbgButtons, sizes, missing, live };
}

/** fonts the page registered, registered again here so OffscreenCanvas text (GDRAWTEXT, GETTEXTSIZE) uses the same faces */
async function registerFonts(vm: VM, fonts: FontFile[]) {
  const reg = (self as any).fonts as { add(f: unknown): void } | undefined;
  const names = new Set<string>();
  for (const f of fonts) {
    names.add(f.family);
    if (!reg || typeof FontFace === 'undefined') continue;
    try {
      const face = new FontFace(f.family, f.data, { weight: String(f.weight), style: f.italic ? 'italic' : 'normal' });
      await face.load();
      reg.add(face);
    } catch (e) {
      status('Font ' + f.family + ' could not be registered in the engine: ' + e);
    }
  }
  vm.fontFamilies = [...names];
  const key = (s: string) => s.toLowerCase().replace(/[\s\-_]+/g, '');
  vm.gfx.resolveFont = (n) => vm.fontFamilies.find((f) => key(f) === key(n)) ?? n;
  // Text the game draws itself (GDRAWTEXT, GETTEXTSIZE) is measured here, not in the page. A font the game asks for but nobody registered (MS Gothic, Times New Roman...)
  // must fall back to the bundled metric-compatible font, as the page's stack does, or half-width text measures with whatever the browser picks. Name duplicated from
  // host-web/fonts.ts (BUNDLED_MONO): the engine tier must not import the host tier.
  vm.gfx.fallbackFonts = vm.fontFamilies.filter((f) => key(f) === key('BIZ UDGothic')).slice(0, 1);
}
async function start(m: StartMsg) {
  if (m.lenient) (globalThis as any).process = { env: { EMU_LENIENT: '1' } };
  const { erb, csv } = m;
  theGameId = String((m as any).gameId ?? '');
  const erbNames = Object.keys(m.erbBytes ?? erb);
  status(`Parsing ${erbNames.length} ERB files…`);
  await new Promise((r) => setTimeout(r, 20));
  // source patches (a fix to one function's text, only if that function is the one it was written for): applied to each file's text just before it is parsed
  const patchOffEarly = m.patchOff ?? [];
  const srcPatches: SourcePatch[] = m.patches
    ? sourcePatchesFor(
        patchesFor(csv)
          .map((p) => p.id)
          .filter((id) => !patchOffEarly.includes(id)),
      )
    : [];
  const srcApplied = new Set<string>();
  const fixText = (path: string, text: string): string => {
    for (const sp of srcPatches) {
      const r = applySourcePatch(sp, path, text);
      if (r !== null) {
        srcApplied.add(sp.id);
        return r;
      }
    }
    return text;
  };
  // low memory loader: ERB arrives as bytes; each file is decoded when the parser reaches it and dropped when the parser is done with it (no whole-source string, no second copy)
  const sources = m.erbBytes
    ? Object.entries(m.erbBytes).map(([path, bytes]) => {
        let b: ArrayBuffer | undefined = bytes,
          t: string | undefined;
        return {
          path,
          get text() {
            if (t === undefined) {
              if (!b) throw new Error('ERB source read after release: ' + path);
              t = fixText(path, decodeText(new Uint8Array(b)));
            }
            return t;
          },
          release() {
            t = undefined;
            b = undefined;
          },
        };
      })
    : Object.entries(erb).map(([path, text]) => ({ path, text: srcPatches.length ? fixText(path, text) : text }));
  if (m.erbBytes) m.erbBytes = undefined; // the map is dropped; each entry lives on only in its source object until released
  const prog = parseProgram(sources, { csv, lazy: m.lazy !== false });
  const r = new WebRenderer();
  theR = r;
  const vm = new VM(prog, new Tables(csv), r);
  // 'puchi' only: PuchiEmuera's CSV/*_TR.csv name translation (Tables.loadTranslation); before anything reads a *NAME array
  if (compilerCfg.profile === 'puchi') for (const n of vm.tables.loadTranslation(csv)) r.note(n);
  vm.templates = new CharaTemplates(csv, vm.tables);
  vm.config = loadConfig(csv);
  const lc = applyLogCap(vm.config.maxLog, m.logCap);
  r.maxLog = lc.used;
  if (lc.capped)
    r.note(
      `History log limit: the game asks for ${vm.config.maxLog} lines, using ${lc.used} (display cap; change it under Controls, Game and options)`,
    );
  // window width: the player's override, else a layout patch for this game, else the game's own config
  const pw = patchWidth(csv, !!m.patches, m.patchOff ?? []);
  const widthFrom: 'game' | 'patch' | 'override' =
    m.windowWidth && m.windowWidth >= 200 ? 'override' : pw ? 'patch' : 'game';
  if (widthFrom === 'override') vm.config.windowWidth = Math.floor(m.windowWidth!);
  else if (pw) vm.config.windowWidth = pw.px;
  vm.maxSteps = 1e13;
  vm.setOptimize(!!m.opt);
  // the load options in effect, for the reports (hidden options only when they differ from the default)
  optionsNote = OPTION_DEFS.filter((d) => !d.hidden || !!(m as any)[d.key] !== d.default)
    .map((d) => `${d.label} ${((m as any)[d.key] ?? d.default) ? 'on' : 'off'}`)
    .join(', ');
  const patchOff = m.patchOff ?? [];
  {
    const d = describeProfile(csv);
    profileNote = `${compilerCfg.profile} (${compilerCfg.profile === d.profile ? d.why : 'set by the host; detection would say ' + d.profile + ': ' + d.why})`;
  }
  const patched = m.patches && !patchOff.includes('erablue-load') ? installPatches(vm) : [];
  if (patched.length) status(`Game patches active: ${patched.join(', ')}`);
  const rkAll = Object.keys(RANCEK_PATCHES);
  const rkIds = rkAll.filter((id) => m.patches && !patchOff.includes(id) && installRanceKPatches(vm, id).length);
  const rkNative = rkIds.flatMap((id) => Object.keys(RANCEK_PATCHES[id].natives));
  if (rkNative.length) status(`Game patches active: ${rkNative.join(', ')}`);
  // form-change image folders: aliases are added to the file list before anything reads it (file list for ENUMFILES, image table)
  const formPatch =
    !!m.patches &&
    !patchOff.includes('erablue-form-folders') &&
    patchesFor(csv).some((p) => p.id === 'erablue-form-folders');
  const alignPatch =
    !!m.patches && !patchOff.includes('rancek-html-align') && patchesFor(csv).some((p) => p.id === 'rancek-html-align');
  if (alignPatch) r.htmlFollowsAlign = true;
  const aliased = formPatch ? addFormFolderAliases(m.images) : [];
  if (aliased.length) status(`Game patches active: image folder aliases ${aliased.join(', ')}`);
  activePatches = [
    ...(patched.length ? ['erablue-load'] : []),
    ...rkIds,
    ...(formPatch ? ['erablue-form-folders'] : []),
    ...(alignPatch ? ['rancek-html-align'] : []),
    ...srcApplied,
    ...(widthFrom === 'patch' && pw ? [pw.id] : []),
  ];
  patchNote = `${m.patches ? activePatches.join(', ') || 'none apply to this game' : 'switched off (master option)'}${patched.length || rkNative.length ? ` [native: ${[...patched, ...rkNative].join(', ')}]` : ''}; window width ${vm.config.windowWidth} px (${widthFrom === 'override' ? 'player override' : widthFrom === 'patch' ? 'fgok-width patch' : "the game's own config"})`;
  // boot summary for the Debug view: what the game was recognised as, the engine profile, and every patch for this game as applied / ignored (with the reason) / switched off
  const ours = patchesFor(csv);
  const why = (id: string): string => {
    if (id === 'erablue-load') {
      const miss = Object.keys(ERABLUE_PATCHES).filter((n) => !patched.includes(n));
      return miss.length ? `@${miss.join(', @')} differ from the build the patch was written for` : 'not installed';
    }
    if (id in RANCEK_PATCHES) return whyNotRanceK(vm, id);
    if (srcPatches.length && sourcePatchesFor([id]).length)
      return 'the function text differs from the build the patch was written for';
    if (id === 'fgok-width')
      return widthFrom === 'override' ? 'the window width is overridden in the options' : 'not applied';
    return 'not applied';
  };
  const on = ours.filter((p) => m.patches && !patchOff.includes(p.id)),
    off = ours.filter((p) => !on.includes(p));
  const gb = vm.tables.gameBase,
    code = patchGameCode(csv);
  const boot = [
    `game: ${gb.get('TITLE') || '(no title)'}${gb.get('VERSION') ? ' ' + gb.get('VERSION') : ''} (code ${code || 'none'}${ours.length ? '' : ', no per-game patches exist for it'})`,
    `engine profile: ${profileNote}`,
    ...(m.patches ? [] : ['per-game patches: all switched off (master option)']),
    ...(on.length
      ? [
          `patches applied: ${
            on
              .filter((p) => activePatches.includes(p.id))
              .map((p) => p.id)
              .join(', ') || 'none'
          }`,
        ]
      : []),
    ...on.filter((p) => !activePatches.includes(p.id)).map((p) => `patch ignored: ${p.id} (${why(p.id)})`),
    ...(m.patches && off.length ? [`patches switched off by you: ${off.map((p) => p.id).join(', ')}`] : []),
  ];
  post({ type: 'patches', active: activePatches, width: vm.config.windowWidth, widthFrom, boot });
  for (const [k, v] of Object.entries(m.texts)) vm.textFiles.set(k.toLowerCase(), v);
  for (const n of m.sounds ?? []) vm.soundFiles.add(n.toLowerCase());
  for (const n of m.unloaded ?? []) vm.unloadedFiles.add(n);
  await registerFonts(vm, m.fonts ?? []);
  vm.gameFiles = [
    ...erbNames,
    ...Object.keys(m.csv),
    ...Object.keys(m.rescsv),
    ...Object.keys(m.images),
    ...Object.keys(m.texts),
    ...(m.sounds ?? []).map((n) => 'sound/' + n),
  ];
  theVm = vm;
  setCard(m.saves, m.files ?? {});
  vm.onPersist = (key, v) => post({ type: 'persist', key, value: v });
  vm.onPersistFile = (key, text) => post({ type: 'persistFile', key, text });

  // ---- graphics: decode resource images, then read resource CSVs
  const gfx = vm.gfx;
  gfx.backend = { makeCanvas: (w, h) => new OffscreenCanvas(w, h) as any };
  gfx.defaultColor = (0xff000000 | vm.config.textColor) >>> 0;
  // images stay encoded (sizes come from the file headers); each one is decoded on first use and kept in a bounded cache
  const mime: Record<string, string> = {
    webp: 'image/webp',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    bmp: 'image/bmp',
  };
  gfx.images.backend = {
    decode: (bytes, ext) => createImageBitmap(new Blob([bytes], { type: mime[ext] ?? '' })),
    dispose: (b: ImageBitmap) => b.close?.(),
  };
  for (const [p, bytes] of Object.entries(m.images))
    gfx.images.add(p.toLowerCase(), bytes, p.split('.').pop()!.toLowerCase());
  if (m.imageBudgetMB && m.imageBudgetMB > 0) gfx.images.budget = m.imageBudgetMB * 1048576; // low-memory hosts: keep fewer decoded images around
  if (m.eager) {
    gfx.images.budget = Infinity;
    status(`Decoding all ${gfx.images.size} images (debug)…`);
    await gfx.images.ensure(Object.keys(m.images).map((k) => k.toLowerCase()));
  }
  if (compilerCfg.profile === 'puchi') {
    gfx.fixedEnabled = true; // FIXED rows of the resource CSV
    const rgb = (vm.config.raw.get('フォント縁取り色') ?? '0,0,0').split(',').map((x) => Number.parseInt(x, 10) || 0);
    vm.fixed = new FixedImages(
      Number(vm.config.raw.get('画像固定表示のグループ数')) || 3,
      ((rgb[0] & 255) << 16) | ((rgb[1] & 255) << 8) | (rgb[2] & 255),
    );
    gfx.imageLookupByName = true; // PuchiEmuera finds resource images by file name only (see Gfx.imageLookupByName)
  }
  for (const [p, text] of Object.entries(m.rescsv)) gfx.loadResourceCsv(text, p.slice(0, p.lastIndexOf('/') + 1));
  if (gfx.droppedRows.length)
    r.note(
      `${gfx.droppedRows.length} resource rows name an image file the game does not contain and were dropped, as PuchiEmuera does: ${gfx.droppedRows.slice(0, 12).join(', ')}${gfx.droppedRows.length > 12 ? ', ...' : ''}`,
    );
  status(`Graphics: ${gfx.images.size} images (decoded on demand), ${gfx.resourceSprites.size} sprites. Running…`);

  erbSources = erb; // empty with the low memory loader: the error report then takes its excerpt from the text lazily parsed functions keep (`bodySource`)
  // functions are parsed on first use, so their load-time errors appear once they are reached: read the list live
  const diagNow = () => prog.diagnostics.filter((d) => d.level === 'error').map((d) => `${d.file}:${d.line} ${d.msg}`);
  const sent = new Map<string, string>();
  const sentTips = new Set<string>();
  const gen = vm.run();
  let res = gen.next();
  const info = () => [
    ...diagNow(),
    ...gfx.warnings.slice(0, 5),
    ...r.notes,
    ...[...vm.unimplemented].map(([k, n]) => `unimplemented ${k} x${n}`),
  ];
  let heldIds = new Set<number>(); // ids of the finished lines the page holds (deltaLines)
  const emit = async (kind: ScreenKind, notes: string[], frame = false) => {
    const lines = r.snapshot();
    lastScreen = lines;
    const island = r.islandMarkup.length ? r.islandLines() : [];
    const bgs = r.bgs.map((b) => ({ key: b.name, alpha: b.opacity }));
    const names = lineNames(lines); // cached per line; the island is rebuilt every time and is small
    for (const l of island) for (const x of lineNeeds(l).names) names.add(x);
    for (const b of bgs) names.add(b.key); // everything that needs bitmaps
    const fixedMsg = vm.fixed?.wire(); // 'puchi' only
    if (fixedMsg) for (const i of fixedMsg.items) names.add(i.n);
    const keep = new Set(names); // CBG layers and buttons hold their sprite objects too
    for (const b of gfx.cbgButtons) {
      keep.add(b.normal);
      keep.add(b.hover);
    }
    for (const l of gfx.cbg) if (l.kind === 'sprite') keep.add(l.ref as string);
    gfx.prunePins(keep); // a printed image lives as long as a line holds it (ConsoleImagePart.cImage); pins no line uses any more are released
    if (gfx.warnings.length > 100) gfx.warnings.length = 100;
    await gfx.prepare(spriteNames(gfx, names)); // replay queued draws + decode what the screen shows
    const c = collect(gfx, names, sent);
    lastExtras = { island, bgs, layers: c.layers, buttons: c.buttons, tooltip: vm.tooltip, sizes: c.sizes };
    if (vm.tooltip.img) {
      // TOOLTIP_IMG: a tooltip whose text is a number shows that graphics id
      const ids = new Set<number>();
      const isId = (t?: string) => isTipId(t);
      for (const l of lines) for (const t of lineNeeds(l).tips) ids.add(t);
      for (const l of island) for (const t of lineNeeds(l).tips) ids.add(t);
      for (const b of gfx.cbgButtons as { tooltip?: string }[]) if (isId(b.tooltip)) ids.add(Number(b.tooltip));
      for (const id of ids) {
        c.live.add(`#T${id}`);
        try {
          const s = gfx.get(id);
          if (!s?.canvas) continue;
          const cv = gfx.backend!.makeCanvas(s.w, s.h) as unknown as OffscreenCanvas;
          (cv.getContext('2d') as any).drawImage(s.canvas as any, 0, 0);
          const bmp = cv.transferToImageBitmap();
          c.sprites[`#T${id}`] = { bmp, w: s.w, h: s.h };
          c.transfer.push(bmp);
        } catch {
          /* graphics id not created */
        }
      }
    }
    const drop: string[] = []; // bitmaps the page holds that nothing on this screen uses any more: tell it to close them, and forget them here
    for (const k of sent.keys()) if (!c.live.has(k)) drop.push(k);
    for (const k of drop) sent.delete(k);
    for (const k of sentTips)
      if (!c.live.has(k)) {
        drop.push(k);
        sentTips.delete(k);
      }
    for (const k of Object.keys(c.sprites)) if (k.startsWith('#T')) sentTips.add(k);
    const lineIds = r.lineIds(lines);
    let wireLines: (Seg[] | null)[] = lines;
    if (m.deltaLines) {
      wireLines = lines.map((l, i) => (lineIds[i] >= 0 && heldIds.has(lineIds[i]) ? null : l));
      heldIds = new Set(lineIds.filter((x) => x >= 0));
    } // finished lines are immutable: the page keeps the ones it has
    post(
      {
        type: frame ? 'frame' : 'screen',
        lines: wireLines,
        delta: m.deltaLines || undefined,
        drop: drop.length ? drop : undefined,
        lineIds,
        island,
        bgs,
        ...(fixedMsg ? { fixed: fixedMsg } : {}),
        kind,
        notes,
        imgStats: {
          n: gfx.images.decodedCount,
          of: gfx.images.size,
          mb: Math.round(gfx.images.decodedBytes / 1048576),
        },
        sprites: c.sprites,
        tooltip: vm.tooltip,
        layers: c.layers,
        buttons: c.buttons,
        sizes: c.sizes,
        missing: c.missing.map((n) => {
          const b = baseName(n);
          return `${b}${gfx.trace.get(b) ? ' [' + gfx.trace.get(b)!.join('; ') + ']' : ' [never created]'}`;
        }),
        cfg: {
          w: vm.config.windowWidth,
          h: vm.config.windowHeight,
          fontSize: vm.config.fontSize,
          lineHeight: vm.config.lineHeight,
          font: vm.config.fontName,
          fg: vm.config.textColor,
          bg: vm.config.backColor,
        },
      } as any,
      c.transfer,
    );
  };
  try {
    while (!res.done) {
      const q: any = res.value;
      if (q.t === 'input') {
        await emit(q.kind, info());
        let tick: ReturnType<typeof setInterval> | undefined;
        const v = await new Promise<string | null>((ok) => {
          pending = ok;
          pendingKind = q.kind;
          if (q.timeoutMs && q.countdown) {
            // TINPUT with the countdown shown: changeLastLine("Remaining: x.x") every ~100 ms
            const t0 = Date.now(),
              lim = q.timeoutMs;
            tick = setInterval(() => {
              if (pending !== ok) return;
              theR!.clearLines(1);
              theR!.print('Remaining: ' + (Math.max(0, lim - (Date.now() - t0)) / 1000).toFixed(1));
              theR!.newline();
              void emit(q.kind, info());
            }, 100);
          }
          if (q.timeoutMs)
            setTimeout(() => {
              if (pending === ok) {
                pending = null;
                ok(q.kind === 'mousekey' ? MK_PREFIX + '[4,0,0,0,0,0]' : TIMEOUT);
              }
            }, q.timeoutMs);
        });
        if (tick) clearInterval(tick);
        const shown =
          lastScreen
            .map(lineText)
            .filter((t) => t.trim())
            .slice(-1)[0] ?? '';
        recentInputs.push({
          kind: q.kind,
          prompt: shown.slice(0, 70),
          value: v === null ? '<none>' : v.startsWith(MK_PREFIX) ? 'mouse/key ' + v.slice(MK_PREFIX.length) : v,
        });
        if (recentInputs.length > 5000) recentInputs.shift();
        res = gen.next(v);
      } else if (q.t === 'delay' && q.marker === 'await') {
        // AWAIT: draw what the game has so far, then let the time pass (the game keeps running; no input is requested)
        await emit('wait', [], true);
        await new Promise((ok) => setTimeout(ok, Math.max(q.ms, 16)));
        res = gen.next(null);
      } else res = gen.next(null);
    }
    await emit('done', []);
    if (vm.restart) post({ type: 'restart' });
  } catch (err: any) {
    await emit('error', [String(err?.message ?? err)]).catch(() => {});
    try {
      post({
        type: 'errreport',
        text: buildReport(err, vm, String((m as any).gameId ?? '')),
        snapshot: (() => {
          try {
            return vm.snapshot();
          } catch {
            return '';
          }
        })(),
      });
    } catch (e2) {
      post({ type: 'errreport', text: 'report failed: ' + e2, snapshot: '' });
    }
  }
}
