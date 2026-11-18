/**
 * Fixed-image layer of PuchiEmuera (profile 'puchi' only, written for eraSumireTeru; see engine/profile.ts). Nothing here is reachable under another profile:
 * the worker creates `vm.fixed` only for 'puchi', the HTML_PRINT hook and the instructions below check for it, and the host draws the layer only when a screen carries `fixed`.
 * Behaviour follows the PuchiEmuera engine.
 *
 *  - A resource CSV row `name,file,x,y,w,h,FIXED,posX|posY|alpha[|ROOT/CHILD|group]` is a fixed image: HTML_PRINT "<img src='name'>" does not print it into the line, it TOGGLES it
 *    in this list (a second print of the same name removes it; CLEARLINE/CLS remove the ones printed on removed lines; src='CLEARALL' [group='N'] removes all or one group).
 *    The HTML_PRINT line itself is an ordinary empty line.
 *  - Drawing (FixImgPrint.drawFixImage): images without a group (-1) or with a group number at or above the configured count (画像固定表示のグループ数, default 3) are drawn straight
 *    onto the screen first, a group-less one with its own alpha (ColorMatrix), a too-high group fully opaque. Then each group is drawn opaque into its own bitmap in print order and that
 *    bitmap is blended with the ROOT image's alpha times the group's fade alpha; groups are blended in the order their ROOT was printed. All of it sits behind the text.
 *  - A CHILD takes the position (and line number) of the group's first ROOT and is dropped when the group has no ROOT yet. `reverse='true'` on a ROOT mirrors its whole group across the window.
 *  - FADE alpha, group, ms, color: group -1 fades the whole screen (filled with 1 red, 2 black, 3 white, other = the background colour) and the value stays until the next FADE; a group
 *    number fades just that group's alpha. SHAKE coef, amp, "g,g", ms: the listed groups swing sideways, big at first and settling. Both block the script for `ms`.
 *  - FONTEDGE 0/1 outlines ALL text on screen (also what was printed before), FONTEDGE_COLOR r,g,b / RESET_FONTEDGE_COLOR set the outline colour (config フォント縁取り色, default black).
 * The animation itself is the host's job; this class holds the state and hands the host `wire()` with a sequence number per effect, so a screen that repeats an old effect does not replay it.
 */
export interface FixInfo {
  x: number;
  y: number;
  alpha: number;
  root: boolean;
  group: number;
}
export interface FixItem {
  n: string;
  x: number;
  y: number;
  a: number;
  g: number;
  root: boolean;
  rev: boolean;
  line: number;
}
export interface FixedMsg {
  groups: number;
  items: { n: string; x: number; y: number; a: number; g: number; root: boolean; rev: boolean }[];
  /** per group: the alpha FADE left it at (1 = shown) */
  fade: number[];
  /** whole-screen fade: alpha 1 = nothing covers the screen; color 1 red, 2 black, 3 white, 0 = the background colour */
  screen: { a: number; color: number };
  /** the last FADE: its number and duration. A host starts a transition only when `seq` is new; `ms` 0 = at once. */
  seq: number;
  ms: number;
  /** the last SHAKE (absent before the first) */
  shake?: { seq: number; groups: number[]; amp: number; ms: number };
  edge: { on: boolean; rgb: number };
}

export class FixedImages {
  items: FixItem[] = [];
  fade: number[];
  screen = { a: 1, color: 0 };
  seq = 0;
  ms = 0;
  shakeState?: { seq: number; groups: number[]; amp: number; ms: number };
  edge = false;
  edgeRgb: number;
  constructor(
    public groups = 3,
    private defaultEdge = 0,
  ) {
    this.groups = Math.max(1, Math.floor(groups) || 3);
    this.fade = new Array(this.groups).fill(1);
    this.edgeRgb = defaultEdge;
  }

