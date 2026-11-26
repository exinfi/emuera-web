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
import { padShapes, dpadDefault, needsPad, parseQuickVals, type Pt } from './rules';
// @ts-ignore injected by the build script
declare const WORKER_SRC: string;
// @ts-ignore injected by the build script: bundled OFL fonts as base64
declare const BUNDLED_FONTS: { file: string; b64: string }[];
// @ts-ignore injected by the build script: the shell's own text face (BIZ UDPGothic subsets), for the chrome only
declare const UI_FONTS: { family: string; weight: string; b64: string }[];

const $ = (id: string) => document.getElementById(id)!;
// the shell's text face: plain FontFaces, not part of the game's font list; chrome text swaps to it when it has loaded (a missing FontFace API just keeps the fallback stack)
try {
  for (const f of UI_FONTS) {
    const face = new FontFace(f.family, Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)).buffer, {
      weight: f.weight,
      display: 'swap',
    });
    void face.load().then(
      () => document.fonts.add(face),
      () => {},
    );
  }
} catch {
  /* keep the fallback stack */
}
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

/** `info`: a load or image fact for the debug list, not counted as an issue */
type Issue = { t: number; level: 'info' | 'warn' | 'error'; text: string };
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
  const n = issues.filter((i) => i.level !== 'info').length;
  b.classList.toggle('warn', n > 0);
  b.querySelector('span')!.textContent = n ? `dbg ${n}` : 'dbg';
}
/** a debug-list fact by key, replaced in place when sent again (load timing, image facts from the engine) */
const infoByKey = new Map<string, Issue>();
function setInfo(key: string, text: string) {
  let e = infoByKey.get(key);
  if (!e || !issues.includes(e)) {
    e = { t: Date.now(), level: 'info', text };
    issues.push(e);
    infoByKey.set(key, e);
  } else e.text = text;
  refreshDebugBtn();
  if (!$('dbg').hidden) renderDebug();
}
function renderDebug() {
  const list = $('dlist');
  list.textContent = '';
  list.className = '';
  if (!issues.some((i) => i.level !== 'info')) {
    const d = document.createElement('div');
    d.className = 'small';
    d.textContent = 'No issues reported.';
    list.appendChild(d);
  }
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
  document.body.classList.toggle('pnl', id === 'panel'); // hides the tap toggle and the quick buttons while the control panel is open
  $('bdbg').classList.toggle('on', id === 'dbg' || id === 'ilog');
  if (id === 'dbg') renderDebug();
  if (id === 'ilog') renderInputLog();
}
const toggleSheet = (id: string) => openSheet($(id).hidden ? id : null);
document.body.classList.toggle('pnl', !$('panel').hidden); // the control panel is open when the page starts
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
// Immersive view: holding the hide button for 1.8 s hides every control (bar, buttons, tabs, input window, direction pad, custom buttons, translation panel and sheets; the busy indicator stays)
// and leaves only that button, dimmed; a click on it brings everything back as it was. The state is not stored (a reload starts with the controls) and nothing else is changed:
// the controls are only hidden by `body.imm` in mobile.css, so each keeps the state it had.
const IMM_HOLD_MS = 1800;
let immersive = false;
let immTimer: ReturnType<typeof setTimeout> | undefined;
let immFired = false; // the hold ended in immersive view: the click that follows the release must not also toggle the bar
function applyHeader() {
  document.body.classList.toggle('hdrc', hdrCollapsed || immersive); // the bar's own space goes to the game while immersive
  document.body.classList.toggle('imm', immersive);
  hdrBtn.title = immersive
    ? 'Show the controls again'
    : hdrCollapsed
      ? 'Show the top bar (hold for 1.8 seconds: hide all controls)'
      : 'Hide the top bar (the tap mode, quick buttons, control panel and input buttons stay; hold for 1.8 seconds: hide all controls)';
}
function enterImmersive() {
  immersive = true;
  if (tlOpen) tlPanel?.open(false); // an overlay translation panel locks the game (inert): it closes, as it would by its tab
  (document.activeElement as HTMLElement | null)?.blur?.();
  applyHeader();
}
const stopHold = () => clearTimeout(immTimer);
hdrBtn.addEventListener('pointerdown', (e) => {
  immFired = false;
  stopHold();
  if (immersive || (e.pointerType === 'mouse' && e.button !== 0)) return;
  immTimer = setTimeout(() => {
    immFired = true;
    enterImmersive();
  }, IMM_HOLD_MS);
});
for (const t of ['pointerup', 'pointercancel', 'pointerleave']) hdrBtn.addEventListener(t, stopHold);
hdrBtn.addEventListener('contextmenu', (e) => e.preventDefault()); // a long touch must not open the browser's menu
hdrBtn.onclick = () => {
  if (immFired) {
    immFired = false;
    return;
  }
  if (immersive) {
    immersive = false;
    applyHeader();
    return;
  }
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
const V = new Viewport(vp, $('pan'), stage, () => $('main').classList.toggle('scrolled', V.ty < -2)); // the fade under the top bar shows once the log has moved (mobile.css)
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
    } else if (m.op === 'set') {
      inp.value = m.text;
      client.setInputText(m.text);
    }
  }, // move/resume: the input window is not placed over the game
  status: (msg) => say(msg),
  info: (key, text) => setInfo(key, text),
  workerError: (msg) => addIssue('error', msg),
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
  send(v, false, true);
}
function send(v: string, raw = false, byMouse = false): boolean {
  if (busyNow && !raw) return false; // the engine is working: a second tap or Send would queue a duplicate input
  const ok = client.submit(v, raw, byMouse);
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
  send(inp.value);
};
const BUSY_HINT = 'working...';
function refreshInput() {
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
const fadeChk = $('edgefade') as HTMLInputElement;
fadeChk.checked = lsGet('emu.edgefade') !== '0';
const applyFade = () => document.body.classList.toggle('nofade', !fadeChk.checked);
fadeChk.onchange = () => {
  lsSet('emu.edgefade', fadeChk.checked ? '1' : '0');
  applyFade();
};
applyFade();
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
// "unobtrusive tap toggle" (View): the toggle is drawn almost invisible, a thin outline in the tap color; the option is offered only where the toggle is shown
const qtapChk = $('qtap') as HTMLInputElement;
const qtapRow = $('qtaprow');
qtapChk.checked = lsGet('emu.qtap') === '1';
const applyQtap = () => document.body.classList.toggle('qtap', qtapChk.checked);
qtapChk.onchange = () => {
  lsSet('emu.qtap', qtapChk.checked ? '1' : '0');
  applyQtap();
};
applyQtap();
const applyModeBtn = () => {
  modeBtn.hidden = V.desktop && !mtapChk.checked;
  qtapRow.hidden = modeBtn.hidden;
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

// ---------------------------------------------------------------- quick access buttons (Control panel > Widgets, off by default)
// First the repeat button (sends the last input again), then the values the player added in the control panel. They follow the tap mode like a tap on the game:
// right click (or a tap in R mode, or a long press in L mode) sends the value and skips, as a right click on a game button does. Kept per browser.
const QMAX = 8;
const quick = $('quick');
const quickOn = () => lsGet('emu.w.quick') === '1';
let quickVals: string[] = parseQuickVals(lsGet('emu.q.vals'), QMAX);
const saveQuick = () => lsSet('emu.q.vals', JSON.stringify(quickVals));
const showVal = (v: string) => (v === '' ? '\u23ce' : v.length > 8 ? v.slice(0, 8) + '\u2026' : v);
function mkBtn(label: string, onclick: () => void, cls = '') {
  const b = document.createElement('button');
  b.textContent = label;
  b.className = cls;
  b.onclick = onclick;
  return b;
}
/** send a quick value as a left press, or as a right press: the same path as a right click on a game button (sends, then skips to the next real input) */
function quickDo(v: string, act: 'left' | 'right') {
  if (busyNow) return;
  if (act === 'left') {
    send(v);
    return;
  }
  client.pointerDown({
    button: 2,
    x: 0,
    y: 0,
    inside: false,
    onChrome: true,
    onControl: false,
    pressButton: () => void send(v),
  });
}
/** make a quick button act per the player's click type: a real mouse clicks left/right; a finger (or a mouse with the tap settings on) taps as the tap mode says, and a long press does the other click */
function bindQuick(b: HTMLButtonElement, value: () => string | null) {
  let t = 0,
    long = false,
    ptype = 'touch';
  const nativeMouse = () => ptype === 'mouse' && !mtapChk.checked;
  const fire = (act: 'left' | 'right') => {
    const v = value();
    if (v !== null && !b.disabled) quickDo(v, act);
  };
  b.onpointerdown = (e) => {
    ptype = e.pointerType;
    long = false;
    clearTimeout(t);
    if (nativeMouse() || e.button !== 0) return;
    t = window.setTimeout(() => {
      long = true;
      fire(mode === 'left' ? 'right' : 'left'); // as a long press on the game: the other click (in H mode, a click)
    }, 450);
  };
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => clearTimeout(t));
  b.onclick = (e) => {
    if (long) {
      long = false;
      return;
    }
    fire(e.detail === 0 || nativeMouse() ? 'left' : mode === 'right' ? 'right' : 'left'); // keyboard and mouse: left; a tap in H mode has no hover here, so it clicks
  };
  b.oncontextmenu = (e) => {
    e.preventDefault();
    if (nativeMouse()) fire('right');
  };
}
function renderQuick() {
  quick.textContent = '';
  const rep = Object.assign(
    mkBtn('', () => {}),
    { id: 'qlast', title: 'Send the last input again. Right click: send it and skip.' },
  );
  bindQuick(rep, () => lastAction()?.value ?? null);
  quick.append(rep);
  quickVals.forEach((v, i) => {
    const b = mkBtn(showVal(v), () => {}, 'qv');
    b.dataset.i = String(i);
    b.title = `Send ${v === '' ? 'Enter' : v}. Right click: send it and skip.`;
    bindQuick(b, () => quickVals[i] ?? null);
    quick.append(b);
  });
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
  const rep = document.getElementById('qlast') as HTMLButtonElement | null;
  if (rep) {
    const t = '\u21ba ' + (last ? showVal(last.value) : 'last');
    if (rep.textContent !== t) rep.textContent = t;
    rep.disabled = !prompt || !last;
  }
  quick.querySelectorAll<HTMLButtonElement>('.qv').forEach((b) => (b.disabled = !prompt));
}
// control panel side: the on/off switch and the list of added values (set, remove)
const wquick = $('wquick') as HTMLInputElement,
  qcfg = $('qcfg'),
  qlist = $('qlist'),
  qnew = $('qnew') as HTMLInputElement,
  qadd = $('qadd') as HTMLButtonElement;
function renderQuickUi() {
  qlist.textContent = '';
  quickVals.forEach((v, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.maxLength = 40;
    inp.value = v;
    inp.placeholder = 'Enter';
    inp.setAttribute('autocomplete', 'off');
    inp.setAttribute('autocapitalize', 'off');
    inp.setAttribute('spellcheck', 'false');
    inp.onchange = () => {
      quickVals[i] = inp.value;
      saveQuick();
      renderQuick();
    };
    const rm = mkBtn('Remove', () => {
      quickVals.splice(i, 1);
      saveQuick();
      renderQuickUi();
      renderQuick();
    });
    row.append(inp, rm);
    qlist.append(row);
  });
  qadd.disabled = quickVals.length >= QMAX;
  qnew.disabled = quickVals.length >= QMAX;
}
function addQuick() {
  if (quickVals.length >= QMAX) return;
  quickVals.push(qnew.value);
  qnew.value = '';
  saveQuick();
  renderQuickUi();
  renderQuick();
}
qadd.onclick = addQuick;
qnew.onkeydown = (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addQuick();
  }
};
wquick.onchange = () => {
  lsSet('emu.w.quick', wquick.checked ? '1' : '0');
  applyWidgets();
};
renderQuickUi();

