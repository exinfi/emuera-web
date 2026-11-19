/**
 * Platform-neutral client for the engine worker: owns the worker, the typed message flow, the typed-input log and the
 * input rules every shell must share (what a click at a wait does, how skipping works, how mouse/key events reach
 * INPUTMOUSEKEY, which events are forwarded). A shell translates its native events into these calls and renders what
 * the hooks hand it. No DOM here.
 */
import type {
  ToWorker,
  ToPage,
  ScreenMsg,
  FrameMsg,
  Seg,
  ScreenKind,
  StartMsg,
  SoundMsg,
  NativeImported,
  NativeExported,
} from './protocol';
import { mouseButtonCode, modifierBits } from './screen';

/** one input sent to the game */
export interface InputEntry {
  value: string;
  kind: ScreenKind | '';
  t: number;
}

export interface ClientHooks {
  /** render a screen; called before the client updates its input state from `m.kind` */
  screen(m: ScreenMsg): void;
  sound(m: SoundMsg): void;
  title(t: string): void;
  textbox(m: Extract<ToPage, { type: 'textbox' }>): void;
  /** one-line engine/status text; `msg` is user-facing progress, shells may show or hide it */
  status(msg: string): void;
  /** optional: a debug-list line, replaced by `key` (see `ToPage` `info`) */
  info?(key: string, text: string): void;
  /** optional: the worker threw outside the engine's own error handling */
  workerError?(msg: string): void;
  /** optional: the per-game patches in effect (sent once the game is parsed) */
  patches?(m: { active: string[]; width: number; widthFrom: 'game' | 'patch' | 'override'; boot?: string[] }): void;
  /** true while the engine is working on an input, false when a screen has arrived (the shell clears it in `screen`) */
  busy(on: boolean): void;
  persist(key: string, value: { info: string; data: string } | null): void;
  persistFile(key: string, text: string): void;
  restart(): void;
  errreport(text: string, snapshot: string): void;
  fatal(msg: string): void;
  logexport(text: string, snapshot: string): void;
  /** the typed-input log changed (empty = reset) */
  inputLog(log: readonly string[]): void;
  /** optional: an AWAIT frame, drawn while the game keeps running (no input state change, no busy change); without it the animation is skipped */
  frame?(m: FrameMsg): void;
  /** optional: one input was sent, with the kind of prompt it answered and the time (for macros and logs) */
  input?(entry: InputEntry): void;
}

/** a pointer press, already translated by the shell into stage-local terms */
export interface PointerDown {
  /** DOM button: 0 left, 1 middle, 2 right */
  button: number;
  /** stage coordinates (y measured from the stage bottom, so <= 0) and whether the pointer is inside the stage */
  x: number;
  y: number;
  inside: boolean;
  /** the press landed on page chrome (header, log, selects, labels) that must not be treated as game input for INPUTMOUSEKEY */
  onChrome: boolean;
  /** the press landed on a control (chrome, text boxes) that must not trigger click-to-continue or skip */
  onControl: boolean;
  /** the press landed on a game button; call to press it (the button then calls `submit`) */
  pressButton?: () => void;
  /** the value of the game button under the press (what the page's hover would have reported), '' for none. During INPUTMOUSEKEY it is what the game reads as the clicked button (RESULT:5 / RESULTS), so a shell that presses without a DOM pointer event must set it (`ScreenView.valueAt`). Left out: the last hover value stands. */
  pointing?: string;
}

const ARROW_DIGIT: Record<string, string> = { ArrowUp: '8', ArrowLeft: '4', ArrowRight: '6', ArrowDown: '2' };
export class Client {
  private worker: Worker | null = null;
  private skip = false;
  private lastMove = 0;
  /** what the game is waiting for ('wait', 'anykey', 'mousekey', an input kind, 'done', 'error'), '' while the engine runs */
  kind: ScreenKind | '' = '';
  /** the kind of the most recent screen (unlike `kind`, not cleared while the engine runs) */
  private screenKind: ScreenKind | '' = '';
  readonly log: string[] = [];
  /** every input sent, with the prompt kind it answered and a timestamp (ms since epoch); cleared by `reset` */
  readonly entries: InputEntry[] = [];

  constructor(private hooks: ClientHooks) {}

  private post(m: ToWorker, transfer: Transferable[] = []) {
    this.worker?.postMessage(m, transfer);
  }
  private get isWait() {
    return this.kind === 'wait' || this.kind === 'anykey';
  }