  /** HTML_PRINT of a fixed image (FixImgPrint.addFixImage); `line` = the number of lines printed before this one (Console.LineCount) */
  toggle(
    name: string,
    info: FixInfo,
    o: { x?: number; y?: number; rev?: boolean; alpha?: number; group?: number },
    line: number,
  ) {
    const g = o.group !== undefined && o.group >= 0 ? o.group : info.group;
    if (this.items.some((i) => i.n === name)) {
      this.items = this.items.filter((i) => i.n !== name);
      return;
    }
    const it: FixItem = {
      n: name,
      x: o.x ?? info.x,
      y: o.y ?? info.y,
      a: o.alpha !== undefined && o.alpha >= 0 ? o.alpha : info.alpha,
      g,
      root: info.root,
      rev: info.root && !!o.rev,
      line: -1,
    };
    if (info.root) it.line = line;
    else if (g !== -1) {
      const r = this.items.find((i) => i.root && i.g === g);
      if (!r) return; // a child without a ROOT is not shown
      it.line = r.line;
      it.x = r.x;
      it.y = r.y;
    }
    this.items.push(it);
  }
  /**
   * HTML_PRINT <img ...> under 'puchi': true when the tag was a fixed-image one (a FIXED resource or CLEARALL) and has been handled here, false when it is an ordinary image.
   * `attr` reads an attribute of the tag, `infos` is Gfx.fixedInfo, `line` the number of lines printed so far. Attributes: fxpos, fypos, reverse (fix_reverse), fix_alpha, fix_group; CLEARALL takes group.
   */
  printTag(attr: (name: string) => string | undefined, infos: Map<string, FixInfo>, line: number): boolean {
    const nm = (attr('src') ?? '').trim().toUpperCase();
    const iv = (k: string) => {
      const v = attr(k);
      return v === undefined || v.trim() === '' || !Number.isFinite(Number(v)) ? undefined : Math.trunc(Number(v));
    };
    if (nm === 'CLEARALL') {
      this.clearAll(iv('group') ?? -1);
      return true;
    }
    const info = infos.get(nm);
    if (!info) return false;
    const fa = attr('fix_alpha');
    this.toggle(
      nm,
      info,
      {
        x: iv('fxpos'),
        y: iv('fypos'),
        rev: (attr('reverse') ?? attr('fix_reverse') ?? '').toLowerCase() === 'true',
        alpha: fa !== undefined && fa.trim() !== '' && Number.isFinite(Number(fa)) ? Number(fa) : undefined,
        group: iv('fix_group'),
      },
      line,
    );
    return true;
  }
  /** src='CLEARALL' [group='N']: no group or -1 clears everything */
  clearAll(group = -1) {
    this.items = group < 0 || !Number.isFinite(group) ? [] : this.items.filter((i) => i.g !== group);
  }
  /** lines were removed (CLEARLINE): images printed on a line that no longer exists go; `kept` = the line count left */
  clearFromLine(kept: number) {
    this.items = this.items.filter((i) => !(i.line >= kept));
  }

  /** FADE: alpha 0..1, group -1 = whole screen, ms duration, color code */
  doFade(a: number, group: number, ms: number, color: number) {
    const v = Math.min(1, Math.max(0, a));
    if (group < 0) this.screen = { a: v, color };
    else if (group < this.groups) this.fade[group] = v;
    this.seq++;
    this.ms = Math.max(0, ms);
  }
  doShake(groups: number[], amp: number, ms: number) {
    this.shakeState = {
      seq: (this.shakeState?.seq ?? 0) + 1,
      groups: groups.filter((g) => g >= 0 && g < this.groups),
      amp,
      ms: Math.max(0, ms),
    };
  }
  fontEdge(on: boolean) {
    this.edge = on;
  }
  setEdgeColor(r: number, g: number, b: number) {
    const c = (x: number) => Math.min(255, Math.max(0, Math.floor(x)));
    this.edgeRgb = (c(r) << 16) | (c(g) << 8) | c(b);
  }
  resetEdgeColor() {
    this.edgeRgb = this.defaultEdge;
  }

  wire(): FixedMsg {
    return {
      groups: this.groups,
      items: this.items.map(({ n, x, y, a, g, root, rev }) => ({ n, x, y, a, g, root, rev })),
      fade: [...this.fade],
      screen: { ...this.screen },
      seq: this.seq,
      ms: this.ms,
      shake: this.shakeState ? { ...this.shakeState } : undefined,
      edge: { on: this.edge, rgb: this.edgeRgb },
    };
  }
}

/** a resource CSV's 8th column `x|y|alpha[|ROOT/CHILD|group]` (CroppedImage.FixImgInfo); absent parts: alpha 1, no group (-1), not a root */
export function parseFixInfo(col: string): FixInfo {
  const p = col.split('|').map((s) => s.trim());
  const n = (s: string | undefined, d: number) => {
    const v = Number.parseFloat(s ?? '');
    return Number.isFinite(v) ? v : d;
  };
  const role = (p[3] ?? '').toUpperCase();
  return {
    x: Math.trunc(n(p[0], 0)),
    y: Math.trunc(n(p[1], 0)),
    alpha: n(p[2], 1),
    root: role === 'ROOT',
    group: role === 'ROOT' || role === 'CHILD' ? Math.trunc(n(p[4], -1)) : -1,
  };
}
