/** Mobile shell: a pan/zoom game viewport and a touch UI around the `Client` and `createScreenView`. */
import { OPTION_DEFS, type ScreenMsg, type StartOptions } from '../host/protocol';
import { Client } from '../host/client';
import { promptClass } from '../host/screen';
import { createScreenView, type Rect } from '../host/web/screenview';
import { Viewport, attachGestures } from './viewport';
import { pickButton } from './assist';
import { GameLoader, NoGameError, type Source } from '../host/web/gamezip';
import { activeSources } from '../host/web/packs';
import { Translation } from '../translate';
import { createMobilePanel, type MobilePanel } from './tlpanel';
import { LOG_CAP_DESKTOP, LOG_CAP_MOBILE } from '../host/web/logcap';
import { createPacks, fmtSize } from './packs';
import { createAudioPlayer } from '../host/web/audio';
import { createMemory } from './memory';
import { createPatches } from './patches';
import { attachDrop } from './drop';
import { FontRegistry, type FontEntry } from '../host/web/fonts';
import { FontStore } from '../host/web/fontstore';
import { familyKey } from '../host/screen';
// @ts-ignore injected by the build script
declare const WORKER_SRC: string;
// @ts-ignore injected by the build script: bundled OFL fonts as base64
declare const BUNDLED_FONTS: { file: string; b64: string }[];

const $ = (id: string) => document.getElementById(id)!;
const lsGet = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
};
const hhmmss = (t = Date.now()) => new Date(t).toTimeString().slice(0, 8);
const download = (name: string, body: BlobPart, type: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// ---------------------------------------------------------------- status, busy, debug issues
const statusEl = $('status'),
  busyEl = $('busy');
const say = (m: string) => {
  statusEl.textContent = m;
};
let busyNow = false;
const setBusy = (b: boolean) => {
  busyNow = b;
  busyEl.hidden = !b;
  tl?.setIdle(!b);
};
let tlPanel: MobilePanel | undefined;
let tlOpen = false; // the translation panel is open: the game is locked
let tl: Translation | null = null; // the optional translation module (created below; inert until switched on)

type Issue = { t: number; level: 'warn' | 'error'; text: string };
const issues: Issue[] = [];
let crashSnap = '',
  crashText = '';
/** the page build and the translation switch are known only to the page: added under the report's engine line (the `withPageInfo`) */
const withPageInfo = (text: string) =>
  text.replace(
    /^(engine: .*)$/m,
    (line) => `${line}\npage: ${$('build').textContent}\ntranslation: ${tl?.enabled ? 'on' : 'off'}`,
  );
function addIssue(level: Issue['level'], text: string) {
  if (issues.some((i) => i.text === text)) return;
  issues.push({ t: Date.now(), level, text });
  if (issues.length > 300) issues.shift();
  refreshDebugBtn();
  if (!$('dbg').hidden) renderDebug();
}
function refreshDebugBtn() {
  const b = $('bdbg');
  b.classList.toggle(
    'err',
    issues.some((i) => i.level === 'error'),
  );
  b.classList.toggle('warn', issues.length > 0);
  b.querySelector('span')!.textContent = issues.length ? `dbg ${issues.length}` : 'dbg';
}
function renderDebug() {
  const list = $('dlist');
  list.textContent = '';
  if (!issues.length) {
    list.textContent = 'No issues reported.';
    list.className = 'small';
  } else list.className = '';
  for (const i of issues) {
    const d = document.createElement('div');
    d.className = 'dent ' + i.level;
    const t = document.createElement('time');
    t.textContent = hhmmss(i.t);
    d.append(t, i.text);
    list.appendChild(d);
  }
  ($('dsnap') as HTMLButtonElement).hidden = !crashSnap; // only after a crash
}

// ---------------------------------------------------------------- sheets (control panel / debug / input log)
const sheets = ['panel', 'dbg', 'ilog'],
  sheetBtn: Record<string, string> = { panel: 'bpanel', dbg: 'bdbg', ilog: 'bdbg' }; // the input log lives under the debug button (tabs inside the sheet)
function openSheet(id: string | null) {
  for (const s of sheets) $(s).hidden = s !== id;
  $('bpanel').classList.toggle('on', id === 'panel');
  $('bdbg').classList.toggle('on', id === 'dbg' || id === 'ilog');
  if (id === 'dbg') renderDebug();
  if (id === 'ilog') renderInputLog();
}
const toggleSheet = (id: string) => openSheet($(id).hidden ? id : null);
$('bpanel').onclick = () => toggleSheet('panel');
$('bdbg').onclick = () => openSheet($('dbg').hidden && $('ilog').hidden ? 'dbg' : null);
for (const [b, sheet] of [
  ['tabd', 'dbg'],
  ['tabd2', 'dbg'],
  ['tabi', 'ilog'],
  ['tabi2', 'ilog'],
])
  $(b).onclick = () => openSheet(sheet);
$('binp').onclick = () => {
  const f = $('inbar') as HTMLFormElement;
  f.hidden = !f.hidden;
  $('binp').classList.toggle('on', !f.hidden);
  lsSet('emu.inp', f.hidden ? '0' : '1');
}; // never focuses: the keyboard opens only when the field is tapped
// the top bar can hide (chevron at its right end): see `body.hdrc` in mobile.css
const hdrBtn = $('bhide');
let hdrCollapsed = lsGet('emu.hdr') === '1';
function applyHeader() {
  document.body.classList.toggle('hdrc', hdrCollapsed);
  hdrBtn.title = hdrCollapsed
    ? 'Show the top bar'
    : 'Hide the top bar (the tap mode, control panel and input buttons stay)';
}
hdrBtn.onclick = () => {
  hdrCollapsed = !hdrCollapsed;
  lsSet('emu.hdr', hdrCollapsed ? '1' : '0');
  applyHeader();
  if (hdrCollapsed && (!$('dbg').hidden || !$('ilog').hidden)) openSheet(null); // the debug button goes with the bar, so its sheet (and the input log tab) closes; the control panel button stays, so that sheet stays
};
applyHeader();
$('bfs').onclick = () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.().catch(() => {});
};

// ---------------------------------------------------------------- viewport + view + client
const stage = $('stage'),
  vp = $('vp');
const V = new Viewport(vp, $('pan'), stage);
const fonts = new FontRegistry();
fonts.aliasMsGothic = false; // the stack names MS Gothic first (an installed copy is used), bundled BIZ UDGothic follows as the fallback
let configFont = '';
/** The game window is the last `cfg.h` px of the stage (Emuera draws the newest line on the bottom edge, CBG layers and mouse y are measured from it).
 *  The view's layer canvases are window-sized and sit at the stage top, which is right for a window-sized container but not for the phone's
 *  `scroll: 'outer'` stage, as tall as the whole log: shift them down by the part of the stage above the window (`--cbgy`, used by mobile.css). */
let cfgH = 0;
function placeCbg() {
  stage.style.setProperty('--cbgy', Math.max(0, stage.offsetHeight - cfgH) + 'px');
  placeAbsShell();
}
/** Emuera.NET `<div display='absolute-lefttop' | 'absolute-leftbottom'>` boxes are `position:fixed` and the view puts them at screen pixels from the stage's on-screen rectangle.
 *  Inside our transformed pan layer a fixed box is positioned against that layer, so that maths lands twice scaled and shifted: place them in stage pixels instead,
 *  from the game window (its last `cfg.h` px: top-left corner, or bottom-left corner for `lb`). Runs after every render and after the view's own resize/scroll handler. */
function placeAbsShell() {
  const els = stage.querySelectorAll<HTMLElement>('[data-abs]');
  if (!els.length) return;
  const sh = stage.offsetHeight;
  for (const e of els) {
    const x = Number(e.dataset.ax),
      y = Number(e.dataset.ay);
    e.style.left = x + 'px';
    e.style.top = (e.dataset.abs === 'lb' ? sh + y : sh - cfgH + y) + 'px';
  }
}
/** natural stage y -> the engine's window-relative y (from the window's bottom edge, negative above it) */
const wy = (y: number) => Math.round(y) - V.sh;
const view = createScreenView(stage, {
  onPress: (v) => press(v),
  onConfig: (s) => {
    cfgH = s.h;
    stage.style.minHeight = s.h + 'px';
    stage.style.setProperty('--cfgh', s.h + 'px');
    placeCbg();
    if (s.font !== configFont) {
      configFont = s.font;
      renderFontUi();
    }
  },
  fontStack: (f, role) => fonts.stack(f, role),
  onContentHeight: () => {
    placeCbg();
    V.layoutChanged();
  },
  scroll: 'outer',
  bounds: () => ({ w: vp.clientWidth, h: vp.clientHeight }),
});
new ResizeObserver(() => V.layoutChanged()).observe(vp);
view.incremental = true; // lines drawn before keep their DOM (needs lineIds; the view falls back to a full redraw by itself)
window.addEventListener('resize', placeAbsShell);
window.addEventListener('scroll', placeAbsShell, true); // after the view's handlers (registered in createScreenView)
const logEl = view.root.querySelector('.emu-out') as HTMLElement;
/** the log is capped, so old lines drop off the top: when the user has scrolled up, keep the line at the top of the viewport where it is */
function holdScroll(): (() => void) | null {
  if (V.follow || !logEl) return null;
  const top = vp.getBoundingClientRect().top;
  for (const el of Array.from(logEl.children)) {
    const r = el.getBoundingClientRect();
    if (r.bottom > top)
      return () => {
        if (!el.isConnected) return;
        const d = el.getBoundingClientRect().top - r.top;
        if (Math.abs(d) > 0.5) {
          V.ty -= d;
          V.apply();
        }
      };
  }
  return null;
}

