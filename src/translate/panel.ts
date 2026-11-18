/**
 * The translation side panel (translation tier, DOM). An overlay on the right edge of the page, closed by default: swipe out from the right
 * edge to open, swipe right on the panel to close, or use the tab button / Esc. Created only when the feature is switched on.
 */
import type { Entry } from './types';

const MAX_ENTRIES = 300;
const CSS = `#tlpanel{position:fixed;top:0;right:0;bottom:0;width:min(420px,92vw);z-index:60;background:#14161cf8;color:#dde;border-left:1px solid #556;transform:translateX(100%);transition:transform .18s ease;display:flex;flex-direction:column;font-size:14px;touch-action:pan-y}
#tlpanel.open{transform:none}#tlhead{display:flex;gap:6px;align-items:center;padding:6px 10px;border-bottom:1px solid #445;font-size:12px;color:#9ab}#tlhead .sp{flex:1}
#tlhead button{background:#222;color:#ddd;border:1px solid #666;cursor:pointer;font-size:12px;padding:1px 6px}
#tllist{flex:1;overflow-y:auto;padding:6px 10px;overscroll-behavior:contain}
.tle{margin:0 0 9px;padding-bottom:7px;border-bottom:1px solid #2a2d38}.tls{font-size:11px;color:#778;white-space:pre-wrap;word-break:break-word}.tlt{white-space:pre-wrap;word-break:break-word}.tle.flag .tlt{color:#cba;font-style:italic}#tllist.cp{user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}#tllist.cp .tle{cursor:pointer}.tle.sel{background:#2a3a55}.tle.ok{background:#2a3a55}.tle.bad{background:#5a2a2a}.tle{transition:background .1s ease-out}
#tltab{position:fixed;right:0;top:46%;z-index:59;background:#222c;color:#ddd;border:1px solid #666;border-right:0;border-radius:6px 0 0 6px;padding:10px 3px;cursor:pointer;font-size:12px;writing-mode:vertical-rl}#tltab[hidden]{display:none}`;

export interface Panel {
  setCopy(on: boolean): void;
  add(e: Entry): void;
  update(e: Entry): void;
  clear(): void;
  open(v?: boolean): void;
  setStatus(s: string): void;
  destroy(): void;
  readonly isOpen: boolean;
}

