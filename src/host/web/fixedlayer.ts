/**
 * Fixed-image layer for the screen view (host-web tier). Only profile 'puchi' (eraSumireTeru) sends `ScreenMsg.fixed`; for every other game `update` is never called with a value, no
 * element is created and the page is exactly what it was. What it draws (see engine/runtime/fixedimg.ts for the rules of the original, PuchiEmuera FixImgPrint):
 *  - behind the text: images without a group (or with a group at or above the configured count) straight onto the stage, then each group as one unit whose opacity is its ROOT image's
 *    alpha times the group's fade; a ROOT marked reverse mirrors the whole group across the window;
 *  - in front of everything: the whole-screen FADE colour, opacity 1 - alpha;
 *  - FADE and SHAKE are animated here (CSS transition / requestAnimationFrame) once per new `seq` the engine sends, while the engine holds the script for the same time;
 *  - FONTEDGE: a stroke round all text (-webkit-text-stroke painted under the fill; the original draws a 3.5 px pen).
 *  - the layer is hidden while the log is scrolled back (the original does not draw fixed images in the backlog).
 */
import type { FixedMsg } from '../../engine/runtime/fixedimg';
import type { Bmp } from '../screen';

export interface FixedLayerEnv {
  doc: Document;
  /** the screen root: the layer goes just before `out`, the fade veil last */
  root: HTMLElement;
  out: HTMLElement;
  /** elements whose text gets the FONTEDGE outline */
  edgeTargets: HTMLElement[];
  bitmap(name: string): Bmp | undefined;
  draw(c: HTMLCanvasElement, b: Bmp, w: number, h: number): void;
  cfg(): { w: number; h: number; bg: number };
  ids?: boolean;
}
export interface FixedLayer {
  update(f: FixedMsg): void;
  setBacklog(on: boolean): void;
  dispose(): void;
}

const FADE_COLORS: Record<number, string> = { 1: '#ff0000', 2: '#000000', 3: '#ffffff' };
const css = (rgb: number) => '#' + (rgb & 0xffffff).toString(16).padStart(6, '0');