// autoUnlock off: on touch, Chrome counts pointerup (not pointerdown) as the user gesture, so unlock is called from our own pointerup
const player = createAudioPlayer({
  autoUnlock: false,
  onError: (f) => addIssue('warn', 'Incompatible sound file: ' + f),
});
addEventListener('pointerup', () => player.unlock(), true);
addEventListener('keydown', () => player.unlock(), true);
let lastBlob: { blob: Blob; name: string } | null = null;
let firstScreen = false;
let gameId = '';
let lineH = 19; // the game's line height in stage px (from the last screen's cfg)

const client: Client = new Client({
  screen: (m) => {
    onScreen(m);
    tl?.onScreen(m);
  },
  patches: (m) => patchUi.onReport(m),
  frame: (m) => {
    const hold = holdScroll();
    view.render(m as unknown as ScreenMsg);
    placeAbsShell();
    hold?.();
  }, // AWAIT animation frame: draw only (no status, notes, busy or input change)
  sound: (m) => player.handle(m),
  title: (t) => {
    document.title = t;
  },
  textbox: (m) => {
    if (m.op === 'clear') {
      inp.value = '';
      client.setInputText('');
    }
  }, // move/resume: the input window is not placed over the game
  status: (msg) => say(msg),
  busy: (b) => {
    setBusy(b);
    if (b) {
      refreshQuick();
      refreshInput();
    } else setTimeout(refreshInput, 0);
  },
  persist: (k, v) => memory.persist(k, v),
  persistFile: (k, t) => memory.persistFile(k, t),
  restart: () => {
    const f = lastBlob;
    if (f)
      setTimeout(() => {
        void load(f.blob, f.name);
      }, 0);
  },
  errreport: (text, snap) => {
    text = withPageInfo(text);
    crashText = text;
    crashSnap = snap;
    addIssue('error', text);
  },
  fatal: (msg) => {
    setBusy(false);
    say('Fatal error');
    crashText = withPageInfo('# Fatal error while loading\n\n```\n' + msg + '\n```');
    crashSnap = '';
    addIssue('error', msg);
    openSheet('dbg');
  },
  logexport: (text, snapshot) => {
    // an empty text means "snapshot only"; the log gets the page lines and, the resource loader section after it
    if (text)
      download(
        `playtest-log-${stamp()}.md`,
        withPageInfo(text) +
          (loaderLog.length
            ? '\n\n## Resource loader (load order: top to bottom, later overwrites earlier)\n\n```\n' +
              loaderLog.join('\n') +
              '\n```\n'
            : ''),
        'text/markdown',
      );
    if (snapshot) download(`playtest-state-${stamp()}.json`, snapshot, 'application/json');
  },
  inputLog: () => {
    if (!$('ilog').hidden) renderInputLog();
  },
  input: () => refreshQuick(),
});
const patchUi = createPatches();
const memory = createMemory({ client: () => client, say, problem: (m) => addIssue('error', m) });

function onScreen(m: ScreenMsg) {
  const hold = holdScroll();
  view.render(m);
  lineH = m.cfg.lineHeight;
  placeAbsShell();
  hold?.();
  for (const n of m.notes ?? []) addIssue('warn', n);
  if (m.missing?.length) addIssue('warn', 'missing sprites: ' + m.missing.slice(0, 8).join(', '));
  const k = m.kind;
  say(
    k === 'done'
      ? 'Game ended.'
      : k === 'error'
        ? 'Engine error (see debug).'
        : k === 'wait' || k === 'anykey'
          ? 'Waiting: tap to continue.'
          : 'Waiting for input (' + k + ').',
  );
  if (firstScreen) {
    firstScreen = false;
    if (($('autoclose') as HTMLInputElement).checked) openSheet(null);
  }
  setTimeout(() => {
    refreshInput();
    refreshQuick();
  }, 0); // client.kind is updated after this hook returns
}

// ---------------------------------------------------------------- sending input
function press(v: string) {
  send(v);
}
function send(v: string, raw = false): boolean {
  if (busyNow && !raw) return false; // the engine is working: a second tap or Send would queue a duplicate input
  const ok = client.submit(v, raw);
  if (ok) {
    inp.value = '';
    client.setInputText('');
  }
  return ok;
}
const inp = $('inp') as HTMLInputElement;
inp.oninput = () => client.setInputText(inp.value);
($('inbar') as HTMLFormElement).onsubmit = (e) => {
  e.preventDefault();
  if (!captureForUser(inp.value)) send(inp.value);
};
const BUSY_HINT = 'working...';
function refreshInput() {
  if (arming) return; // the user button is waiting for its value: keep that prompt
  if (busyNow) {
    inp.placeholder = BUSY_HINT;
    return;
  }
  const c = promptClass(client.kind);
  inp.inputMode = c === 'number' ? 'numeric' : 'text';
  inp.placeholder =
    c === 'number'
      ? 'number'
      : c === 'text'
        ? 'text'
        : c === 'any'
          ? 'number or text'
          : c === 'wait'
            ? 'wait'
            : c === 'mouse'
              ? 'wait (tap)'
              : 'input';
}

// ---------------------------------------------------------------- taps
type Mode = 'left' | 'right' | 'hover';
let mode: Mode = (['left', 'right', 'hover'].includes(lsGet('emu.mode') ?? '') ? lsGet('emu.mode') : 'left') as Mode;
const modeBtn = $('mode');
const showMode = () => {
  modeBtn.dataset.mode = mode;
  modeBtn.firstElementChild!.textContent = mode === 'left' ? 'L' : mode === 'right' ? 'R' : 'H';
  modeBtn.title =
    'Tap = ' + mode + ' (' + (mode === 'hover' ? 'long press clicks' : 'long press does the other click') + ')';
};
showMode();
modeBtn.onclick = () => {
  mode = mode === 'left' ? 'right' : mode === 'right' ? 'hover' : 'left';
  lsSet('emu.mode', mode);
  showMode();
  if (mode !== 'hover') leaveHover();
};
const assistChk = $('assist') as HTMLInputElement;
assistChk.checked = lsGet('emu.assist') !== '0';
assistChk.onchange = () => lsSet('emu.assist', assistChk.checked ? '1' : '0');
const btnChk = $('bbtn') as HTMLInputElement;
btnChk.checked = lsGet('emu.bbtn') === '1';
const applyBtn = () => {
  document.body.classList.toggle('bbtn', btnChk.checked);
  V.layoutChanged();
};
btnChk.onchange = () => {
  lsSet('emu.bbtn', btnChk.checked ? '1' : '0');
  applyBtn();
};
document.body.classList.toggle('bbtn', btnChk.checked);
document.fonts?.addEventListener('loadingdone', () => V.layoutChanged());
const autoChk = $('autoclose') as HTMLInputElement;
autoChk.checked = lsGet('emu.autoclose') !== '0';
autoChk.onchange = () => lsSet('emu.autoclose', autoChk.checked ? '1' : '0');

function flash(r: Rect | null, cls: string) {
  if (!r) return;
  const f = document.createElement('div');
  f.className = 'flash ' + cls;
  Object.assign(f.style, { left: r.x - 2 + 'px', top: r.y - 1 + 'px', width: r.w + 4 + 'px', height: r.h + 2 + 'px' });
  stage.appendChild(f);
  setTimeout(() => f.remove(), 400);
}
let hoverOn = false;
function leaveHover() {
  if (!hoverOn) return;
  hoverOn = false;
  view.hideTip();
  view.hoverAt(null, 0, 0);
  client.setPointing('');
}