export function createPanel(doc: Document = document): Panel {
  const style = doc.createElement('style');
  style.textContent = CSS;
  doc.head.appendChild(style);
  const root = doc.createElement('aside');
  root.id = 'tlpanel';
  root.innerHTML =
    '<div id="tlhead"><b>Translation</b><span id="tlstat"></span><span class="sp"></span><button id="tlclr" title="Empty this list (the saved translations are kept)">clear</button><button id="tlx" title="Close (Esc, or swipe right)">close</button></div><div id="tllist"></div>';
  const tab = doc.createElement('button');
  tab.id = 'tltab';
  tab.textContent = 'Translation';
  tab.title = 'Open the translation panel (or swipe in from the right edge)';
  doc.body.append(root, tab);
  const list = root.querySelector<HTMLElement>('#tllist')!,
    stat = root.querySelector<HTMLElement>('#tlstat')!;
  const rows = new Map<number, { el: HTMLElement; s: HTMLElement; t: HTMLElement; src: string }>();
  const order: number[] = [];
  let isOpen = false;

  const open = (v = !isOpen) => {
    isOpen = v;
    root.classList.toggle('open', v);
    tab.hidden = v;
    if (v) list.scrollTop = list.scrollHeight;
  };
  tab.onclick = () => open(true);
  (root.querySelector('#tlx') as HTMLElement).onclick = () => open(false);
  (root.querySelector('#tlclr') as HTMLElement).onclick = () => clear();
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && isOpen) open(false);
  };
  doc.addEventListener('keydown', onKey);

  // swipe: a touch that starts within 28px of the right edge and moves left opens; a rightward move on the open panel closes
  let sx = 0,
    sy = 0,
    tracking: 'open' | 'close' | null = null;
  const ts = (e: TouchEvent) => {
    const t = e.touches[0];
    sx = t.clientX;
    sy = t.clientY;
    tracking =
      !isOpen && sx > (doc.defaultView?.innerWidth ?? 0) - 28
        ? 'open'
        : isOpen && root.contains(e.target as Node)
          ? 'close'
          : null;
  };
  const tm = (e: TouchEvent) => {
    if (!tracking) return;
    const t = e.touches[0],
      dx = t.clientX - sx,
      dy = t.clientY - sy;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (tracking === 'open' && dx < 0) open(true);
    else if (tracking === 'close' && dx > 0) open(false);
    tracking = null;
  };
  doc.addEventListener('touchstart', ts, { passive: true });
  doc.addEventListener('touchmove', tm, { passive: true });

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
    // keep ids in order even when a result arrives late
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
  // ---- copy (opt-in): tap a row = its Japanese; hold = from that row to the newest; hold the newest row = the newest 50
  let copyOn = false,
    baseStatus = '',
    noteTimer: ReturnType<typeof setTimeout> | null = null;
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
    return i === order.length - 1 ? order.slice(-50) : order.slice(i); // the newest row alone would be one line: it means "the newest 50"; any other row means "from here to the newest"
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
    MOVE_PX = 8;
  let press: {
    id: number;
    x: number;
    y: number;
    t: number;
    armed: boolean;
    ids: number[];
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  const unmark = () => {
    for (const r of rows.values()) r.el.classList.remove('sel');
  };
  /** the rows flash the same blue as the hold highlight once copied (red when the browser refused), so a tap and a hold give the same feedback */
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
  const pd = (e: PointerEvent) => {
    if (!copyOn || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const id = rowOf(e.target);
    if (id < 0) return;
    endPress();
    const p = { id, x: e.clientX, y: e.clientY, t: Date.now(), armed: false, ids: [] as number[], timer: 0 as any };
    p.timer = setTimeout(() => {
      p.armed = true;
      p.ids = rangeFor(id);
      unmark();
      for (const k of p.ids) rows.get(k)?.el.classList.add('sel');
      note(`release to copy ${p.ids.length} line${p.ids.length === 1 ? '' : 's'}`, 0);
    }, HOLD_MS);
    press = p;
  };
  const pm = (e: PointerEvent) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_PX) {
      endPress();
      if (noteTimer) {
        clearTimeout(noteTimer);
        noteTimer = null;
      }
      stat.textContent = baseStatus;
    }
  };
  const pu = async () => {
    const p = press;
    if (!p) return;
    press = null;
    clearTimeout(p.timer);
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
  };
  list.addEventListener('pointerdown', pd);
  list.addEventListener('pointermove', pm);
  list.addEventListener('pointerup', () => {
    void pu();
  });
  list.addEventListener('pointercancel', () => {
    endPress();
    if (noteTimer) {
      clearTimeout(noteTimer);
      noteTimer = null;
    }
    stat.textContent = baseStatus;
  });
  list.addEventListener('pointerleave', () => {
    if (press) {
      endPress();
      stat.textContent = baseStatus;
    }
  });
  list.addEventListener('contextmenu', (e) => {
    if (copyOn) e.preventDefault();
  });
  const setCopy = (on: boolean) => {
    copyOn = on;
    list.classList.toggle('cp', on);
    if (!on) endPress();
  };

  return {
    setCopy,
    add,
    update,
    clear,
    open,
    get isOpen() {
      return isOpen;
    },
    setStatus: (s) => {
      baseStatus = s ? '· ' + s : '';
      if (!noteTimer) stat.textContent = baseStatus;
    },
    destroy: () => {
      doc.removeEventListener('keydown', onKey);
      doc.removeEventListener('touchstart', ts);
      doc.removeEventListener('touchmove', tm);
      root.remove();
      tab.remove();
      style.remove();
    },
  };
}
