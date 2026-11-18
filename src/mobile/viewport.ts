/** Pan/zoom viewport around the game stage. The stage keeps its natural size; a CSS transform on `pan`
 *  (translate + scale, origin top-left) moves and scales it, so the screen view still reports natural stage coordinates. */
export interface Pt {
  x: number;
  y: number;
}
const MIN_FIT = 0.6,
  MAX_SCALE = 4;
/** the automatic scale never drops below this: a game window several times wider than the phone (erablue_resort is 1600 px) would otherwise be unreadable */
const MIN_AUTO = 0.5;
/** the end of the log rests this many px above the viewport bottom when pinned; the user can drag a third of a screen further */
const PIN_PX = 44,
  SLACK = 0.33;

export class Viewport {
  s = 1;
  tx = 0;
  ty = 0;
  /** true until the user zooms: the scale then follows the viewport width (see autoScale) */
  auto = true;
  /** stay pinned to the end of the log as it grows (cleared when the user pans up, set again at the bottom) */
  follow = true;
  private settle = 0;
  constructor(
    readonly vp: HTMLElement,
    readonly pan: HTMLElement,
    readonly stage: HTMLElement,
    private onChange: () => void = () => {},
  ) {}

  get vw() {
    return this.vp.clientWidth;
  }
  get vh() {
    return this.vp.clientHeight;
  }
  /** natural (untransformed) stage size */
  get sw() {
    return this.stage.offsetWidth;
  }
  get sh() {
    return this.stage.offsetHeight;
  }
  /** desktop (mouse and hover): the automatic scale is the game's own size, 100% */
  desktop = false;
  /** the translation panel is docked beside the game: fit the game to the width that is left (never above 100% on a desktop) */
  dockFit = false;
  get autoScale() {
    if (this.desktop && !this.dockFit) return 1;
    const f = Math.max(this.fitScale, MIN_AUTO);
    return this.desktop ? Math.min(1, f) : f;
  }
  get fitScale() {
    return this.sw ? Math.min(2, this.vw / this.sw) : 1;
  }
  /** desktop: the text ends flush with the bottom edge and cannot be scrolled past it (as in Emuera); `mobileBottom` brings back the phone's room below the last line */
  mobileBottom = false;
  private get flush() {
    return this.desktop && !this.mobileBottom;
  }
  private bottomTy() {
    return Math.min(0, this.vh - this.sh * this.s - (this.flush ? 0 : PIN_PX));
  }
  private minTy() {
    return Math.min(0, this.vh - this.sh * this.s - (this.flush ? 0 : Math.max(PIN_PX, this.vh * SLACK)));
  }