function onTap(cx: number, cy: number, long: boolean, force?: 'left' | 'right') {
  const action: 'left' | 'right' | 'hover' = force ?? (long ? (mode === 'left' ? 'right' : 'left') : mode);
  const st = V.toStage(cx, cy),
    cls = promptClass(client.kind);
  const assist = assistChk.checked && (cls === 'number' || cls === 'text' || cls === 'any');
  if (action === 'hover') {
    const p = pickButton(view, st.x, st.y, V.s, assistChk.checked, lineH);
    const at = p ? V.toClient(p.rect.x + p.rect.w / 2, p.rect.y + p.rect.h / 2) : { x: cx, y: cy };
    const el = document.elementFromPoint(at.x, at.y);
    view.hideTip();
    view.hoverAt(null, 0, 0);
    view.hoverAt(el, at.x, at.y);
    hoverOn = !!p;
    client.setPointing(p && (p.button.kind === 'text' || p.button.kind === 'image') ? p.button.value : ''); // image buttons (and boxes inside a button) are pointed too
    const s2 = p ? { x: p.rect.x + p.rect.w / 2, y: p.rect.y + p.rect.h / 2 } : st;
    client.pointerMove(Math.round(s2.x), wy(s2.y));
    flash(p?.rect ?? null, 'h');
    return;
  }
  leaveHover();
  if (busyNow) return; // the engine is busy: ignore the tap (double taps would otherwise press twice)
  const p = pickButton(view, st.x, st.y, V.s, assist, lineH);
  const inside = st.x >= 0 && st.x < V.sw && st.y >= 0 && st.y < V.sh;
  const px = p ? Math.min(Math.max(st.x, p.rect.x + 1), p.rect.x + p.rect.w - 1) : st.x,
    py = p ? Math.min(Math.max(st.y, p.rect.y + 1), p.rect.y + p.rect.h - 1) : st.y;
  flash(p?.rect ?? null, action === 'right' ? 'r' : '');
  const consumed = client.pointerDown({
    button: action === 'right' ? 2 : 0,
    x: Math.round(px),
    y: wy(py),
    inside,
    onChrome: false,
    onControl: false,
    pointing: view.valueAt(px, py), // the game button under the press (topmost, so a popup box beats its full-screen catch-all); what INPUTMOUSEKEY reads as the clicked button
    pressButton: p ? () => view.press(p.button) : undefined,
  });
  // as on the desktop page, a left press on a game button is the button's own click (right press + skip is done by the client above)
  if (action === 'left' && p && !consumed) view.press(p.button);
}
// a mouse acts as a mouse (left/right click, middle-drag pan, drag selects text) unless "override mouse with tap settings" is on
const mtapChk = $('mtap') as HTMLInputElement;
mtapChk.checked = lsGet('emu.mtap') === '1';
// text selection with the mouse is off by default (as in the game); the View option turns it on (a left drag then selects instead of doing nothing)
const tselChk = $('tsel') as HTMLInputElement;
tselChk.checked = lsGet('emu.tsel') === '1';
const applyTsel = () => document.body.classList.toggle('tsel', tselChk.checked);
tselChk.onchange = () => {
  lsSet('emu.tsel', tselChk.checked ? '1' : '0');
  applyTsel();
};
applyTsel();
const mbotChk = $('mbot') as HTMLInputElement;
mbotChk.checked = lsGet('emu.mbot') === '1';
V.mobileBottom = mbotChk.checked; // desktop: room below the last line as on a phone (default off: flush)
mbotChk.onchange = () => {
  lsSet('emu.mbot', mbotChk.checked ? '1' : '0');
  V.mobileBottom = mbotChk.checked;
  V.layoutChanged();
};
const applyMtap = () => document.body.classList.toggle('mtap', mtapChk.checked);
mtapChk.onchange = () => {
  lsSet('emu.mtap', mtapChk.checked ? '1' : '0');
  applyMtap();
  applyModeBtn();
};
applyMtap();
V.desktop = matchMedia('(hover: hover) and (pointer: fine)').matches;
V.reset();
// the tap mode (L/R/H) is for fingers: on a desktop with the mouse left to act as a mouse (tap settings off), the button is not needed
const applyModeBtn = () => {
  modeBtn.hidden = V.desktop && !mtapChk.checked;
};
applyModeBtn();
attachGestures(V, {
  tap: onTap,
  nativeMouse: () => !mtapChk.checked,
  click: (cx, cy, b) => onTap(cx, cy, false, b === 2 ? 'right' : 'left'),
});

// desktop conveniences: wheel scrolls / zooms (or feeds INPUTMOUSEKEY), mouse hover moves the game's pointer, keys reach the game
vp.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const st = V.toStage(e.clientX, e.clientY),
      inside = st.x >= 0 && st.x < V.sw && st.y >= 0 && st.y < V.sh;
    if (client.wheel(e.deltaY, Math.round(st.x), wy(st.y), inside)) return;
    const u = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? vp.clientHeight : 1; // Firefox reports wheel steps in lines
    if (e.ctrlKey) {
      const r = vp.getBoundingClientRect();
      V.zoomAbout(V.s * Math.exp(-(e.deltaY * u) / 300), e.clientX - r.left, e.clientY - r.top);
    } else V.panBy(-e.deltaX * u, -e.deltaY * u);
  },
  { passive: false },
);
vp.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || e.buttons) return;
  const st = V.toStage(e.clientX, e.clientY);
  client.pointerMove(Math.round(st.x), wy(st.y));
  view.hoverAt(e.target as Element, e.clientX, e.clientY);
});
const typing = (t: EventTarget | null) => /^(INPUT|TEXTAREA|SELECT)$/.test((t as HTMLElement | null)?.tagName ?? '');
document.addEventListener('keydown', (e) => {
  if (tlOpen && !typing(e.target)) return; // the translation panel is open: the game is locked (Esc closes it, handled by the panel)
  if (padEditing && !typing(e.target)) {
    if (e.key === 'Escape') endEdit();
    e.preventDefault();
    return;
  } // customizing: the game is locked
  // ONEINPUT / ONEINPUTS (Emuera.NET games): the first key is the answer, no Enter; taken from the page or the input window, not from settings fields
  if (
    (e.target === document.body || e.target === inp) &&
    client.oneKey({ key: e.key, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, isComposing: e.isComposing })
  ) {
    e.preventDefault();
    return;
  }
  if (typing(e.target)) return;
  if (
    client.keyDown({
      keyCode: e.keyCode,
      key: e.key,
      repeat: e.repeat,
      isComposing: e.isComposing,
      shift: e.shiftKey,
      ctrl: e.ctrlKey,
      alt: e.altKey,
    })
  )
    e.preventDefault();
});
document.addEventListener('keyup', (e) => {
  if (!typing(e.target) && !padEditing) client.keyUp(e.keyCode);
});
window.addEventListener('blur', () => client.setActive(false));
window.addEventListener('focus', () => client.setActive(true));

// view presets
$('zauto').onclick = () => V.reset();
$('hzin').onclick = () => V.zoomAbout(V.s * 1.25, V.vw / 2, V.vh / 2);
$('hzout').onclick = () => V.zoomAbout(V.s / 1.25, V.vw / 2, V.vh / 2);
$('hzfit').onclick = () => V.fitOrActual();
$('zfit').onclick = () => V.fit();
$('z100').onclick = () => V.setScale(1);
$('z150').onclick = () => V.setScale(1.5);
$('ztop').onclick = () => V.toTop();
$('zend').onclick = () => V.toBottom();

// ---------------------------------------------------------------- quick inputs: last input, 999, one user-set input
// The user button: tap it while empty and the input window takes one input; that input is kept on the button instead of being sent.
// Tap a filled button to send its value; long press frees it. Not saved: it lasts until cleared or the page is closed.
let userInput: string | null = null;
let arming: { reopen: boolean } | null = null; // waiting for the one input; `reopen` = the input window was hidden and is hidden again afterwards
const quick = $('quick');
const showVal = (v: string) => (v === '' ? '\u23ce' : v.length > 8 ? v.slice(0, 8) + '\u2026' : v);
function mkBtn(label: string, onclick: () => void, cls = '') {
  const b = document.createElement('button');
  b.textContent = label;
  b.className = cls;
  b.onclick = onclick;
  return b;
}
function renderQuick() {
  quick.textContent = '';
  const u = mkBtn('', () => {});
  u.id = 'quser';
  // long press frees the button; the click that follows a long press must not send
  let t = 0,
    long = false;
  u.onpointerdown = () => {
    long = false;
    clearTimeout(t);
    t = window.setTimeout(() => {
      long = true;
      clearUser();
    }, 500);
  };
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) u.addEventListener(ev, () => clearTimeout(t));
  u.onclick = () => {
    if (long) {
      long = false;
      return;
    }
    userTap();
  };
  u.oncontextmenu = (e) => e.preventDefault();
  quick.append(
    Object.assign(
      mkBtn('', () => {
        const l = lastAction();
        if (l) quickSend(l.value);
      }),
      { id: 'qlast', title: 'Send the last input again' },
    ),
    Object.assign(
      mkBtn('999', () => quickSend('999')),
      { id: 'q999', title: 'Send 999 (the usual exit input)' },
    ),
    u,
  );
  refreshQuick();
  applyWidgets();
}
/** the last thing the user chose at a prompt: Enter presses that continue a wait (including the ones auto-sent while skipping after a right-click) do not count */
function lastAction() {
  for (let i = client.entries.length - 1; i >= 0; i--) {
    const e = client.entries[i];
    if (e.kind !== 'wait' && e.kind !== 'anykey') return e;
  }
  return null;
}
function refreshQuick() {
  refreshPad();
  const c = promptClass(client.kind),
    prompt = (c === 'number' || c === 'text' || c === 'any') && !busyNow;
  const last = lastAction();
  const set = (id: string, text: string, disabled: boolean, title?: string) => {
    const b = document.getElementById(id) as HTMLButtonElement | null;
    if (!b) return;
    if (b.textContent !== text) b.textContent = text;
    b.disabled = disabled;
    if (title) b.title = title;
    b.classList.toggle('rec', id === 'quser' && arming !== null);
  };
  set('qlast', '\u21ba ' + (last ? showVal(last.value) : 'last'), !prompt || !last);
  set('q999', '999', !prompt);
  {
    const uf = $('userfree') as HTMLButtonElement;
    uf.textContent = arming
      ? 'Waiting for an input… (tap to cancel)'
      : userInput === null
        ? 'No Set Value'
        : `Free Set Value: ${userInput === '' ? '<enter>' : userInput}`;
    uf.disabled = userInput === null && !arming;
  }
  if (arming) set('quser', '\u2026', false, 'Type one input in the input window; tap again to cancel');
  else if (userInput === null)
    set(
      'quser',
      '+',
      false,
      'Tap, then enter one input in the input window to keep it on this button. Long press frees it.',
    );
  else
    set('quser', showVal(userInput), !prompt, 'Send ' + (userInput || 'Enter') + '. Long press to free this button.');
}
function quickSend(v: string) {
  send(v);
}

// ---------------------------------------------------------------- widgets: direction pad + recordable input button (Control panel > Widgets)
// history log cap: per browser; empty = the device class default (2000 on a desktop, 500 on a phone, as elsewhere). Applies when a game is loaded.
const logcap = $('logcap') as HTMLInputElement,
  logcaphint = $('logcaphint'),
  logcapreset = $('logcapreset');