  /** drop the old worker and create a new one; the shell then calls `start` */
  reset(factory: () => Worker) {
    this.worker?.terminate();
    this.log.length = 0;
    this.entries.length = 0;
    this.hooks.inputLog(this.log);
    this.held = new Map();
    const w = (this.worker = factory());
    w.onmessage = (e: MessageEvent<ToPage>) => this.onMessage(e.data);
    w.onerror = (e) => {
      const msg = `Engine worker error: ${e.message || 'unknown'}`;
      this.hooks.status(msg);
      this.hooks.workerError?.(msg);
    };
  }
  start(m: Omit<StartMsg, 'type'>, transfer: Transferable[] = []) {
    this.post({ type: 'start', ...m }, transfer);
  }

  private onMessage(m: ToPage) {
    const h = this.hooks;
    switch (m.type) {
      case 'status':
        h.status(m.msg);
        break;
      case 'info':
        h.info?.(m.key, m.text);
        break;
      case 'screen':
        this.rehydrate(m);
        this.onScreen(m);
        break;
      case 'frame':
        this.rehydrate(m);
        h.frame?.(m);
        break;
      case 'sound':
        h.sound(m.m);
        break;
      case 'title':
        h.title(m.title);
        break;
      case 'textbox':
        h.textbox(m);
        break;
      case 'restart':
        h.restart();
        break;
      case 'persist':
        h.persist(m.key, m.value);
        break;
      case 'persistFile':
        h.persistFile(m.key, m.text);
        break;
      case 'logexport':
        h.logexport(m.text, m.snapshot);
        break;
      case 'errreport':
        h.errreport(m.text, m.snapshot);
        break;
      case 'fatal':
        h.fatal(m.msg);
        break;
      case 'patches':
        h.patches?.(m);
        break;
      case 'native': {
        const w = this.nativeWait.get(m.id);
        this.nativeWait.delete(m.id);
        w?.(m);
        break;
      }
    }
  }
  /** deltaLines: lines the page already holds arrive as null; put the held line back so hooks always see the full list. Lines that are gone from the screen are forgotten. */
  private held = new Map<number, Seg[]>();
  private rehydrate(m: { lines: (Seg[] | null)[]; lineIds?: number[]; delta?: boolean }) {
    if (!m.delta || !m.lineIds) return;
    const next = new Map<number, Seg[]>();
    m.lines.forEach((l, i) => {
      const id = m.lineIds![i];
      const line = l ?? this.held.get(id) ?? []; // a missing held line cannot happen with a matching worker; an empty line beats a crash
      if (id >= 0) next.set(id, line);
      m.lines[i] = line;
    });
    this.held = next;
  }
  private onScreen(m: ScreenMsg) {
    this.hooks.screen(m);
    this.hooks.busy(false);
    const kind = m.kind;
    this.kind = this.screenKind = kind;
    if (kind !== 'wait' && kind !== 'anykey') this.skip = false;
    else if (this.skip)
      setTimeout(() => {
        if (this.skip && this.kind === kind) {
          this.kind = '';
          this.submit('');
        }
      }, 0);
  }

  // ---- input
  /** typed text, or a button's value. INPUTMOUSEKEY waits want events, not text, unless `raw`. */
  submit(v: string, raw = false): boolean {
    if (this.kind === 'mousekey' && !raw) return false;
    const entry: InputEntry = { value: v, kind: this.screenKind, t: Date.now() };
    this.log.push(v);
    this.entries.push(entry);
    this.hooks.inputLog(this.log);
    this.hooks.input?.(entry);
    this.post({ type: 'input', value: v });
    this.hooks.status('Running…');
    this.hooks.busy(true);
    return true;
  }
  /** an INPUTMOUSEKEY event: [1 click, button, x, y, 0, 0] / [2 wheel, ±120, x, y, 0, 0] / [3 key, code, code|mods, 0, 0, 0] */
  sendMouseKey(ev: number[]) {
    this.post({ type: 'mousekey', ev });
    this.kind = '';
    this.hooks.status('Running…');
    this.hooks.busy(true);
  }