export function createFixedLayer(env: FixedLayerEnv): FixedLayer {
  const { doc } = env;
  let under: HTMLDivElement | null = null,
    veil: HTMLDivElement | null = null,
    direct: HTMLDivElement | null = null;
  const groups = new Map<number, { el: HTMLDivElement; sig: string; dx: number; rev: boolean }>();
  let lastSeq = 0,
    lastShake = 0,
    shakeRaf = 0,
    backlog = false;

  function ensure() {
    if (under) return;
    under = doc.createElement('div');
    under.className = 'emu-fix';
    if (env.ids) under.id = 'fixlayer';
    under.style.cssText = 'position:absolute;inset:0;z-index:1;pointer-events:none;overflow:hidden';
    direct = doc.createElement('div');
    direct.style.cssText = 'position:absolute;inset:0';
    under.appendChild(direct);
    env.root.insertBefore(under, env.out);
    veil = doc.createElement('div');
    veil.className = 'emu-fixveil';
    if (env.ids) veil.id = 'fixveil';
    veil.style.cssText = 'position:absolute;inset:0;z-index:6;pointer-events:none;opacity:0';
    env.root.appendChild(veil);
  }
  function canvasFor(it: FixedMsg['items'][number]): HTMLCanvasElement | null {
    const b = env.bitmap(it.n);
    if (!b) return null;
    const c = doc.createElement('canvas');
    env.draw(c, b, b.w, b.h);
    c.style.cssText = `position:absolute;left:${it.x}px;top:${it.y}px;width:${b.w}px;height:${b.h}px`;
    return c;
  }
  const place = (g: { el: HTMLDivElement; dx: number; rev: boolean }) => {
    g.el.style.transform = g.rev ? `translateX(${g.dx}px) scaleX(-1)` : g.dx ? `translateX(${g.dx}px)` : '';
  };

  function update(f: FixedMsg) {
    ensure();
    const animate = f.seq !== lastSeq && f.ms > 0;
    lastSeq = f.seq;
    const tr = animate ? `opacity ${f.ms}ms linear` : 'none';
    // direct images: no group (-1) or a group number the config does not provide
    const dsig = f.items
      .filter((i) => i.g < 0 || i.g >= f.groups)
      .map((i) => `${i.n}@${i.x},${i.y}:${i.g < 0 ? i.a : 1}:${env.bitmap(i.n) ? 1 : 0}`)
      .join('|');
    if (direct!.dataset.sig !== dsig) {
      direct!.dataset.sig = dsig;
      direct!.textContent = '';
      for (const it of f.items) {
        if (!(it.g < 0 || it.g >= f.groups)) continue;
        const c = canvasFor(it);
        if (!c) continue;
        if (it.g < 0) c.style.opacity = String(it.a);
        direct!.appendChild(c);
      }
    }
    // groups, in the order their ROOT was printed
    const order: number[] = [];
    for (const it of f.items) if (it.root && it.g >= 0 && it.g < f.groups && !order.includes(it.g)) order.push(it.g);
    for (const [g, e] of groups)
      if (!order.includes(g)) {
        e.el.remove();
        groups.delete(g);
      }
    for (const g of order) {
      const root = f.items.find((i) => i.root && i.g === g)!;
      const mine = f.items.filter((i) => i.g === g);
      let e = groups.get(g);
      if (!e) {
        const el = doc.createElement('div');
        el.style.cssText = 'position:absolute;inset:0;transform-origin:50% 50%';
        e = { el, sig: '', dx: 0, rev: false };
        groups.set(g, e);
      }
      const sig = mine.map((i) => `${i.n}@${i.x},${i.y}:${env.bitmap(i.n) ? 1 : 0}`).join('|');
      if (e.sig !== sig) {
        e.sig = sig;
        e.el.textContent = '';
        for (const it of mine) {
          const c = canvasFor(it);
          if (c) e.el.appendChild(c);
        }
      }
      e.rev = root.rev;
      place(e);
      e.el.style.transition = tr;
      if (animate) void e.el.offsetWidth; // the new transition must be in place before the value changes
      e.el.style.opacity = String(root.a * (f.fade[g] ?? 1));
      under!.appendChild(e.el); // appendChild moves it: this keeps the print order of the roots
    }
    // whole-screen fade
    veil!.style.background = FADE_COLORS[f.screen.color] ?? css(env.cfg().bg);
    veil!.style.transition = tr;
    if (animate) void veil!.offsetWidth;
    veil!.style.opacity = String(1 - f.screen.a);
    // outline
    for (const t of env.edgeTargets) {
      const s = t.style as CSSStyleDeclaration & { webkitTextStroke?: string; paintOrder?: string };
      if (f.edge.on) {
        s.webkitTextStroke = `3.5px ${css(f.edge.rgb)}`;
        s.paintOrder = 'stroke fill';
      } else {
        s.webkitTextStroke = '';
        s.paintOrder = '';
      }
    }
    // shake: a new number starts it
    if (f.shake && f.shake.seq !== lastShake) {
      lastShake = f.shake.seq;
      const { groups: gs, amp, ms } = f.shake,
        t0 = performance.now();
      cancelAnimationFrame(shakeRaf);
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / Math.max(1, ms));
        // big at first, settling: a decaying swing (about 20 swings a second)
        const dx = Math.round(amp * (1 - k) * Math.sin(((now - t0) / 1000) * 2 * Math.PI * 10));
        for (const g of gs) {
          const e = groups.get(g);
          if (e) {
            e.dx = k >= 1 ? 0 : dx;
            place(e);
          }
        }
        if (k < 1) shakeRaf = requestAnimationFrame(step);
      };
      shakeRaf = requestAnimationFrame(step);
    }
    under!.style.display = backlog ? 'none' : '';
  }
  return {
    update,
    setBacklog(on: boolean) {
      backlog = on;
      if (under) under.style.display = on ? 'none' : '';
    },
    dispose() {
      cancelAnimationFrame(shakeRaf);
      under?.remove();
      veil?.remove();
      under = veil = direct = null;
      groups.clear();
    },
  };
}