const logCapUser = () => Math.round(Number(lsGet('emuera-logcap'))) >= 500;
const logCapDefault = () => (V.desktop ? LOG_CAP_DESKTOP : LOG_CAP_MOBILE);
const logCapValue = (): number => (logCapUser() ? Math.round(Number(lsGet('emuera-logcap'))) : logCapDefault());
function renderLogCapUi() {
  logcap.value = logCapUser() ? String(logCapValue()) : '';
  logcap.placeholder = String(logCapDefault());
  logcapreset.hidden = !logCapUser();
  logcaphint.textContent = `default ${logCapDefault()}; lower is faster in long games`;
}
logcap.onchange = () => {
  const v = Math.round(Number(logcap.value));
  lsSet('emuera-logcap', v >= 500 && v <= 1000000 ? String(v) : '');
  renderLogCapUi();
  logcaphint.textContent += ' - applies when the game is loaded again';
};
logcapreset.onclick = () => {
  lsSet('emuera-logcap', '');
  renderLogCapUi();
  logcaphint.textContent += ' - applies when the game is loaded again';
};
renderLogCapUi();
const xpad = $('xpad'),
  dpad = $('dpad'),
  bdpad = $('bdpad'),
  wdpad = $('wdpad') as HTMLInputElement,
  wrec = $('wrec') as HTMLInputElement;
interface XBtn {
  id: string;
  r: number;
  b: number;
  s: number;
  v: string;
}
let xCfg: XBtn[] = [],
  selX = ''; // custom buttons of the open game (below)
let netGame = false; // an Emuera.NET game (setting.json next to ERB/CSV), e.g. eraMegaten: its exploration is a 2D map moved with 8/4/6/2
const dpadEnabled = () => {
  const v = lsGet('emu.w.dpad');
  return v === null ? netGame : v === '1';
};
function applyWidgets() {
  const on = dpadEnabled();
  wdpad.checked = on;
  bdpad.hidden = !on;
  if (!on) {
    dpad.hidden = true;
    bdpad.classList.remove('on');
  }
  wrec.checked = lsGet('emu.w.rec') !== '0';
  const u = document.getElementById('quser');
  if (u) u.hidden = !wrec.checked;
  $('wnote').textContent = netGame
    ? 'Emuera.NET game detected (eraMegaten style): the direction pad is on unless you turn it off here. The header button shows or hides it (hidden at first).'
    : '';
  refreshPad();
}
wdpad.onchange = () => {
  lsSet('emu.w.dpad', wdpad.checked ? '1' : '0');
  applyWidgets();
};
wrec.onchange = () => {
  lsSet('emu.w.rec', wrec.checked ? '1' : '0');
  applyWidgets();
};
let bdLong = false,
  bdT = 0; // long press on the toggle opens the customize mode
bdpad.onpointerdown = () => {
  bdLong = false;
  clearTimeout(bdT);
  bdT = window.setTimeout(() => {
    bdLong = true;
    startEdit();
  }, 550);
};
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) bdpad.addEventListener(ev, () => clearTimeout(bdT));
bdpad.oncontextmenu = (e) => e.preventDefault();
bdpad.onclick = () => {
  if (bdLong) {
    bdLong = false;
    return;
  }
  dpad.hidden = !dpad.hidden;
  bdpad.classList.toggle('on', !dpad.hidden);
  refreshPad();
};
/** what each pad button sends: a single key (a digit like a number key press, a letter, or empty = Enter); the user can reprogram them (Customize) */
const PAD_DEFAULT: Record<string, string> = { up: '8', left: '4', mid: '5', right: '6', down: '2' };
interface PadCfg {
  r: number;
  b: number;
  s: number;
  keys: Record<string, string>;
}
const PAD_RESET = (): PadCfg => ({ r: 10, b: 10, s: 54, keys: { ...PAD_DEFAULT } });
function loadPad(): PadCfg {
  const d = PAD_RESET();
  try {
    const j = JSON.parse(lsGet('emu.dpad') ?? 'null');
    if (j && typeof j === 'object') {
      for (const k of ['r', 'b', 's'] as const) if (typeof j[k] === 'number' && isFinite(j[k])) d[k] = j[k];
      for (const k of Object.keys(PAD_DEFAULT)) if (typeof j.keys?.[k] === 'string') d.keys[k] = j.keys[k].slice(0, 1);
    }
  } catch {
    /* defaults */
  }
  return d;
}
let padCfg = loadPad();
const savePad = () => lsSet('emu.dpad', JSON.stringify(padCfg));
const clampPad = () => {
  padCfg.s = Math.min(120, Math.max(36, padCfg.s));
};
/** where the pad is drawn: the saved offsets kept on screen. Never written back by drawing, so a rotation or the input box (a smaller area) moves it only while the area is small */
const effPad = () => {
  const w = padCfg.s * 3 + 8,
    main = $('main');
  return {
    r: Math.min(Math.max(0, padCfg.r), Math.max(0, main.clientWidth - w)),
    b: Math.min(Math.max(0, padCfg.b), Math.max(0, main.clientHeight - w)),
  };
};
function applyPad() {
  clampPad();
  const ep = effPad();
  dpad.style.right = ep.r + 'px';
  dpad.style.bottom = ep.b + 'px';
  dpad.style.setProperty('--pd', padCfg.s + 'px');
  dpad.querySelectorAll<HTMLButtonElement>('button[data-d]').forEach((b) => {
    const v = padCfg.keys[b.dataset.d!];
    if (v === PAD_DEFAULT[b.dataset.d!]) delete b.dataset.val;
    else b.dataset.val = v === '' ? '⏎' : v;
  });
}
/** key code of a single character, for an INPUTMOUSEKEY wait (digits as the numpad: peek reads 104/100/98/102 and 101; letters as their key; Enter for empty) */
const keyCodeOf = (v: string) =>
  v === ''
    ? 13
    : /^[0-9]$/.test(v)
      ? 96 + Number(v)
      : /^[a-z]$/i.test(v)
        ? v.toUpperCase().charCodeAt(0)
        : v === ' '
          ? 32
          : 0;
/** the pad answers one-key waits (a key press: the digit or letter) and INPUTMOUSEKEY waits (a key event); at a menu prompt it stays off so a stray tap never answers it */
const padKind = () => {
  const k = client.kind;
  return k === 'oneint' || k === 'onestr' ? 'one' : k === 'mousekey' ? 'mouse' : '';
};
let padEditing = false,
  padWasShown = false;
/** the direction cross can be removed (per game) to leave only custom buttons; Reset cross brings it back */
let crossGone = false;
const crossKey = () => 'emu.pad.nocross:' + gameId;
const saveCross = () => {
  if (gameId) lsSet(crossKey(), crossGone ? '1' : '');
};
function refreshPad() {
  dpad.classList.toggle('gone', crossGone);
  dpad.classList.toggle('off', !padKind() || busyNow || padEditing);
  xpad.hidden = dpad.hidden; // one header button shows or hides the cross and the custom buttons together
  const c = promptClass(client.kind),
    live = !busyNow && !padEditing && (!!padKind() || c === 'number' || c === 'text' || c === 'any');
  xpad.querySelectorAll('.xb').forEach((b) => b.classList.toggle('off', !live));
}
function padPress(dir: string): boolean {
  const kind = padKind();
  if (!kind || busyNow || padEditing) return false;
  const v = padCfg.keys[dir] ?? PAD_DEFAULT[dir];
  if (kind === 'mouse') {
    const c = keyCodeOf(v);
    if (!c) return false;
    client.sendMouseKey([3, c, c, 0, 0, 0]);
    return true;
  }
  if (client.kind === 'oneint' && v !== '' && !/^[0-9]$/.test(v)) return false; // a number wait takes digits only
  return client.submit(v);
}
function reprogram(dir: string) {
  const cur = padCfg.keys[dir];
  const v = prompt(
    `What should this button send? One key, such as 8 or w (empty = Enter). Now: ${cur === '' ? 'Enter' : cur}`,
    cur,
  );
  if (v === null) return;
  padCfg.keys[dir] = v.slice(0, 1);
  savePad();
  applyPad();
  say(`Direction pad: this button now sends ${padCfg.keys[dir] === '' ? 'Enter' : '"' + padCfg.keys[dir] + '"'}.`);
}
const padBar = $('dpadbar'),
  padGrip = $('dpadgrip');