  /** ONEINPUT / ONEINPUTS (Emuera): the first key pressed is the answer, no Enter. A number wait takes digits only, a text wait any single character. True if the key was taken. */
  oneKey(e: { key: string; ctrl: boolean; alt: boolean; isComposing: boolean }): boolean {
    if ((this.kind !== 'oneint' && this.kind !== 'onestr') || e.ctrl || e.alt || e.isComposing) return false;
    // shell convenience (keyboards without a numpad): arrow keys press the numpad directions 8/4/6/2 that eratoho-style games read for movement
    const key = ARROW_DIGIT[e.key] ?? e.key;
    if ([...key].length !== 1) return false;
    if (this.kind === 'oneint' && !/^[0-9]$/.test(key)) return false;
    const k = this.kind;
    this.kind = ''; // answered: a second key before the game asks again is not another answer
    if (this.submit(key)) return true;
    this.kind = k;
    return false;
  }
  /** returns true when the shell should preventDefault. Rules (as in Emuera): during INPUTMOUSEKEY a press on the stage is a game event;
   *  otherwise left click at a wait continues, right click at a wait continues and skips to the next real input, right click on a button presses it and skips. */
  pointerDown(e: PointerDown): boolean {
    if (this.kind === 'mousekey' && !e.onChrome && e.inside) {
      if (e.pointing !== undefined) this.setPointing(e.pointing); // posted before the click: the worker reads it when the click arrives
      this.sendMouseKey([1, mouseButtonCode(e.button), e.x, e.y, 0, 0]);
      return true;
    }
    if (e.onControl) return false;
    if (e.button === 2) {
      if (e.pressButton) {
        this.skip = true;
        e.pressButton();
        return true;
      }
      if (this.isWait) {
        this.skip = true;
        this.kind = '';
        this.submit('');
        return true;
      }
      return false;
    }
    if (e.button === 0 && !e.pressButton && this.isWait) {
      this.kind = '';
      this.submit('');
    }
    return false;
  }
  /** wheel over the stage during INPUTMOUSEKEY; returns true if consumed (shell preventDefaults) */
  wheel(deltaY: number, x: number, y: number, inside: boolean): boolean {
    if (this.kind !== 'mousekey' || !inside) return false;
    this.sendMouseKey([2, deltaY < 0 ? 120 : -120, x, y, 0, 0]);
    return true;
  }
  /** pointer position for MOUSEX/MOUSEY, throttled to about 33 Hz */
  pointerMove(x: number, y: number) {
    const now = performance.now();
    if (now - this.lastMove < 30) return;
    this.lastMove = now;
    this.post({ type: 'mousepos', x, y });
  }
  /** keydown: returns true if consumed by INPUTMOUSEKEY (shell preventDefaults). Also forwards key state and stops skipping. */
  keyDown(e: {
    keyCode: number;
    key: string;
    repeat: boolean;
    isComposing: boolean;
    shift: boolean;
    ctrl: boolean;
    alt: boolean;
  }): boolean {
    if (!e.repeat) this.post({ type: 'keystate', code: e.keyCode, down: true });
    if (this.skip) {
      this.skip = false;
      this.hooks.status('Skip stopped.');
    }
    if (this.kind !== 'mousekey' || e.isComposing) return false;
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt') return false;
    this.sendMouseKey([3, e.keyCode, e.keyCode | modifierBits(e), 0, 0, 0]);
    return true;
  }
  keyUp(keyCode: number) {
    this.post({ type: 'keystate', code: keyCode, down: false });
  }
  setActive(active: boolean) {
    this.post({ type: 'active', active });
  }
  setPointing(value: string) {
    this.post({ type: 'pointing', value });
  }
  setInputText(value: string) {
    this.post({ type: 'inputtext', value });
  }
  setCard(saves: Record<string, { info: string; data: string }>, files: Record<string, string>) {
    this.post({ type: 'card', saves, files });
  }
  private nativeWait = new Map<number, (m: Extract<ToPage, { type: 'native' }>) => void>();
  private nativeId = 0;
  private native(msg: (id: number) => ToWorker): Promise<Extract<ToPage, { type: 'native' }>> {
    return new Promise((ok) => {
      const id = ++this.nativeId;
      this.nativeWait.set(id, ok);
      this.post(msg(id));
    });
  }
  /** convert Emuera save files into slot records for the running game (the shell stores them); needs a game to be running */
  async nativeImport(files: { name: string; bytes: ArrayBuffer }[]): Promise<NativeImported[]> {
    const r = await this.native((id) => ({ type: 'native', id, op: 'import', files }));
    if (r.error) throw new Error(r.error);
    return r.imported ?? [];
  }
  /** convert slot records of the running game ('save3', 'global', ...) into Emuera save files */
  async nativeExport(keys: string[]): Promise<NativeExported[]> {
    const r = await this.native((id) => ({ type: 'native', id, op: 'export', keys }));
    if (r.error) throw new Error(r.error);
    return r.exported ?? [];
  }
  /** `verbose`: the longer lists (all load diagnostics, warnings, inputs, debug lines; more screen text and ERB calls) instead of the short ones */
  exportLog(note: string, withState: boolean, verbose = false) {
    this.post({ type: 'exportlog', note, withState, verbose });
  }
  /** the game snapshot alone: `hooks.logexport` gets an empty `text` */
  exportSnapshot() {
    this.post({ type: 'exportsnapshot' });
  }
}
