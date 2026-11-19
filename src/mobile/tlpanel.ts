/**
 * The phone translation panel. Plugged into the `Translation` through `makePanel`; it implements the `Panel` interface.
 * A small semi-transparent tab on the left edge (about 38% down, clear of the games' own buttons near the bottom) opens an opaque panel that covers the game
 * area, leaving a sliver on the right. While open the game cannot be touched, typed into or scrolled (the game parts are `inert`); the list scrolls by itself.
 * Opening: tap the tab or drag it. Closing: tap the tab or the sliver, drag the tab back, Esc, or the close button.
 * Docked layout (always on a desktop; on a phone by choice): the panel is a column on the right beside the game, which stays usable; the game is fitted to the width that is left.
 * On a fine pointer the toggle is a header button instead of the edge tab; so it is on a phone in the docked layout. Switching translation off collapses the panel.
 * Copy (opt-in): tap a line = its Japanese; hold = from that line to the newest; hold the newest = the newest 50. A drag or a scroll never copies.
 */
import type { Panel } from '../translate/panel';
import type { Entry } from '../translate/types';

const MAX_ENTRIES = 300,
  SLIVER = 28;
const CSS = `
#tlpanel{position:absolute;top:0;bottom:0;left:0;width:calc(100% - ${SLIVER}px);z-index:20;background:var(--bg,#14161c);color:var(--text,#dde);border-right:1px solid var(--line2,#556);transform:translateX(-100%);transition:transform .18s ease;display:flex;flex-direction:column;font-family:var(--mono,monospace);font-size:13px;line-height:1.45}
#tlpanel.open{transform:none}#tlpanel.drag,#tltab.drag{transition:none}
#tlhead{display:flex;gap:6px;align-items:center;padding:4px 8px;background:var(--sheet,#14161c);border-bottom:1px solid var(--line,#445);font-family:var(--ui,inherit);font-size:12px;color:var(--dim,#9ab);min-height:44px}#tlhead .sp{flex:1}
#tlhead b{color:var(--head,#dde);font-size:var(--h3s,12px);font-weight:var(--h3w,700);letter-spacing:var(--h3ls,0);white-space:nowrap}#tlhead b::after{content:"_";color:var(--accent,#5c82c4);margin-left:2px}
#tlstat{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
#tlhead button{background:var(--btn,#222);color:var(--text,#ddd);border:var(--bw,1px) solid var(--line2,#666);border-radius:var(--r,6px);cursor:pointer;font-family:inherit;font-size:13px;min-height:36px;padding:0 10px}
#tllist{flex:1;overflow-y:auto;padding:0;overscroll-behavior:contain;touch-action:pan-y}
.tle{margin:0;padding:8px;border-bottom:1px dashed var(--line2,#2a2d38);transition:background .1s ease-out}.tls{font-size:11px;color:var(--dim,#778);white-space:pre-wrap;word-break:break-word}.tlt{color:var(--text,inherit);white-space:pre-wrap;word-break:break-word}.tle.flag .tlt{color:var(--warn,#cba)}
#tllist.cp{user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}#tllist.cp .tle{cursor:pointer}.tle.sel,.tle.ok{background:var(--accentbg,#2a3a55)}.tle.bad{background:var(--errbg,#5a2a2a)}
#tlshut{position:absolute;top:0;bottom:0;right:0;width:${SLIVER}px;z-index:19;display:none}#tlshut.on{display:block}
#tltab{position:absolute;left:0;top:clamp(8px,38%,calc(100% - 70px));width:22px;height:54px;z-index:21;padding:0;display:flex;align-items:center;justify-content:center;background:var(--tabbg,rgba(34,44,60,.22));color:var(--text,#dde);border:1px solid var(--tabline,rgba(120,130,150,.25));border-left:0;border-radius:0 var(--rt,9px) var(--rt,9px) 0;touch-action:none;cursor:pointer;transition:left .18s ease,background .18s,border-color .18s}
#tltab[hidden]{display:none}#tltab svg{opacity:.3;pointer-events:none;transition:opacity .18s}#tltab:active,#tltab.drag{background:var(--tabbg2,rgba(34,44,60,.7));border-color:var(--line2,rgba(120,130,150,.6))}#tltab:active svg,#tltab.drag svg{opacity:.85}
#tltab.open{left:calc(100% - ${SLIVER}px);background:var(--tabbg2,rgba(34,44,60,.92));border-color:var(--tabline2,rgba(120,130,150,.55))}#tltab.open svg{opacity:.9;color:var(--atext,inherit)}
#tlpanel.dock{position:relative;top:auto;bottom:auto;left:auto;width:var(--tlw,380px);flex:none;z-index:auto;transform:none;transition:none;border-right:0;border-left:1px solid var(--line2,#556)}#tlpanel.dock:not(.open){display:none}
#tldiv{display:none;position:absolute;left:-8px;top:0;bottom:0;width:16px;cursor:col-resize;touch-action:none;z-index:2}#tlpanel.dock #tldiv{display:block}#tldiv:hover,#tldiv.drag{background:var(--accentbg,rgba(92,130,196,.35))}
#tlpanel.dock #tlx{display:none}
`;
const ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0014.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/></svg>';