function startEdit() {
  if (padEditing) return;
  padEditing = true;
  padWasShown = !dpad.hidden;
  dpad.hidden = false;
  dpad.classList.add('editing');
  xpad.classList.add('editing');
  padBar.hidden = false;
  padGrip.hidden = false;
  $('padscrim').hidden = false;
  ($('padadd') as HTMLButtonElement).disabled = !gameId || xCfg.length >= X_MAX;
  ($('padadd') as HTMLButtonElement).title = gameId ? '' : 'Open a game first: custom buttons belong to a game';
  applyPad();
  renderX();
  refreshPad();
  say('Drag a button to move it. Hold a button to set its text/key.');
}
function endEdit() {
  if (!padEditing) return;
  closeEditor();
  padEditing = false;
  savePad();
  saveX();
  selX = '';
  dpad.classList.remove('editing');
  xpad.classList.remove('editing');
  padBar.hidden = true;
  padGrip.hidden = true;
  $('padscrim').hidden = true;
  dpad.hidden = !padWasShown;
  renderX();
  applyWidgets();
  bdpad.classList.toggle('on', !dpad.hidden);
  refreshPad();
}
$('dpadedit').onclick = () => {
  openSheet(null);
  startEdit();
};
$('dpaddone').onclick = endEdit;
$('dpadreset').onclick = () => {
  padCfg = PAD_RESET();
  crossGone = false;
  saveCross();
  savePad();
  applyPad();
  refreshPad();
};
{
  let hold = 0,
    rep = 0;
  const stop = () => {
    clearTimeout(hold);
    clearInterval(rep);
    hold = rep = 0;
    dpad.querySelectorAll('.held').forEach((b) => b.classList.remove('held'));
  };
  const buttons = dpad.querySelectorAll<HTMLButtonElement>('button[data-d]');
  buttons.forEach((b) => {
    b.onpointerdown = (e) => {
      if (padEditing) return; // handled by the edit gestures below
      e.preventDefault();
      stop();
      b.classList.add('held');
      try {
        b.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      const d = b.dataset.d!;
      padPress(d);
      if (d !== 'mid')
        hold = window.setTimeout(() => {
          rep = window.setInterval(() => padPress(d), 140);
        }, 380); // held: keep walking (a press while the game works is skipped)
    };
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, stop);
    b.oncontextmenu = (e) => e.preventDefault();
  });
  // edit mode: drag anywhere on the pad to move it, drag the corner handle to resize it, hold a button to reprogram it
  let g: {
    x: number;
    y: number;
    r: number;
    b: number;
    s: number;
    id: number;
    mode: 'move' | 'size';
    moved: boolean;
    btn: HTMLButtonElement | null;
    t: number;
  } | null = null;
  const begin = (e: PointerEvent, mode: 'move' | 'size', btn: HTMLButtonElement | null) => {
    e.preventDefault();
    e.stopPropagation();
    const e0 = effPad();
    g = { x: e.clientX, y: e.clientY, r: e0.r, b: e0.b, s: padCfg.s, id: e.pointerId, mode, moved: false, btn, t: 0 };
    try {
      dpad.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (btn) {
      btn.classList.add('held');
      const cur = g;
      cur.t = window.setTimeout(() => {
        if (g === cur && !cur.moved) {
          const d = btn.dataset.d!;
          g = null;
          btn.classList.remove('held');
          reprogram(d);
        }
      }, 550);
    }
  };
  dpad.addEventListener(
    'pointerdown',
    (e) => {
      if (!padEditing || g) return;
      const t = e.target as HTMLElement;
      if (t.closest('#dpadbar')) return;
      if (t.id === 'dpadx') {
        e.preventDefault();
        e.stopPropagation();
        crossGone = true;
        saveCross();
        refreshPad();
        return;
      }
      if (t === padGrip) {
        begin(e, 'size', null);
        return;
      }
      begin(e, 'move', t.closest<HTMLButtonElement>('button[data-d]'));
    },
    true,
  );
  dpad.addEventListener('pointermove', (e) => {
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x,
      dy = e.clientY - g.y;
    if (!g.moved && Math.hypot(dx, dy) < 6) return;
    if (!g.moved) {
      g.moved = true;
      clearTimeout(g.t);
    }
    if (g.mode === 'move') {
      padCfg.r = g.r - dx;
      padCfg.b = g.b - dy;
    } // anchored at the bottom right: dragging left/up grows the offsets
    else padCfg.s = g.s + Math.max(-dx, -dy) / 3; // the handle is the top-left corner: dragging out (left/up) grows the pad
    applyPad();
  });
  const finish = (e: PointerEvent) => {
    if (!g || g.id !== e.pointerId) return;
    clearTimeout(g.t);
    g.btn?.classList.remove('held');
    const moved = g.moved;
    g = null;
    if (moved) {
      const e1 = effPad();
      padCfg.r = e1.r;
      padCfg.b = e1.b;
      savePad();
    }
  };
  dpad.addEventListener('pointerup', finish);
  dpad.addEventListener('pointercancel', finish);
}

// ---- custom buttons (per game): any text, placed and sized by the user while customizing; shown and hidden with the cross
const X_MAX = 12;

const xKey = () => 'emu.pad.btns:' + gameId;
function loadX() {
  xCfg = [];
  crossGone = !!gameId && lsGet(crossKey()) === '1';
  try {
    const j = gameId ? JSON.parse(lsGet(xKey()) ?? 'null') : null;
    if (Array.isArray(j))
      for (const o of j.slice(0, X_MAX))
        if (
          o &&
          typeof o === 'object' &&
          typeof o.v === 'string' &&
          [o.r, o.b, o.s].every((n: unknown) => typeof n === 'number' && isFinite(n as number))
        )
          xCfg.push({
            id: String(o.id ?? Math.random().toString(36).slice(2, 8)),
            r: o.r,
            b: o.b,
            s: o.s,
            v: o.v.slice(0, 40),
          });
  } catch {
    /* none */
  }
  renderX();
}
function saveX() {
  if (gameId) lsSet(xKey(), xCfg.length ? JSON.stringify(xCfg) : '');
}
const xLabel = (v: string) => (v === '' ? '⏎' : v);
/** where a custom button is drawn: the saved offsets kept on screen (drawing never changes them; see effPad) */
function effX(c: XBtn) {
  const main = $('main');
  return {
    r: Math.min(Math.max(0, c.r), Math.max(0, main.clientWidth - c.s)),
    b: Math.min(Math.max(0, c.b), Math.max(0, main.clientHeight - c.s)),
  };
}
function placeX(el: HTMLElement, c: XBtn) {
  const main = $('main');
  c.s = Math.min(140, Math.max(36, c.s));
  const e = effX(c);
  el.style.right = e.r + 'px';
  el.style.bottom = e.b + 'px';
  el.style.width = el.style.height = c.s + 'px';
  el.style.fontSize = Math.max(10, Math.min(c.s * 0.38, ((c.s - 8) * 1.7) / Math.max(1, xLabel(c.v).length))) + 'px';
}
function renderX() {
  xpad.textContent = '';
  for (const c of xCfg) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'xb' + (padEditing && c.id === selX ? ' sel' : '');
    b.dataset.id = c.id;
    b.textContent = xLabel(c.v);
    b.title = c.v === '' ? 'Enter' : c.v;
    const g = document.createElement('span');
    g.className = 'xg';
    g.textContent = '⇱';
    b.appendChild(g);
    const d = document.createElement('span');
    d.className = 'xd';
    d.textContent = '✕';
    d.title = 'Remove this button';
    b.appendChild(d);
    placeX(b, c);
    xpad.appendChild(b);
  }
  refreshPad();
}
function xPress(v: string): boolean {
  if (busyNow || padEditing) return false;
  const kind = padKind(),
    k1 = v.slice(0, 1);
  if (kind === 'mouse') {
    const c = keyCodeOf(k1);
    if (!c) return false;
    client.sendMouseKey([3, c, c, 0, 0, 0]);
    return true;
  }
  if (kind === 'one') {
    if (client.kind === 'oneint' && k1 !== '' && !/^[0-9]$/.test(k1)) return false;
    return client.submit(k1);
  }
  const cls = promptClass(client.kind);
  if (cls === 'number') return /^-?\d*$/.test(v) ? send(v) : false;
  if (cls === 'text' || cls === 'any') return send(v);
  return false;
}
let editingX = '';
function openEditor(id: string) {
  const c = xCfg.find((x) => x.id === id);
  if (!c) return;
  editingX = id;
  ($('padeditv') as HTMLInputElement).value = c.v;
  $('padedit').hidden = false;
  ($('padeditv') as HTMLInputElement).focus();
}
function closeEditor() {
  editingX = '';
  $('padedit').hidden = true;
}
$('padeditok').onclick = () => {
  const c = xCfg.find((x) => x.id === editingX);
  if (c) {
    c.v = ($('padeditv') as HTMLInputElement).value.slice(0, 40);
    saveX();
    closeEditor();
    renderX();
  }
};
$('padeditdel').onclick = () => {
  xCfg = xCfg.filter((x) => x.id !== editingX);
  selX = '';
  saveX();
  closeEditor();
  renderX();
  ($('padadd') as HTMLButtonElement).disabled = !gameId;
};
$('padeditcancel').onclick = closeEditor;
($('padeditv') as HTMLInputElement).addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('padeditok').click();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeEditor();
  }
});
$('padadd').onclick = () => {
  if (!gameId || xCfg.length >= X_MAX) return;
  const main = $('main'),
    s = 56,
    n = xCfg.length;
  const c: XBtn = {
    id: Math.random().toString(36).slice(2, 8),
    r: Math.round(main.clientWidth / 2 - s / 2 - n * 14),
    b: Math.round(main.clientHeight / 2 - s / 2 - n * 14),
    s,
    v: '',
  };
  xCfg.push(c);
  selX = c.id;
  saveX();
  renderX();
  openEditor(c.id);
  ($('padadd') as HTMLButtonElement).disabled = xCfg.length >= X_MAX;
};
$('padscrim').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (selX) {
    selX = '';
    renderX();
  }
});
{
  let held = '',
    hid = 0;
  xpad.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement,
      el = t.closest<HTMLElement>('.xb');
    if (!el) return;
    const c = xCfg.find((x) => x.id === el.dataset.id)!;
    e.preventDefault();
    if (!padEditing) {
      el.classList.add('held');
      held = c.id;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      xPress(c.v);
      return;
    }
    if (t.closest('.xd')) {
      xCfg = xCfg.filter((x) => x.id !== c.id);
      selX = '';
      saveX();
      renderX();
      ($('padadd') as HTMLButtonElement).disabled = !gameId;
      return;
    } // the cross at the corner of the selected button removes it
    const size = !!t.closest('.xg');
    if (selX !== c.id) {
      selX = c.id;
      xpad.querySelectorAll('.xb').forEach((b) => b.classList.toggle('sel', (b as HTMLElement).dataset.id === c.id));
    }
    const ex = effX(c),
      gs = { x: e.clientX, y: e.clientY, r: ex.r, b: ex.b, s: c.s, id: e.pointerId, moved: false, size };
    try {
      xpad.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (!size)
      hid = window.setTimeout(() => {
        if (!gs.moved && xDrag === gs) {
          xDrag = null;
          openEditor(c.id);
        }
      }, 550);
    xDrag = gs;
    xDragId = c.id;
  });
  type G = { x: number; y: number; r: number; b: number; s: number; id: number; moved: boolean; size: boolean };
  let xDrag: G | null = null,
    xDragId = '';
  xpad.addEventListener('pointermove', (e) => {
    if (!xDrag || xDrag.id !== e.pointerId) return;
    const c = xCfg.find((x) => x.id === xDragId);
    if (!c) return;
    const dx = e.clientX - xDrag.x,
      dy = e.clientY - xDrag.y;
    if (!xDrag.moved && Math.hypot(dx, dy) < 6) return;
    if (!xDrag.moved) {
      xDrag.moved = true;
      clearTimeout(hid);
    }
    if (xDrag.size) c.s = xDrag.s + Math.max(-dx, -dy);
    else {
      c.r = xDrag.r - dx;
      c.b = xDrag.b - dy;
    }
    const el = xpad.querySelector<HTMLElement>(`.xb[data-id="${c.id}"]`);
    if (el) placeX(el, c);
  });
  const fin = (e: PointerEvent) => {
    xpad.querySelectorAll('.held').forEach((b) => b.classList.remove('held'));
    held = '';
    if (!xDrag || xDrag.id !== e.pointerId) return;
    clearTimeout(hid);
    const moved = xDrag.moved,
      did = xDragId;
    xDrag = null;
    if (moved) {
      const c = xCfg.find((x) => x.id === did);
      if (c) {
        const e1 = effX(c);
        c.r = e1.r;
        c.b = e1.b;
      }
      saveX();
    }
  };
  xpad.addEventListener('pointerup', fin);
  xpad.addEventListener('pointercancel', fin);
  xpad.addEventListener('contextmenu', (e) => e.preventDefault());
  // the play area changes (rotation, the input box, a keyboard): redraw both pads against the new size without touching what is saved
  new ResizeObserver(() => {
    applyPad();
    xpad.querySelectorAll<HTMLElement>('.xb').forEach((el) => {
      const c = xCfg.find((x) => x.id === el.dataset.id);
      if (c) placeX(el, c);
    });
  }).observe($('main'));
}
applyPad();
function userTap() {
  if (arming) {
    endArm();
    return;
  }
  if (userInput !== null) {
    if (userInput !== null) send(userInput);
    return;
  }
  const bar = $('inbar') as HTMLFormElement;
  const reopen = !!bar.hidden;
  if (reopen) {
    bar.hidden = false;
    $('binp').classList.add('on');
  }
  arming = { reopen };
  inp.value = '';
  client.setInputText('');
  refreshQuick();
  inp.placeholder = 'type the input to save, then Send';
  inp.focus(); // an explicit request for text: the one place the field is focused
}
function endArm() {
  const a = arming;
  arming = null;
  if (a?.reopen) {
    ($('inbar') as HTMLFormElement).hidden = true;
    $('binp').classList.remove('on');
  }
  refreshInput();
  refreshQuick();
}
$('userfree').onclick = () => clearUser();
function clearUser() {
  userInput = null;
  if (arming) endArm();
  renderQuick();
}
/** called with the input window's text on Send: true when it was kept for the user button instead of being sent */
function captureForUser(v: string): boolean {
  if (!arming) return false;
  userInput = v;
  inp.value = '';
  client.setInputText('');
  inp.blur();
  endArm();
  return true;
}