// ---------------------------------------------------------------- widgets: direction pad + quick access buttons (Control panel > Widgets)
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
  wdpad = $('wdpad') as HTMLInputElement;
interface XBtn {
  id: string;
  r: number;
  b: number;
  s: number;
  v: string;
}
let xCfg: XBtn[] = [],
  selX = ''; // custom buttons of the open game (below)
let padGame = false; // the open game is one that needs the direction pad (its GameBase.csv code is in PAD_GAME_CODES): its exploration is a 2D map moved with 8/4/6/2
const dpadEnabled = () => {
  return dpadDefault(lsGet('emu.w.dpad'), padGame, V.desktop); // the automatic default is for touch devices only; the player's own choice always wins
};
function applyWidgets() {
  const on = dpadEnabled() && !!gameId; // the pad belongs to a game: nothing to show or press before one is open
  wdpad.checked = dpadEnabled();
  wdpad.disabled = !gameId;
  wdpad.title = gameId ? '' : 'Open a game first: the direction pad belongs to a game';
  bdpad.hidden = !on;
  if (!on) {
    dpad.hidden = true;
    bdpad.classList.remove('on');
  }
  const de = $('dpadedit') as HTMLButtonElement;
  de.disabled = !gameId;
  de.title = gameId ? '' : 'Open a game first: custom buttons belong to a game';
  wquick.checked = quickOn();
  quick.hidden = !wquick.checked;
  qcfg.hidden = !wquick.checked;
  $('wnote').textContent = !padGame
    ? ''
    : V.desktop
      ? 'This game uses a map moved with the direction keys: the direction pad is off on a desktop unless you turn it on here. The header button shows or hides it.'
      : 'This game uses a map moved with the direction keys: the direction pad is on and shown at the start unless you turn it off here. The header button shows or hides it.';
  refreshPad();
}
/** show the pad now (what the header button does when it is off) */
function showPad() {
  if (!gameId || bdpad.hidden) return;
  dpad.hidden = false;
  bdpad.classList.add('on');
  refreshPad();
}
wdpad.onchange = () => {
  lsSet('emu.w.dpad', wdpad.checked ? '1' : '0');
  applyWidgets();
  if (wdpad.checked) showPad(); // turning it on is expected to show it
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
    const j = JSON.parse((gameId ? lsGet('emu.dpad:' + gameId) : null) ?? lsGet('emu.dpad') ?? 'null'); // this game's layout, else the old shared one as the starting point
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
const savePad = () => {
  if (gameId) lsSet('emu.dpad:' + gameId, JSON.stringify(padCfg)); // per game, like the custom buttons
};
const clampPad = () => {
  padCfg.s = Math.min(120, Math.max(36, padCfg.s));
};
/** where the pad is drawn: the saved offsets kept on screen. Never written back by drawing, so a rotation or the input box (a smaller area) moves it only while the area is small */
const effPad = () => {
  const w = padSize(),
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
  paintPad();
}
const padSize = () => padShapes(padCfg.s).size;
const px1 = (n: number) => n.toFixed(1);
const polyPts = (q: Pt[]) => q.map((p) => px1(p[0]) + ',' + px1(p[1])).join(' ');
const clipOf = (q: Pt[]) => 'polygon(' + q.map((p) => px1(p[0]) + 'px ' + px1(p[1]) + 'px').join(',') + ')';
/** draws the pad: the shapes come from `padShapes` (rules.ts); each button is a full-size layer clipped to its wedge, so a touch lands on the shape it is in */
function paintPad() {
  const pd = padCfg.s,
    sh = padShapes(pd),
    W = sh.size,
    gs = pd * 0.38;
  const turn: Record<string, number> = { up: 0, right: 90, down: 180, left: 270 };
  dpad.style.setProperty('--W', px1(W) + 'px');
  const label = (d: string, v: string, x: number, y: number, mid = false) => {
    const e = document.createElement('b');
    e.className = 'pk' + (v !== PAD_DEFAULT[d] ? ' ch' : '') + (mid ? ' mid' : '');
    e.textContent = v === '' ? '⏎' : v;
    e.style.left = px1(x) + 'px';
    e.style.top = px1(y) + 'px';
    return e;
  };
  for (const d of ['up', 'right', 'down', 'left'] as const) {
    const b = dpad.querySelector<HTMLButtonElement>(`button[data-d=${d}]`)!,
      w = sh.wedges[d];
    b.style.clipPath = clipOf(w.poly);
    b.textContent = '';
    b.insertAdjacentHTML(
      'beforeend',
      `<svg class="pb" viewBox="0 0 ${px1(W)} ${px1(W)}"><polygon points="${polyPts(w.poly)}"/></svg>` +
        `<i class="pg" style="left:${px1(w.glyph[0] - gs / 2)}px;top:${px1(w.glyph[1] - gs / 2)}px;width:${px1(gs)}px;height:${px1(gs)}px"><svg viewBox="0 0 24 24" style="transform:rotate(${turn[d]}deg)"><polyline points="5,15 12,8 19,15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square"/></svg></i>`,
    );
    b.append(label(d, padCfg.keys[d], w.arm[0] + 6, w.arm[1] + 4));
  }
  const m = dpad.querySelector<HTMLButtonElement>('button[data-d=mid]')!,
    dia = sh.diamond,
    cc = sh.middle[0];
  m.style.clipPath = clipOf(dia);
  m.textContent = '';
  m.insertAdjacentHTML(
    'beforeend',
    `<svg class="pb" viewBox="0 0 ${px1(W)} ${px1(W)}"><polygon points="${polyPts(dia)}"/></svg>`,
  );
  if (padCfg.keys.mid !== PAD_DEFAULT.mid) m.append(label('mid', padCfg.keys.mid, cc, cc, true)); // the middle shows its key only when it was changed
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

// ---- the cross layout (position, size, keys), whether it is removed, and the custom buttons are all per game
// ---- custom buttons (per game): any text, placed and sized by the user while customizing; shown and hidden with the cross
const X_MAX = 12;

const xKey = () => 'emu.pad.btns:' + gameId;
function loadX() {
  padCfg = loadPad();
  applyPad();
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
  // MS Gothic cannot be bundled: offer it whenever the device has it, whatever the game's default is
  if (msGothicInstalled() && !fonts.families().some((f) => familyKey(f) === familyKey('MS Gothic')))
    add('MS Gothic', 'MS Gothic (installed)');
  if (cur && ![...fonts.families(), 'MS Gothic'].includes(cur)) add(cur, cur);
  else if (cur === 'MS Gothic' && !msGothicInstalled()) add(cur, cur);
  fontsel.value = cur;
  const eff = fonts.override ?? configFont,
    mine = fonts.list().filter((e: FontEntry) => familyKey(e.family) === familyKey(eff));
  const bad = mine.find((e: FontEntry) => e.ratio !== null && e.ratio !== 0.5);
  $('fwarn').textContent = bad ? `"${bad.family}" is not half-width 0.5 em: columns and rules may misalign.` : '';
  ($('frm') as HTMLButtonElement).hidden = !mine.some((e: FontEntry) => e.source === 'user');
}
let msGothicSeen: boolean | null = null;
/** true when the device itself has MS Gothic: text in it measures differently from the same text in a generic family it would otherwise fall back to */
function msGothicInstalled(): boolean {
  if (msGothicSeen !== null) return msGothicSeen;
  try {
    const c = document.createElement('canvas').getContext('2d');
    const t = 'abcWMi01あ漢ｱ';
    const w = (f: string) => {
      c!.font = `40px ${f}`;
      return c!.measureText(t).width;
    };
    msGothicSeen = ['"MS Gothic"', '"ＭＳ ゴシック"'].some(
      (n) => w(`${n}, monospace`) !== w('monospace') || w(`${n}, serif`) !== w('serif'),
    );
  } catch {
    msGothicSeen = false;
  }
  return msGothicSeen;
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
  const tLoad = performance.now();
  let loadInfo = '';
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
    const tZip = performance.now();
    loadInfo = `Load: zip ${((tZip - tLoad) / 1000).toFixed(1)} s`;
    if (readOptions().ximages) {
      // every image's width and height in one forward pass over each zip, so the engine never reads a file to learn a size
      const sw = await loader.sweepImageSizes((n, t) => say(`Reading image sizes… ${n}/${t}`));
      if (sw.images)
        loadInfo += ` | image sizes ${(sw.ms / 1000).toFixed(1)} s: ${sw.sized} of ${sw.images} in ${sw.reads} reads (${(sw.bytes / 1048576).toFixed(0)} MB)`;
    }
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
    setInfo('page', loadInfo);
    const extras = loader.extrasSummary();
    if (extras) setInfo('extras', extras); // the extra file check is on: what it loaded
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
    padGame = needsPad(g.csv);
    dpad.hidden = true;
    bdpad.classList.remove('on');
    applyWidgets(); // the pad starts hidden on every game, unless the game is one that needs it (PAD_GAME_CODES)
    if (padGame && dpadEnabled()) showPad();
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
  show(
    'tlbundled',
    !!bundle.translation?.length,
    `Load bundled translation files (${bundle.translation?.length ?? 0})`,
  );
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
    padGame = v;
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