export interface MobilePanelOpts {
  /** the element the panel lives in (positioned; the game area) */
  host: HTMLElement;
  /** elements to make inert while the panel is open (game area, direction pad, custom buttons, input bar, quick inputs) */
  lock: HTMLElement[];
  /** the flex row that holds the game area and, when docked, the panel */
  row: HTMLElement;
  /** the header button (shown on a fine pointer; the edge tab is used on touch) */
  button: HTMLElement;
  /** is the pointer a mouse (header button) rather than a finger (edge tab) */
  fine(): boolean;
  /** wanted layout now: true = docked beside the game */
  dock(): boolean;
  /** called when the panel opens or closes or its layout changes (docked: the game is fitted to what is left) */
  onOpen?(open: boolean, docked: boolean): void;
  /** the number of cached (saved) translated lines for the game, whenever the engine reports it */
  onCount?(n: number): void;
}

/** the panel plus a way to re-read the layout choice (window resized, setting changed) */
export type MobilePanel = Panel & { relayout(): void };

export function createMobilePanel(o: MobilePanelOpts): MobilePanel {
  const doc = o.host.ownerDocument;
  const style = doc.createElement('style');
  style.textContent = CSS;
  doc.head.appendChild(style);
  const root = doc.createElement('aside');
  root.id = 'tlpanel';
  root.innerHTML =
    '<div id="tlhead"><b>Translation</b><span id="tlstat"></span><span class="sp"></span><button id="tlclr" type="button" title="Empty this list (the cached lines are kept)">clear</button><button id="tlx" type="button" title="Close">close</button></div><div id="tllist"></div>';
  const tab = doc.createElement('button');
  tab.id = 'tltab';
  tab.type = 'button';
  tab.title = 'Translation';
  tab.innerHTML = ICON;
  const shut = doc.createElement('div');
  shut.id = 'tlshut';
  const div = doc.createElement('div');
  div.id = 'tldiv';
  div.title = 'Drag to resize';
  root.prepend(div);
  o.host.append(shut, root, tab);
  const list = root.querySelector<HTMLElement>('#tllist')!,
    stat = root.querySelector<HTMLElement>('#tlstat')!;
  const rows = new Map<number, { el: HTMLElement; s: HTMLElement; t: HTMLElement; src: string }>();
  const order: number[] = [];
  let isOpen = false;

  let docked = false,
    gone = false; // gone: destroyed (translation switched off); nothing may touch the header button or the layout any more
  const W_KEY = 'emu.tl.w',
    OPEN_KEY = 'emu.tl.open';
  const ls = (k: string, v?: string) => {
    try {
      if (v === undefined) return localStorage.getItem(k);
      localStorage.setItem(k, v);
    } catch {
      /* storage unavailable */
    }
    return null;
  };
  const clampW = (w: number) =>
    Math.max(240, Math.min(w, Math.max(240, Math.floor(o.row.clientWidth * (o.fine() ? 0.6 : 0.55)))));
  const setW = () => {
    const w = Number(ls(W_KEY)) || 380;
    root.style.setProperty('--tlw', clampW(w) + 'px');
  };
  const sync = () => {
    if (gone) return;
    root.classList.toggle('open', isOpen);
    tab.classList.toggle('open', isOpen);
    shut.classList.toggle('on', isOpen && !docked);
    o.button.classList.toggle('on', isOpen);
    tab.hidden = docked || o.fine();
    o.button.hidden = !(o.fine() || docked); // a mouse, or the side-by-side layout (the edge tab only exists for the overlay)
    for (const el of o.lock) el.toggleAttribute('inert', isOpen && !docked); // docked: the game stays usable
  };
  const open = (v = !isOpen) => {
    if (v === isOpen) return;
    isOpen = v;
    sync();
    if (!docked && v) (doc.activeElement as HTMLElement | null)?.blur?.();
    if (v) list.scrollTop = list.scrollHeight;
    if (docked) ls(OPEN_KEY, v ? '1' : '0');
    o.onOpen?.(v, docked);
  };
  /** (re)read the wanted layout: move the panel between the game area (overlay) and the row beside it (docked) */
  const relayout = () => {
    if (gone) return;
    const want = o.dock();
    if (want !== docked) {
      docked = want;
      root.classList.toggle('dock', docked);
      if (docked) {
        o.row.append(root);
        if (!isOpen && ls(OPEN_KEY) !== '0') isOpen = true;
      } // docked: open unless the user closed it last time (switching translation off resets that, see destroy)
      else {
        o.host.append(shut, root, tab);
        root.style.removeProperty('--tlw');
        isOpen = false; // leaving the side-by-side layout must not pop the panel up over the game and the header
      }
    }
    if (docked) setW();
    sync();
    o.onOpen?.(isOpen, docked);
  };
  o.button.onclick = () => open();
  (root.querySelector('#tlx') as HTMLElement).onclick = () => open(false);
  (root.querySelector('#tlclr') as HTMLElement).onclick = () => clear();
  shut.onclick = () => open(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && isOpen && !docked) open(false);
  };
  doc.addEventListener('keydown', onKey);
  const onWin = () => relayout();
  doc.defaultView?.addEventListener('resize', onWin);
  // divider: drag to resize the docked panel (remembered)
  let dv: { id: number; x0: number; w0: number } | null = null;
  div.addEventListener('pointerdown', (e) => {
    dv = { id: e.pointerId, x0: e.clientX, w0: root.offsetWidth };
    div.setPointerCapture?.(e.pointerId);
    div.classList.add('drag');
    e.preventDefault();
  });
  div.addEventListener('pointermove', (e) => {
    if (!dv || e.pointerId !== dv.id) return;
    root.style.setProperty('--tlw', clampW(dv.w0 - (e.clientX - dv.x0)) + 'px');
    o.onOpen?.(isOpen, docked);
  });
  const endDiv = (e: PointerEvent) => {
    if (!dv || e.pointerId !== dv.id) return;
    dv = null;
    div.classList.remove('drag');
    ls(W_KEY, String(root.offsetWidth));
  };
  div.addEventListener('pointerup', endDiv);
  div.addEventListener('pointercancel', endDiv);

  // tab: tap toggles, drag follows the finger (released past the middle it opens, otherwise it springs back)
  let drag: { x0: number; pos0: number; moved: boolean; id: number } | null = null;
  const width = () => root.offsetWidth;
  tab.addEventListener('pointerdown', (e) => {
    drag = { x0: e.clientX, pos0: isOpen ? width() : 0, moved: false, id: e.pointerId };
    tab.setPointerCapture?.(e.pointerId);
  });
  tab.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    if (!drag.moved && Math.abs(dx) < 6) return;
    drag.moved = true;
    root.classList.add('drag');
    tab.classList.add('drag');
    const pos = Math.max(0, Math.min(width(), drag.pos0 + dx));
    root.style.transform = `translateX(${pos - width()}px)`;
    tab.style.left = pos + 'px';
  });
  const endDrag = (e: PointerEvent, cancel: boolean) => {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    drag = null;
    tab.releasePointerCapture?.(e.pointerId);
    const was = isOpen;
    root.classList.remove('drag');
    tab.classList.remove('drag');
    const pos = Math.max(0, Math.min(width(), d.pos0 + (e.clientX - d.x0)));
    root.style.transform = '';
    tab.style.left = '';
    if (cancel) return;
    if (!d.moved) open(!was);
    else open(was ? pos > width() * 0.65 : pos > width() * 0.35);
  };
  tab.addEventListener('pointerup', (e) => endDrag(e, false));
  tab.addEventListener('pointercancel', (e) => endDrag(e, true));

  const render = (r: { el: HTMLElement; s: HTMLElement; t: HTMLElement; src: string }, e: Entry) => {
    r.src = e.src;
    r.s.textContent = e.src;
    r.t.textContent = e.tr ?? '…';
    r.el.className = 'tle' + (e.tr === undefined ? ' wait' : e.flagged ? ' flag' : '');
  };
  const add = (e: Entry) => {
    if (rows.has(e.id)) return update(e);
    const el = doc.createElement('div'),
      s = doc.createElement('div'),
      t = doc.createElement('div');
    s.className = 'tls';
    t.className = 'tlt';
    el.append(s, t);
    const r = { el, s, t, src: e.src };
    render(r, e);
    rows.set(e.id, r);
    order.push(e.id);
    const near = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    const prev = order.length > 1 ? order[order.length - 2] : undefined;
    if (prev !== undefined && prev > e.id) {
      order.sort((a, b) => a - b);
      const idx = order.indexOf(e.id);
      const next = rows.get(order[idx + 1]);
      list.insertBefore(el, next ? next.el : null);
    } else list.appendChild(el);
    while (order.length > MAX_ENTRIES) {
      const old = order.shift()!;
      rows.get(old)?.el.remove();
      rows.delete(old);
    }
    if (near && isOpen) list.scrollTop = list.scrollHeight;
  };
  const update = (e: Entry) => {
    const r = rows.get(e.id);
    if (r) render(r, e);
    else add(e);
  };
  const clear = () => {
    rows.clear();
    order.length = 0;
    list.textContent = '';
  };

  // ---- copy (opt-in). Same gestures as the desktop panel; additionally a press is dropped when the list is scrolling or has moved, so a drag or a fling-stop tap never copies.
  let copyOn = false,
    baseStatus = '',
    noteTimer: ReturnType<typeof setTimeout> | null = null,
    lastScroll = 0;
  list.addEventListener(
    'scroll',
    () => {
      lastScroll = Date.now();
    },
    { passive: true },
  );
  const note = (msg: string, ms = 2200) => {
    if (noteTimer) clearTimeout(noteTimer);
    stat.textContent = '· ' + msg;
    noteTimer = ms
      ? setTimeout(() => {
          noteTimer = null;
          stat.textContent = baseStatus;
        }, ms)
      : null;
  };
  const rangeFor = (id: number): number[] => {
    const i = order.indexOf(id);
    if (i < 0) return [];
    return i === order.length - 1 ? order.slice(-50) : order.slice(i);
  };
  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall back below */
    }
    try {
      const ta = doc.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      doc.body.appendChild(ta);
      ta.select();
      const ok = doc.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  };
  const HOLD_MS = 450,
    MOVE_PX = 8,
    FLING_MS = 160;
  let press: {
    id: number;
    x: number;
    y: number;
    st: number;
    armed: boolean;
    ids: number[];
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  const unmark = () => {
    for (const r of rows.values()) r.el.classList.remove('sel');
  };
  const flash = (ids: number[], ok: boolean) => {
    const cls = ok ? 'ok' : 'bad';
    for (const k of ids) {
      const el = rows.get(k)?.el;
      if (el) {
        el.classList.remove('sel');
        el.classList.add(cls);
      }
    }
    setTimeout(() => {
      for (const k of ids) rows.get(k)?.el.classList.remove(cls);
    }, 260);
  };
  const resetStat = () => {
    if (noteTimer) {
      clearTimeout(noteTimer);
      noteTimer = null;
    }
    stat.textContent = baseStatus;
  };
  const endPress = () => {
    if (press) {
      clearTimeout(press.timer);
      press = null;
    }
    unmark();
  };
  const rowOf = (el: EventTarget | null) => {
    const n = (el as HTMLElement | null)?.closest?.('.tle');
    if (!n) return -1;
    for (const [id, r] of rows) if (r.el === n) return id;
    return -1;
  };
  list.addEventListener('pointerdown', (e) => {
    if (!copyOn || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const id = rowOf(e.target);
    if (id < 0) return;
    endPress();
    if (Date.now() - lastScroll < FLING_MS) return; // this touch is stopping a fling: it is not a tap on a line
    const p = {
      id,
      x: e.clientX,
      y: e.clientY,
      st: list.scrollTop,
      armed: false,
      ids: [] as number[],
      timer: 0 as unknown as ReturnType<typeof setTimeout>,
    };
    p.timer = setTimeout(() => {
      p.armed = true;
      p.ids = rangeFor(id);
      unmark();
      for (const k of p.ids) rows.get(k)?.el.classList.add('sel');
      note(`release to copy ${p.ids.length} line${p.ids.length === 1 ? '' : 's'}`, 0);
    }, HOLD_MS);
    press = p;
  });
  list.addEventListener('pointermove', (e) => {
    if (
      press &&
      (Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_PX || Math.abs(list.scrollTop - press.st) > 2)
    ) {
      endPress();
      resetStat();
    }
  });
  list.addEventListener('pointerup', async () => {
    const p = press;
    if (!p) return;
    press = null;
    clearTimeout(p.timer);
    if (Math.abs(list.scrollTop - p.st) > 2) {
      unmark();
      resetStat();
      return;
    } // the list moved under the finger: a scroll
    const ids = p.armed ? p.ids : [p.id];
    const text = ids
      .map((k) => rows.get(k)?.src ?? '')
      .filter(Boolean)
      .join('\n');
    if (!text) {
      unmark();
      return;
    }
    const ok = await copyText(text);
    unmark();
    flash(ids, ok);
    note(
      ok ? (ids.length === 1 ? 'copied the line' : `copied ${ids.length} lines`) : 'copy was blocked by the browser',
    );
  });
  list.addEventListener('pointercancel', () => {
    endPress();
    resetStat();
  });
  list.addEventListener('contextmenu', (e) => {
    if (copyOn) e.preventDefault();
  });
  const setCopy = (on: boolean) => {
    copyOn = on;
    list.classList.toggle('cp', on);
    if (!on) endPress();
  };

  relayout();
  return {
    setCopy,
    add,
    update,
    clear,
    open,
    relayout,
    get isOpen() {
      return isOpen;
    },
    setStatus: (s) => {
      // the engine reports "ready, N saved" / "N saved": the count is not for the panel (it goes to the control panel's clear button), the rest is
      const m = /(?:^|,\s*)(\d+) saved$/.exec(s);
      if (m) {
        o.onCount?.(Number(m[1]));
        s = s.slice(0, m.index);
      }
      baseStatus = s ? '· ' + s : '';
      if (!noteTimer) stat.textContent = baseStatus;
    },
    destroy: () => {
      gone = true;
      isOpen = false;
      ls(OPEN_KEY, '1'); // switched off = collapsed; switching it on again opens it (docked layout)
      docked = false;
      for (const el of o.lock) el.removeAttribute('inert');
      o.onOpen?.(false, false);
      doc.removeEventListener('keydown', onKey);
      doc.defaultView?.removeEventListener('resize', onWin);
      o.button.hidden = true;
      o.button.classList.remove('on');
      o.button.onclick = null;
      root.remove();
      tab.remove();
      shut.remove();
      style.remove();
    },
  };
}