// ---------------------------------------------------------------- input log + debug controls
function condensed(log: readonly string[]) {
  const shown: string[] = [];
  for (const x of log) {
    const t = x === '' ? '<enter>' : x;
    const last = shown[shown.length - 1];
    const m = last && /^(.*) x(\d+)$/.exec(last);
    if (m && m[1] === t) shown[shown.length - 1] = `${t} x${+m[2] + 1}`;
    else if (last === t) shown[shown.length - 1] = `${t} x2`;
    else shown.push(t);
  }
  return shown;
}
function renderInputLog() {
  const el = $('ilist');
  el.textContent = client.entries.length
    ? `${client.entries.length} inputs\n` +
      client.entries
        .slice(-80)
        .map((e) => `${hhmmss(e.t)}  ${(e.kind || '-').padEnd(7)} ${e.value === '' ? '<enter>' : e.value}`)
        .join('\n')
    : 'No inputs yet.';
}
const copy = async (text: string, note: string) => {
  try {
    await navigator.clipboard.writeText(text);
    say(note + ' copied.');
  } catch {
    say('Copy failed: use the download instead.');
  }
};
$('icopy').onclick = () => copy(client.log.join('\n'), 'Input log');
$('xlog').onclick = () =>
  client.exportLog(($('xnote') as HTMLInputElement).value, false, ($('xverbose') as HTMLInputElement).checked);
$('xsnap').onclick = () => client.exportSnapshot();
$('dcopy').onclick = () =>
  copy((crashText ? crashText + '\n\n' : '') + issues.map((i) => `[${i.level}] ${i.text}`).join('\n'), 'Debug report');
$('dsnap').onclick = () => {
  if (crashSnap) download('crash-snapshot.json', crashSnap, 'application/json');
};
$('dclear').onclick = () => {
  issues.length = 0;
  crashSnap = crashText = '';
  refreshDebugBtn();
  renderDebug();
};

// ---------------------------------------------------------------- fonts (the FontRegistry: game font/*.ttf, bundled BIZ UDGothic, imported)
document.querySelectorAll<HTMLButtonElement>('button.pick').forEach((b) => {
  b.onclick = () => {
    const i = $(b.dataset.for!) as HTMLInputElement;
    i.click();
  };
}); // real buttons: Firefox for Android does not forward a label tap to a display:none input
const fstore = new FontStore();
const fontsReady = (async () => {
  try {
    for (const b of BUNDLED_FONTS)
      await fonts.add(b.file, Uint8Array.from(atob(b.b64), (c) => c.charCodeAt(0)).buffer, 'bundled');
    await fonts.loadUser(fstore);
    await fonts.register();
  } catch (e) {
    console.warn('fonts', e);
  }
  renderFontUi();
  applyFonts();
})();
const fontsel = $('fontsel') as HTMLSelectElement;
function renderFontUi() {
  const cur = fonts.override ?? '';
  fontsel.textContent = '';
  const add = (v: string, label: string) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    fontsel.appendChild(o);
  };
  add('', configFont ? `Game default (${configFont})` : 'Game default');
  for (const f of fonts.families()) add(f, f);
  if (cur && !fonts.families().includes(cur)) add(cur, cur);
  fontsel.value = cur;
  const eff = fonts.override ?? configFont,
    mine = fonts.list().filter((e: FontEntry) => familyKey(e.family) === familyKey(eff));
  const bad = mine.find((e: FontEntry) => e.ratio !== null && e.ratio !== 0.5);
  $('fwarn').textContent = bad ? `"${bad.family}" is not half-width 0.5 em: columns and rules may misalign.` : '';
  ($('frm') as HTMLButtonElement).hidden = !mine.some((e: FontEntry) => e.source === 'user');
}
function applyFonts() {
  view.refreshFonts();
  placeCbg();
  V.layoutChanged();
  renderFontUi();
}
fontsel.onchange = () => {
  fonts.override = fontsel.value || null;
  if (gameId) lsSet('emu.font:' + gameId, fontsel.value);
  applyFonts();
};
async function addFontFiles(files: File[]) {
  for (const f of files) {
    const r = await fonts.addUser(fstore, f.name, await f.arrayBuffer());
    if ('error' in r) addIssue('warn', 'FONT: ' + r.error);
  }
  applyFonts();
}
($('fadd') as HTMLInputElement).onchange = async (e) => {
  const el = e.target as HTMLInputElement,
    files = [...(el.files ?? [])];
  el.value = '';
  await addFontFiles(files);
};
$('frm').onclick = async () => {
  const k = familyKey(fonts.override ?? configFont);
  for (const e of fonts.list().filter((x: FontEntry) => x.source === 'user' && familyKey(x.family) === k))
    await fonts.removeUser(fstore, e.id);
  applyFonts();
};

// ---------------------------------------------------------------- loading a game
let lenientByName = false; // the hidden `lenient` option is switched on only by a game file name containing "trim"
const readOptions = (): StartOptions =>
  Object.fromEntries(
    OPTION_DEFS.map((d) => [
      d.key,
      d.hidden
        ? d.key === 'lenient'
          ? lenientByName
          : d.default
        : (document.getElementById(d.id) as HTMLInputElement).checked,
    ]),
  ) as unknown as StartOptions;