  clamp() {
    const w = this.sw * this.s;
    this.tx = w <= this.vw ? (this.vw - w) / 2 : Math.min(0, Math.max(this.vw - w, this.tx));
    this.ty = Math.min(0, Math.max(this.minTy(), this.ty));
  }
  apply() {
    this.clamp();
    this.follow = this.ty <= this.bottomTy() + 6;
    this.pan.style.willChange = 'transform';
    this.pan.style.transform = `translate3d(${this.tx}px,${this.ty}px,0) scale(${this.s})`;
    clearTimeout(this.settle); // let the browser re-rasterise at the new scale once the gesture is over (otherwise zoomed text stays blurry)
    this.settle = window.setTimeout(() => {
      this.pan.style.willChange = 'auto';
    }, 220);
    this.onChange();
  }
  panBy(dx: number, dy: number) {
    this.tx += dx;
    this.ty += dy;
    this.apply();
  }
  /** set the scale keeping the stage point under (px, py) (viewport coordinates) fixed */
  zoomAbout(ns: number, px: number, py: number) {
    const min = this.fitScale * MIN_FIT;
    ns = Math.min(MAX_SCALE, Math.max(min, ns));
    const k = ns / this.s;
    this.tx = px - (px - this.tx) * k;
    this.ty = py - (py - this.ty) * k;
    this.s = ns;
    this.auto = false;
    this.apply();
  }
  /** preset scale, anchored at the top-centre of what is on screen */
  setScale(ns: number) {
    this.zoomAbout(ns, this.vw / 2, this.vh / 2);
  }
  /** the whole window width on screen, or (when it already is) the game's own size, 100% */
  fitOrActual() {
    if (Math.abs(this.s - this.fitScale) < 0.01) {
      this.auto = false;
      this.s = 1;
      this.tx = 0;
      this.apply();
    } else this.fit();
  }
  /** back to the automatic scale (readable, at least 50%; 100% on a desktop) */
  reset() {
    this.auto = true;
    this.s = this.autoScale;
    this.tx = 0;
    this.apply();
  }
  /** the whole window width on screen, however small the text gets */
  fit() {
    this.auto = false;
    this.s = this.fitScale;
    this.tx = 0;
    this.apply();
  }
  toBottom() {
    this.ty = this.bottomTy();
    this.follow = true;
    this.apply();
  }
  toTop() {
    this.ty = 0;
    this.apply();
  }
  /** the stage grew, shrank or was resized */
  layoutChanged() {
    if (this.auto) this.s = this.autoScale;
    if (this.follow) this.ty = this.bottomTy();
    this.apply();
  }
  /** client (screen) point -> natural stage coordinates (y down from the stage top) */
  toStage(cx: number, cy: number): Pt {
    const r = this.stage.getBoundingClientRect(),
      k = this.sw / (r.width || this.sw);
    return { x: (cx - r.left) * k, y: (cy - r.top) * k };
  }
  /** natural stage coordinates -> client point */
  toClient(x: number, y: number): Pt {
    const r = this.stage.getBoundingClientRect(),
      k = (r.width || this.sw) / this.sw;
    return { x: r.left + x * k, y: r.top + y * k };
  }
}

export interface GestureCallbacks {
  /** a tap (or a long press when `long`) at a client point */
  tap(cx: number, cy: number, long: boolean): void;
  /** true while a mouse should act as a mouse (native buttons) instead of as a finger; default: it acts as a finger */
  nativeMouse?(): boolean;
  /** a native mouse click (button 0 left, 2 right) at a client point */
  click?(cx: number, cy: number, button: 0 | 2): void;
}
const SLOP = 10,
  LONG_MS = 450;