// Control panel > Game > Reload Game (two taps, the second within 3 s, so a stray tap does not throw away unsaved play)
{
  const rb = $('reload') as HTMLButtonElement;
  let armed = 0;
  rb.onclick = () => {
    const f = lastBlob;
    if (!f) return;
    if (!armed) {
      rb.textContent = 'Reload Game? tap again';
      armed = window.setTimeout(() => {
        armed = 0;
        rb.textContent = 'Reload Game';
      }, 3000);
      return;
    }
    clearTimeout(armed);
    armed = 0;
    rb.textContent = 'Reload Game';
    void load(f.blob, f.name);
  };
}
// Control panel > Options: "Reset to default" shows while any launcher option differs from its default
const optReset = $('optreset') as HTMLButtonElement;
const optBox = (d: (typeof OPTION_DEFS)[number]) => document.getElementById(d.id) as HTMLInputElement | null;
const optsChanged = () => OPTION_DEFS.some((d) => !d.hidden && optBox(d) && optBox(d)!.checked !== d.default);
const syncOptReset = () => {
  optReset.hidden = !optsChanged();
};
for (const d of OPTION_DEFS) if (!d.hidden) optBox(d)?.addEventListener('change', syncOptReset);
optReset.onclick = () => {
  for (const d of OPTION_DEFS) if (!d.hidden && optBox(d)) optBox(d)!.checked = d.default as boolean;
  syncOptReset();
};
syncOptReset();
let loaderLog: string[] = [];
async function load(blob: Blob, name: string) {
  lenientByName = /trim/i.test(name);
  setBusy(true);
  say('Reading zip…');
  try {
    // the game zip first, then the enabled resource packs in list order (a later source overwrites an earlier one)
    const log: string[] = [];
    const loader = new GameLoader((l) => log.push(l), {
      erbBytes: !!readOptions().xloader,
      scanReferences: !!readOptions().xrefs,
      lazyImages: !!readOptions().ximages,
    }); // experimental loader: ERB stays as bytes
    await loader.add({ name, blob }, (n, t) => say(`Reading zip… ${n}/${t}`));
    let packSrc: Source[] = [];
    try {
      packSrc = await activeSources();
    } catch (e) {
      log.push('resource packs unavailable: ' + e);
    }
    let usedPacks = 0;
    for (const p of packSrc) {
      try {
        say(`Reading pack ${p.name}…`);
        await loader.add(p, (n, t) => say(`Reading pack ${p.name}… ${n}/${t}`));
        usedPacks++;
      } catch (e) {
        const t = `Pack skipped: ${p.name}: ${e instanceof Error ? e.message : e}`;
        log.push(t);
        addIssue('warn', t);
      }
    }
    await loader.readSpriteSizes((n, t) => say(`Reading image sizes… ${n}/${t}`));
    const g = loader.finish();
    loaderLog = log;
    // game-embedded fonts (font/*.ttf|otf, as Emuera EM+EE loads them) are registered before the engine starts
    await fontsReady;
    fonts.removeSource('game');
    for (const f of g.fonts) await fonts.add(f.path, f.data, 'game');
    await fonts.register();
    player.setSounds(g.sounds);
    lastBlob = { blob, name };
    ($('reload') as HTMLButtonElement).disabled = false;
    issues.length = 0;
    crashSnap = crashText = '';
    refreshDebugBtn();
    view.clearSprites();
    V.follow = true;
    V.reset();
    client.reset(() => new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }))));
    const m = await memory.openForGame(g.base.csv, g.base.erb, name); // card identity from the base game, so packs never change a card's id
    gameId = m.gameId;
    void tl?.newGame(m.gameId);
    loadX();
    patchUi.onGame(g.csv, m.gameId);
    netGame = Object.keys(g.csv).some((p) => /(^|\/)setting\.json$/i.test(p));
    dpad.hidden = true;
    bdpad.classList.remove('on');
    applyWidgets(); // the pad starts hidden on every game
    fonts.override = lsGet('emu.font:' + gameId) || null;
    applyFonts();
    const xfer: Transferable[] = [...Object.values(g.images), ...Object.values(g.erbBytes ?? {})];
    firstScreen = true;
    client.start(
      {
        unloaded: g.unloaded,
        sounds: [...g.sounds.keys()],
        gameId: m.gameId,
        erb: g.erb,
        erbBytes: g.erbBytes,
        csv: g.csv,
        saves: m.saves,
        files: m.files,
        ...readOptions(),
        windowWidth: patchUi.widthOverride(),
        logCap: logCapValue(),
        deltaLines: !new URLSearchParams(location.search).has('nodelta'),
        patchOff: patchUi.offIds(),
        images: g.images,
        imageRefs: g.imageRefs,
        imageSources: g.imageSources,
        rescsv: g.rescsv,
        texts: g.texts,
        fonts: fonts.startFonts(),
      },
      xfer,
    );
    void memory.refreshUi();
    say(
      `Card "${m.cardName}": ${Object.keys(m.saves).filter((k) => k !== 'global').length} save slot(s). Loaded ${Object.keys(g.erbBytes ?? g.erb).length} ERB, ${Object.keys(g.csv).length} CSV, ${Object.keys(g.images).length + Object.keys(g.imageRefs ?? {}).length} images${g.imageRefs ? ' (read on demand)' : ''}${usedPacks ? `, ${usedPacks} pack(s)` : ''}. Booting (game init can take a minute)…`,
    );
    void packsUi.refresh();
  } catch (e) {
    setBusy(false);
    const t = e instanceof NoGameError ? e.message : 'Load failed: ' + e;
    say(t);
    addIssue('error', t);
    if (!(e instanceof NoGameError)) openSheet('dbg');
  }
}
($('file') as HTMLInputElement).onchange = (e) => {
  const el = e.target as HTMLInputElement,
    f = el.files?.[0];
  el.value = '';
  if (!f) return;
  void load(f, f.name); // `load` sets the hidden lenient option from the file name
};
attachDrop({
  say,
  hasGame: () => memory.hasGame(),
  nativeIn: (f) => memory.nativeFilesIn(f),
  addFonts: addFontFiles,
  addPacks: (fs) => packsUi.addFiles(fs),
  addTranslation: (f) => addTranslation(f),
  loadGame: async (f) => {
    await load(f, f.name);
  },
  insertCard: (f) => memory.importFile(f),
  offerNative: async (f) => memory.offerNative(await memory.nativeFilesIn(f), f.name),
});
// bundled files (only on a deployment that ships them): bundled-assets/bundlegame.NAME.zip (one), bundlesave.NAME.zip (alias bundlecard) and bundlepack.NAME.zip (any number)
// are listed by the build in bundled/bundle.json (a static host cannot list a folder); each type loads with one button, in the manifest's alphabetical order.
// A file named with a leading `auto.` has `auto: true` there and is loaded when the page opens (see runAutoload below); `size` (bytes) is in every entry.
interface BundleItem {
  file: string;
  name: string;
  auto?: boolean;
  size?: number;
}
interface Bundle {
  game?: BundleItem | null;
  saves?: BundleItem[];
  packs?: BundleItem[];
  translation?: BundleItem[];
}
let bundle: Bundle = {};
const bundleUrl = (it: BundleItem) => 'bundled/' + encodeURIComponent(it.file);
async function fetchBlob(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
  return r.blob();
}
const fetchFile = async (it: BundleItem) =>
  new File([await fetchBlob(bundleUrl(it))], it.file, { type: 'application/zip' });
const packsUi = createPacks({
  say,
  problem: (t) => {
    addIssue('error', t);
    say(t);
  },
  canApply: () => !!lastBlob,
  apply: () => {
    const f = lastBlob;
    if (f) void load(f.blob, f.name);
  },
});
void packsUi.refresh();
async function loadBundledGame() {
  const g = bundle.game;
  if (!g) return;
  try {
    setBusy(true);
    say(`Fetching bundled game ${g.name}…`);
    await load(await fetchBlob(bundleUrl(g)), g.name + '.zip');
  } catch (e) {
    setBusy(false);
    say('Could not fetch the bundled game: ' + e);
  }
}
async function loadBundledPacks() {
  const ps = bundle.packs ?? [];
  if (!ps.length) return;
  try {
    say(`Fetching ${ps.length} bundled pack(s)…`);
    const files: File[] = [];
    for (const p of ps) files.push(await fetchFile(p));
    const r = await packsUi.addFiles(files, true);
    say(
      `Bundled packs: ${r.added} added, ${r.skipped} already in the list (${fmtSize(files.reduce((n, f) => n + f.size, 0))}).${lastBlob ? ' Use "Apply: reload game" to load them.' : ''}`,
    );
  } catch (e) {
    say('Could not fetch the bundled packs: ' + e);
  }
}
async function loadBundledCards() {
  const cs = bundle.saves ?? [];
  if (!cs.length) return;
  try {
    const files: File[] = [];
    for (const c of cs) files.push(await fetchFile(c));
    await memory.importMany(files);
  } catch (e) {
    say('Could not fetch the bundled cards: ' + e);
  }
}
$('bundled').onclick = loadBundledGame;
$('pbundled').onclick = loadBundledPacks;
$('cbundled').onclick = loadBundledCards;
$('tlbundled').onclick = async () => {
  // by name; every bundled translation zip, the engine first (the `auto.` ones are also taken in when the page opens, see runAutoload)
  const ts = bundle.translation ?? [];
  if (!ts.length) return;
  for (const t of ts) {
    try {
      say(`Fetching ${t.file}…`);
      say(`Translation zip added: ${await addTranslation(await fetchFile(t))}`);
    } catch (e) {
      say(`Could not add ${t.file}: ${e}`);
    }
  }
};
async function loadBundle() {
  try {
    const r = await fetch('bundled/bundle.json', { cache: 'no-cache' });
    if (!r.ok) return;
    bundle = await r.json();
  } catch {
    return; /* not deployed with bundled files */
  }
  const show = (id: string, on: boolean, label?: string) => {
    const b = $(id) as HTMLButtonElement;
    b.hidden = !on;
    if (label) b.textContent = label;
  };
  show('bundled', !!bundle.game, bundle.game ? `Load bundled game: ${bundle.game.name}` : undefined);
  show('pbundled', !!bundle.packs?.length, `Load bundled packs (${bundle.packs?.length ?? 0})`);
  show('tlbundled', !!bundle.translation?.length, `Load bundled translation files (${bundle.translation?.length ?? 0})`);
  show('cbundled', !!bundle.saves?.length, `Load bundled cards (${bundle.saves?.length ?? 0})`);
  $('cextra').hidden = !!($('cbundled').hidden && $('cdir').hidden);
  void memory.refreshUi();
  await runAutoload();
}
/** `auto.` files: cards, packs and translation zips are taken in once per file version (the marker is the file name and size, stored per browser,
 *  so a pack the player removes stays removed and a card is never imported twice); the game is loaded on every visit. Order: cards (the game then takes the inserted one),
 *  packs, translation (installed only: switching it on stays the player's choice), then the game. `?noauto` in the address skips all of it. */
async function runAutoload() {
  if (new URLSearchParams(location.search).has('noauto')) return;
  const key = (kind: string, it: BundleItem) => `emu.auto:${kind}:${it.file}:${it.size ?? ''}`;
  const todo = (kind: string, items?: BundleItem[]) =>
    (items ?? []).filter((i) => i.auto && lsGet(key(kind, i)) !== '1');
  const mark = (kind: string, items: BundleItem[]) => items.forEach((i) => lsSet(key(kind, i), '1'));
  const cards = todo('card', bundle.saves);
  if (cards.length)
    try {
      say(`Auto-loading ${cards.length} bundled card(s)…`);
      await memory.importMany(await Promise.all(cards.map(fetchFile)));
      mark('card', cards);
    } catch (e) {
      say('Could not auto-load the bundled cards: ' + e);
    }
  const packs = todo('pack', bundle.packs);
  if (packs.length)
    try {
      say(`Auto-loading ${packs.length} bundled pack(s)…`);
      await packsUi.addFiles(await Promise.all(packs.map(fetchFile)), true);
      mark('pack', packs);
    } catch (e) {
      say('Could not auto-load the bundled packs: ' + e);
    }
  for (const t of todo('tl', bundle.translation))
    try {
      say(`Auto-loading ${t.file}…`);
      say(`Translation zip added: ${await addTranslation(await fetchFile(t))}`);
      mark('tl', [t]);
    } catch (e) {
      say(`Could not auto-load ${t.file}: ${e}`);
    }
  if (bundle.game?.auto) await loadBundledGame();
}
void loadBundle();

// ---------------------------------------------------------------- translation (optional; the translation module, our panel). Nothing is created, loaded or stored until it is switched on.
const tlFlag = (k: string, v?: string): string | null => {
  if (v === undefined) return lsGet(k);
  lsSet(k, v);
  return v;
};
/** the engine's "Translation: on (ja → en (variant), filter ja). Output only: …" reads better as "Translation: on (ja → en, filter ja)" */
function tidyTl(t: string): string {
  const m = /^(Translation: on) \((.*), (filter [^,)]+)\)\. Output only: .*$/.exec(t);
  return m ? `${m[1]} (${m[2].replace(/ \([^)]*\)$/, '')}, ${m[3]})` : t;
}
tl = new Translation({
  say: (t) => {
    t = tidyTl(t);
    say(t);
    if (/error|failed|could not|no translation pack/i.test(t)) addIssue('warn', t);
  },
  flag: tlFlag,
  makePanel: () =>
    (tlPanel = createMobilePanel({
      host: $('main'),
      row: $('mainrow'),
      button: $('btl'),
      fine: () => V.desktop,
      dock: tlDocked,
      lock: [$('vp'), $('dpad'), $('xpad'), $('inbar'), $('quick')],
      onCount: (n) => setCached(n),
      onOpen: (open, docked) => {
        tlOpen = open && !docked;
        document.body.classList.toggle('tlover', tlOpen);
        const fit = open && docked;
        if (V.dockFit !== fit) V.dockFit = fit;
        V.layoutChanged();
      },
    })),
});
// layout: a desktop (mouse) is always docked beside the game, whatever the window width or the stored choice;
// a phone is overlay unless the user chose side-by-side (stored per device class: the choice only counts on a phone, and the checkbox is hidden on a desktop)
function tlDocked(): boolean {
  return V.desktop || lsGet('emu.tl.dock') === '1';
}
function syncDockBox() {
  ($('tldock') as HTMLInputElement).checked = tlDocked();
}
($('tldock') as HTMLInputElement).onchange = (e) => {
  lsSet('emu.tl.dock', (e.target as HTMLInputElement).checked ? '1' : '0');
  tlPanel?.relayout();
};
syncDockBox();
window.addEventListener('resize', syncDockBox);
$('btl').hidden = true;
const LANG_NAMES: Record<string, string> = {
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese (Simplified)',
  'zh-Hans': 'Chinese (Simplified)',
  'zh-Hant': 'Chinese (Traditional)',
  en: 'English',
};
/** "ko → en (cjk_icu_base)" becomes "Korean -> English" for the model picker (unknown codes stay as they are; the technical variant is dropped unless two models would read the same) */
function modelName(label: string, keepVariant = false): string {
  const m = /^(\S+) → (\S+)(.*)$/.exec(label);
  return m ? `${LANG_NAMES[m[1]] ?? m[1]} -> ${LANG_NAMES[m[2]] ?? m[2]}${keepVariant ? m[3] : ''}` : label;
}
async function renderTl() {
  const t = tl!,
    info = await t.packInfo().catch(() => []),
    choices = await t.modelChoices().catch(() => []);
  $('tlinfo').textContent = info.length
    ? info.map((p) => `${p.title}${p.models ? ` (${p.models})` : ''}, ${fmtSize(p.size)}`).join('\n')
    : 'No translation model installed.';
  const on = $('tlon') as HTMLInputElement;
  on.disabled = !choices.some((c) => c.ready);
  on.checked = t.enabled;
  const sel = $('tlmodel') as HTMLSelectElement,
    cur = t.modelSetting();
  const plain = choices.map((c) => modelName(c.label));
  sel.replaceChildren(
    ...choices.map((c, i) => {
      const o = document.createElement('option'),
        n = modelName(c.label, plain.filter((x) => x === plain[i]).length > 1);
      o.value = c.id;
      o.textContent = c.ready ? n : `${n} (needs the engine zip)`;
      return o;
    }),
  );
  sel.value = choices.some((c) => c.id === cur)
    ? cur
    : ((choices.find((c) => c.id.startsWith('ja>en')) ?? choices[0])?.id ?? '');
  $('tlmodelrow').hidden = choices.length < 2;
  ($('tlrm') as HTMLButtonElement).disabled = !info.length;
  ($('tlclearmem') as HTMLButtonElement).disabled = !t.enabled;
  setCached(tl!.memorySize());
}
async function addTranslation(f: File): Promise<string> {
  const n = await tl!.addPack(f);
  await renderTl();
  return n; // an engine that is not the known one is refused (addPack throws; the callers show the message)
}
($('tladd') as HTMLInputElement).onchange = async (e) => {
  const el = e.target as HTMLInputElement,
    f = el.files?.[0];
  el.value = '';
  if (!f) return;
  try {
    say(`Reading ${f.name}…`);
    say(`Translation model added: ${await addTranslation(f)}`);
  } catch (err) {
    say(`${f.name}: ${(err as Error).message}`);
  }
};
($('tlon') as HTMLInputElement).onchange = async (e) => {
  if ((e.target as HTMLInputElement).checked) await tl!.enable();
  else tl!.disable();
  await renderTl();
};
($('tlcopy') as HTMLInputElement).checked = tl.copyWanted();
($('tlcopy') as HTMLInputElement).onchange = (e) => tl!.setCopy((e.target as HTMLInputElement).checked);
($('tlmodel') as HTMLSelectElement).onchange = async (e) => {
  await tl!.selectModel((e.target as HTMLSelectElement).value);
  await renderTl();
};
$('tlrm').onclick = async () => {
  await tl!.removePack();
  say('Translation zips removed (cached lines are kept).');
  await renderTl();
};
/** "Clear cached lines (N)": N is how many translated lines are cached for the open game */
function setCached(n: number) {
  $('tlclearmem').textContent = n > 0 ? `Clear cached lines (${n})` : 'Clear cached lines';
}
$('tlclearmem').onclick = async () => {
  await tl!.clearMemory();
  await renderTl();
};
void renderTl();
if (tl.wantedOn()) void tl.enable().then(renderTl); // the only boot-time work, and only when it was left on

// ---------------------------------------------------------------- start
if (lsGet('emu.inp') === '1') {
  ($('inbar') as HTMLFormElement).hidden = false;
  $('binp').classList.add('on');
}
renderQuick();
refreshInput();
refreshDebugBtn();
void memory.refreshUi();
document.addEventListener('fullscreenchange', () => V.layoutChanged());
(window as any).__m = {
  setNet: (v: boolean) => {
    netGame = v;
    applyWidgets();
  },
  setGame: (id: string) => {
    gameId = id;
    loadX();
    applyWidgets();
  },
  fonts,
  client,
  view,
  V,
  onTap,
  issues,
  openSheet,
  tl,
  load,
  memory,
  packsUi,
  loadBundle,
  patchUi,
  bundleState: () => bundle,
}; // test hook