/** one finger drags, two fingers pinch (and drag), a short still touch is a tap, a long still touch is a long press */
export function attachGestures(V: Viewport, cb: GestureCallbacks) {
  const el = V.vp,
    ptrs = new Map<number, Pt>();
  let start: (Pt & { t: number }) | null = null,
    moved = false,
    fired = false,
    longT = 0;
  let pinch: { d: number; s: number; m: Pt } | null = null;
  let vel = { x: 0, y: 0 },
    last = { t: 0, x: 0, y: 0 },
    raf = 0;
  const stopInertia = () => {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
  const mid = () => {
    const a = [...ptrs.values()];
    return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2, d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) };
  };
  const local = (p: Pt) => {
    const r = el.getBoundingClientRect();
    return { x: p.x - r.left, y: p.y - r.top };
  };

  /** native mouse: the left and right buttons are plain clicks (a drag is a text selection), the middle button drags the view */
  const isNative = (e: PointerEvent) => e.pointerType === 'mouse' && !!cb.nativeMouse?.();
  let nat: { id: number; x: number; y: number; button: number; moved: boolean; pan?: Pt } | null = null;
  el.addEventListener('mousedown', (e) => {
    if (e.button === 1 && cb.nativeMouse?.()) e.preventDefault();
  }); // no browser autoscroll circle
  el.addEventListener('auxclick', (e) => {
    if (e.button === 1 && cb.nativeMouse?.()) e.preventDefault();
  });
  el.addEventListener('pointerdown', (e) => {
    if (isNative(e)) {
      stopInertia();
      clearTimeout(longT);
      ptrs.clear();
      pinch = null;
      nat = { id: e.pointerId, x: e.clientX, y: e.clientY, button: e.button, moved: false };
      if (e.button === 1) {
        nat.pan = { x: e.clientX, y: e.clientY };
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        el.classList.add('panning');
      }
      return;
    }
    stopInertia();
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    clearTimeout(longT);
    if (ptrs.size === 1) {
      start = { x: e.clientX, y: e.clientY, t: performance.now() };
      moved = false;
      fired = false;
      vel = { x: 0, y: 0 };
      last = { t: start.t, x: e.clientX, y: e.clientY };
      longT = window.setTimeout(() => {
        if (!moved && !fired && ptrs.size === 1 && start) {
          fired = true;
          cb.tap(start.x, start.y, true);
        }
      }, LONG_MS);
    } else if (ptrs.size === 2) {
      moved = true;
      const m = mid();
      pinch = { d: m.d || 1, s: V.s, m: { x: m.x, y: m.y } };
    }
  });
  el.addEventListener('pointermove', (e) => {
    if (nat && nat.id === e.pointerId) {
      if (nat.pan) {
        V.panBy(e.clientX - nat.pan.x, e.clientY - nat.pan.y);
        nat.pan = { x: e.clientX, y: e.clientY };
      } else if (!nat.moved && Math.hypot(e.clientX - nat.x, e.clientY - nat.y) > 4) nat.moved = true;
      return;
    }
    const prev = ptrs.get(e.pointerId);
    if (!prev) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size >= 2 && pinch) {
      const m = mid(),
        pl = local(pinch.m),
        ml = local(m);
      V.zoomAbout(pinch.s * (m.d / pinch.d), pl.x, pl.y); // zoom about the old midpoint, then follow the midpoint's own movement
      V.panBy(ml.x - pl.x, ml.y - pl.y);
      pinch.m = { x: m.x, y: m.y };
      return;
    }
    if (!start || ptrs.size !== 1) return;
    if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP) {
      moved = true;
      clearTimeout(longT);
    }
    if (!moved) return;
    const dx = e.clientX - prev.x,
      dy = e.clientY - prev.y;
    const now = performance.now(),
      dt = Math.max(1, now - last.t);
    vel = { x: 0.6 * vel.x + 0.4 * (dx / dt), y: 0.6 * vel.y + 0.4 * (dy / dt) };
    last = { t: now, x: e.clientX, y: e.clientY };
    V.panBy(dx, dy);
  });
  const end = (e: PointerEvent, cancelled: boolean) => {
    if (nat && nat.id === e.pointerId) {
      const n = nat;
      nat = null;
      el.classList.remove('panning');
      if (!cancelled && !n.moved && !n.pan && (n.button === 0 || n.button === 2))
        cb.click?.(e.clientX, e.clientY, n.button);
      return;
    }
    if (!ptrs.has(e.pointerId)) return;
    const wasOne = ptrs.size === 1;
    ptrs.delete(e.pointerId);
    clearTimeout(longT);
    if (ptrs.size < 2) pinch = null;
    if (!wasOne) return;
    if (cancelled) return;
    if (!moved && !fired && start) {
      cb.tap(e.clientX, e.clientY, false);
      return;
    }
    if (moved && performance.now() - last.t < 80 && Math.hypot(vel.x, vel.y) > 0.3) {
      // fling
      const step = (t0: number) => (t: number) => {
        const dt = Math.min(32, t - t0);
        vel.x *= Math.pow(0.95, dt / 16);
        vel.y *= Math.pow(0.95, dt / 16);
        V.panBy(vel.x * dt, vel.y * dt);
        raf = Math.hypot(vel.x, vel.y) > 0.05 ? requestAnimationFrame(step(t)) : 0;
      };
      raf = requestAnimationFrame(step(performance.now()));
    }
  };
  el.addEventListener('pointerup', (e) => end(e, false));
  el.addEventListener('pointercancel', (e) => end(e, true));
  // the browser still sends its own click after a tap, and Chrome adjusts it to a nearby link: the game never sees it
  el.addEventListener(
    'click',
    (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  return { stopInertia };
}
