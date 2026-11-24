/**
 * The VM: runs compiled Stmt[] with generators. A generator yields a Request when it needs the
 * host (input/wait) and is resumed with the host's Response, so the core stays synchronous,
 * DOM-free and trivially testable.
 */
import { loadXml, outerXml } from './xmldom';
import { DataTable } from './datatable';
import { lineStr } from './strfuncs';
import type { Expr } from '../compiler/ast';
import { key } from '../util/key';
import type { Tables } from '../compiler/tables';
import type { FuncDef, Program, Stmt } from '../compiler/types';
import { Cursor } from '../compiler/cursor';
import { makeResolver } from '../compiler/resolve';
import { ExprParser } from '../compiler/expr';
import { LazyFrame, asInt, compile, compileArg, compileForm, Fn, Frame, isArrArg, resolveRef } from './eval';
import { configValue, loadConfig } from './config';
import './varbyname';
import './csvfuncs';
import './filefuncs';
import './envfuncs';
import './sound';
import './arrayfuncs';
import './savedata';
import { SystemFlow } from './system';
import './charas';
import './consolestate';
import './strfuncs';
import './printcmds';
import './listcmds';
import './inputcmds';
import './systemcmds';
import './varcmds';
import './datacmds';
import './windowcmds';
import './tooltipcmds';
import './htmlfuncs';
import './puchicmds';
import './xmlfuncs';
import { newConState, ConState } from './consolestate';
import './gfxfuncs';
import { methodStatement } from './methodcmds';
import { Chara } from './vars';
import { Gfx } from './gfx';
import { COMMANDS, Runner, StarvedError } from './commands';
import { FUNCS } from './funcs';
import type { Renderer, Request, Response } from './host';
import * as V from './value';
import { EmueraError, Int, Value } from './value';
import { Store } from './vars';
import { noteFrame } from './errctx';

const ZERO_DEFAULT = new Set([
  'ASSERT',
  'CALLTRAIN',
  'CUPCHECK',
  'DOTRAIN',
  'FORCEKANA',
  'LOADDATA',
  'REDRAW',
  'RESET_STAIN',
  'SKIPDISP',
  'SKIPLOG',
  'FONTSTYLE',
  'PRINT_ABL',
  'PRINT_EXP',
  'PRINT_MARK',
  'PRINT_PALAM',
  'PRINT_TALENT',
]);

export type Gen<T = void> = Generator<Request, T, Response>;

export class JumpSignal {
  constructor(
    public fn: FuncDef,
    public args: Value[],
  ) {}
}
/** thrown by LOADDATA / the load screen: the whole script call stack is discarded and the system flow resumes at LoadData_DataLoaded */
export class LoadSignal {}
export class QuitSignal {}
export class ReturnSignal {}

const TRACE = Number((globalThis as any).process?.env?.EMU_TRACE ?? 0); // EMU_TRACE=N logs every Nth step
const fnTime = new Map<string, number>();
const PROF = !!(globalThis as any).process?.env?.EMU_PROF;
const fnSteps = new Map<string, number>();
if (PROF)
  (globalThis as any).process.on('exit', () =>
    console.error(
      '[steps]',
      [...fnSteps]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([k, v]) => `${k}=${(v / 1e6).toFixed(2)}M`)
        .join(' '),
      'total',
      ([...fnSteps.values()].reduce((a, b) => a + b, 0) / 1e6).toFixed(1) + 'M',
    ),
  );
if (TRACE)
  process.on('exit', () =>
    console.error(
      '[fnTime]',
      [...fnTime]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([k, v]) => `${k}=${Math.round(v)}ms`)
        .join(' '),
    ),
  );
const EVENT_KINDS = ['PRI', 'NORMAL', 'LATER'] as const;

const nonDefault = (a: unknown[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== 0 && a[i] !== '') return true;
  return false;
};

/**
 * JSON.parse for snapshots/saves. Big integers are written as {"$b":"..."}; the reviver that turns them back into BigInt
 * costs a call per value (5.8 s against 0.4 s on a 30 MB save), so it is only used when the text holds any.
 */
export function parseSaveText(text: string): any {
  if (!text.includes('"$b"')) return JSON.parse(text);
  return JSON.parse(text, (_: string, v: any) => (v && typeof v === 'object' && '$b' in v ? BigInt(v.$b) : v));
}

/** a Set that counts its real changes, so caches built from it (the ENUMFILES index) know exactly when they are stale: same size is not same content */
export class VersionedSet extends Set<string> {
  version = 0;
  add(v: string) {
    if (!this.has(v)) this.version++;
    return super.add(v);
  }
  delete(v: string) {
    const had = super.delete(v);
    if (had) this.version++;
    return had;
  }
  clear() {
    if (this.size) this.version++;
    super.clear();
  }
}
export class VM {
  store: Store;
  rng: () => number = Math.random;
  /**
   * Emuera's legacy generator. Null until RANDOMIZE (or INITRAND / DUMPRAND) first needs it: until then draws come from `rng`. Once it exists every draw uses it, as the original does.
   * `useNewRandom` is the game's setting.json key: when true RANDOMIZE, INITRAND and DUMPRAND do nothing and draws never use the legacy generator.
   */
  mt: import('./sfmt').MTRandom | null = null;
  useNewRandom = false;
  stepCount = 0;
  /** Emuera.EM MAP_* storage */
  maps = new Map<string, Map<string, string>>();
  /** XML_DOCUMENT stores (key = the id as text): not part of save files */
  xmlDocs = new Map<string, import('./xmldom').DocNode>();
  config: import('./config').RuntimeConfig = loadConfig({});
  /** colours / style / alignment / redraw of the console, for GETCOLOR.. and friends */
  con: ConState = newConState();
  /** FORCEKANA state: 0 off, 1 katakana, 2 hiragana, 3 hiragana + full-width */
  kana = 0;
  /** EmueraConsole.MesSkip: message skipping is on (INPUT* with a CanSkip argument answer by themselves) */
  mesSkip = false;
  /** TOOLTIP_* state: defaults are WinForms ToolTip's (500 ms delay, stays until the pointer leaves, black on Info yellow) */
  tooltip: {
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
  lastTimeout = false;
  windowTitle: string | null = null;
  /** host-fed input state for GETKEY / GETKEYTRIGGERED / MOUSEB / ISACTIVE */
  inputState = {
    keys: new Set<number>(),
    toggleBit: new Array<number>(256).fill(0),
    seen: new Array<number>(256).fill(0),
    pointing: '',
    active: true,
    /** the answer now being delivered to an input wait came from a button click (EmueraConsole changedByMouse); set by the host just before it resolves the wait */
    byMouse: false,
    /** the click behind that answer (EmueraConsole MouseUp): b = 1 left / 2 right / 3 middle, k = modifier bits (Shift 2^16, Ctrl 2^17, Alt 2^18); null for typed input */
    click: null as { b: number; k: number } | null,
  };
  bitmapCache = false;
  hotkeys = new Map<number, number>();
  /** QUIT_AND_RESTART / FORCE_QUIT_AND_RESTART: the host boots the game again once the run ends */
  restart = false;
  textFiles = new Map<string, string>();
  /**
   * Shipped text files the host left in their zip (option `xrefs`): key (as in `textFiles`) -> a reader that returns the decoded text, or undefined
   * when it cannot be read. `textFiles` wins when a key is in both (a file the game saved over it). Decoded texts are kept in a bounded
   * least-recently-used cache and read again when dropped.
   */
  lazyTexts = new Map<string, () => string | undefined>();
  private textCache = new Map<string, string>();
  private textCacheChars = 0;
  /** decoded characters kept (about 32 MB as JS strings) */
  textCacheBudget = 16_000_000;
  hasText(k: string): boolean {
    return this.textFiles.has(k) || this.lazyTexts.has(k);
  }
  /** the text of a game file by key, or undefined when there is none (or a lazy one could not be read) */
  getText(k: string): string | undefined {
    const t = this.textFiles.get(k);
    if (t !== undefined) return t;
    const rd = this.lazyTexts.get(k);
    if (!rd) return undefined;
    const hit = this.textCache.get(k);
    if (hit !== undefined) {
      this.textCache.delete(k); // most recently used goes last
      this.textCache.set(k, hit);
      return hit;
    }
    const s = rd();
    if (s === undefined) return undefined;
    this.textCache.set(k, s);
    this.textCacheChars += s.length;
    for (const [o, v] of this.textCache) {
      if (this.textCacheChars <= this.textCacheBudget || o === k) break;
      this.textCache.delete(o);
      this.textCacheChars -= v.length;
    }
    return s;
  }
  /** lower-cased relative names of the files under sound/ (EXISTSOUND / PLAYSOUND check these; the host owns the bytes) */
  soundFiles = new Set<string>();
  /** family names of the fonts the host registered (game-embedded or user-imported); CHKFONT answers 1 for them */
  fontFamilies: string[] = [];
  /** relative paths (forward slashes) of the files that make up the game folder, for ENUMFILES */
  gameFiles: string[] = [];
  /** lower-cased, forward-slash paths of files that are in the game zip but were not loaded (the host's loader skipped them) */
  unloadedFiles = new Set<string>();
  /**
   * Safety net for the loader's folder rules: when a game asks for a file we do not have (LOADTEXT, EXISTFILE, ENUMFILES, GCREATEFROMFILE) and
   * that path (or, for a folder, anything under it) is in the zip, say so in the host notes instead of leaving a silent empty result.
   */
  missedFile(fname: string, path: string, folder = false) {
    if (!this.unloadedFiles.size) return;
    const p = path
      .replace(/\\/g, '/')
      .replace(/^\.?\//, '')
      .replace(/\.\.\//g, '')
      .toLowerCase();
    let hit = '';
    if (folder) {
      const pre = p.replace(/\/$/, '') + '/';
      for (const f of this.unloadedFiles)
        if (f.startsWith(pre)) {
          hit = pre;
          break;
        }
    } else if (this.unloadedFiles.has(p)) hit = p;
    else {
      const dot = p + '.';
      for (const f of this.unloadedFiles)
        if (f.startsWith(dot)) {
          hit = f;
          break;
        }
    }
    if (hit)
      this.host.note(
        `${fname}: "${path}" is in the game zip but was not loaded (outside the folders the loader reads; tick "enable extra file check" and reload the game)`,
      );
  }
  /** keys written by the game (SAVETEXT): these belong on the memory card, shipped text files do not */
  userFiles = new VersionedSet();
  /** pointer position in client coordinates, y measured from the bottom edge (so it is <= 0), as Emuera reports it */
  mouse = { x: 0, y: 0 };
  /** what the game last read through MOUSEX / MOUSEY and how often (debug log: where popups placed from the pointer should have landed) */
  mouseRead = { x: 0, y: 0, n: 0 };
  onPersistFile?: (key: string, text: string) => void;
  gfx = new Gfx();
  /** profile 'puchi' only: the fixed-image layer and screen effects (runtime/fixedimg.ts); null for every other game */
  fixed: import('./fixedimg').FixedImages | null = null;
  /** SAVEDATA slots (key 'save<N>' / 'global') and the persistence hook */
  saves = new Map<string, { info: string; data: string }>();
  onPersist?: (key: string, v: { info: string; data: string } | null) => void;
  dts = new Map<string, import('./datatable').DataTable>();
  /** hook: fill a freshly added character from its CSV template */
  initChara?: (index: number, no: number) => void;
  templates?: import('./charatemplates').CharaTemplates;
  maxSteps = Infinity;
  /** opt-in game patches: native replacements for specific functions (see src/engine/patches) */
  natives?: Map<FuncDef, (vm: VM, args: Value[]) => Generator<any, void | number, any>>;
  /** diagnostics for commands/functions we do not implement yet */
  unimplemented = new Map<string, number>();
  /**
   * DEBUGPRINT / DEBUGPRINTL / DEBUGPRINTFORM / DEBUGPRINTFORML text, distinct lines with a count (capped). The original writes it to the debug console window, which the web
   * build has no equivalent of; the playtest log lists it under Diagnostics instead, so a game's own "Missing X in CALLNAME_JP" style warnings are not lost. Not shown on the game screen.
   */
  debugLines = new Map<string, number>();
  /** file queries that found nothing (ENUMFILES), first distinct ones with a count, for the playtest log: shows which folder a game asked for when its images or data are not found */
  fileMisses = new Map<string, number>();
  noteFileMiss(t: string) {
    const n = this.fileMisses.get(t);
    if (n !== undefined) this.fileMisses.set(t, n + 1);
    else {
      if (this.fileMisses.size >= 60) {
        const k = [...this.fileMisses.keys()][8];
        this.fileMisses.delete(k);
      }
      this.fileMisses.set(t, 1);
    } // the first 8 distinct stay, then a sliding window of the latest
  }
  debugPrint(text: string) {
    const t = text.replace(/\r?\n/g, ' ').trim();
    if (!t) return;
    const n = this.debugLines.get(t);
    if (n !== undefined) this.debugLines.set(t, n + 1);
    else if (this.debugLines.size < 200) this.debugLines.set(t, 1);
  }
  system = { state: 'TITLE', skipDisp: false, printCLength: 25 };
  private runners = new WeakMap<Stmt, Runner>();
  private formCache = new Map<string, (fr: Frame) => string>();

  flow = new SystemFlow(this);
  /** LASTLOAD_NO / LASTLOAD_TEXT / LASTLOAD_VERSION: what the last LOADDATA read (reset by ResetData) */
  lastLoad = { no: -1, text: '', version: -1 };

  constructor(
    public prog: Program,
    public tables: Tables,
    public host: Renderer,
  ) {
    this.store = new Store(tables, prog.globals);
    // VariableData.SetDefaultValue: system arrays whose initial contents are not zero
    this.store.defaultFor = (k) => {
      switch (k) {
        case 'ITEMPRICE':
          return tables.itemPrice.map((x) => x ?? 0);
        case 'STR':
          return tables.strInit.map((x) => x ?? '');
        case 'PALAMLV':
          return this.config.palamLvDef;
        case 'EXPLV':
          return this.config.expLvDef;
        case 'ASSI':
          return [-1];
        case 'TARGET':
          return [1];
        case 'PBAND':
          return [this.config.pbandDef];
        case 'EJAC':
          return [10000];
        default: {
          // ABLNAME, ITEMNAME, TRAINNAME ... are string arrays filled from the CSV name tables
          if (k.endsWith('NAME') && !k.startsWith('CALL')) {
            const t = tables.tableFor(k);
            if (t) {
              const tr = tables.trTableOf(k);
              return t.names.map((x) => (tr ? tables.trName(tr, x) : x) ?? '');
            }
          } // 'puchi' only: tables.trNames is null elsewhere, so tr is undefined
          return undefined;
        }
      }
    };
  }

  // ---------------------------------------------------------------- variables
  global(name: string): import('./vars').Arr {
    const m = this.store.meta(name)!;
    return this.store.globalArr(m);
  }
  setResult(v: Value, idx = 0) {
    this.global(typeof v === 'string' ? 'RESULTS' : 'RESULT')[idx] = v;
  }
  targetIndex(): number {
    return Number(this.global('TARGET')[0]);
  }
  note(what: string) {
    this.unimplemented.set(what, (this.unimplemented.get(what) ?? 0) + 1);
  }

  calcGetter(up: string): (idx: Value[]) => Value {
    switch (up) {
      case 'RAND':
        return (i) => this.randInt(asInt(i[0] ?? 0));
      case 'CHARANUM':
        return () => this.store.charas.length;
      case 'LASTLOAD_NO':
        return () => this.lastLoad.no;
      case 'LASTLOAD_TEXT':
        return () => this.lastLoad.text;
      case 'LASTLOAD_VERSION':
        return () => this.lastLoad.version;
      case 'LINECOUNT':
        return () => this.host.lineCount?.() ?? 0;
      case 'MONEYLABEL':
        return () => this.config.moneyLabel;
      case '__INT_MAX__':
        return () => 9223372036854775807n;
      case '__INT_MIN__':
        return () => -9223372036854775808n;
      // outside the debug build the original returns empty values (EmptyStrToken / EmptyIntToken)
      case '__FILE__':
      case '__FUNCTION__':
        return () => '';
      case '__LINE__':
        return () => 0;
      case 'ISTIMEOUT':
        return () => (this.lastTimeout ? 1 : 0);
      case 'EMUERA_VERSION':
        return () => '1.824.0.0';
      case 'DRAWLINESTR':
        return () => lineStr(this, this.config.drawLine);
      case 'WINDOW_TITLE':
        return () => this.windowTitle ?? this.tables.gameBase.get('TITLE') ?? '';
      default:
        if (up.startsWith('GAMEBASE_')) {
          const raw =
            this.tables.gameBase.get(up.slice(9)) ??
            (up === 'GAMEBASE_AUTHER' ? this.tables.gameBase.get('AUTHOR') : undefined);
          const isStr = ['TITLE', 'AUTHOR', 'AUTHER', 'INFO', 'URL', 'VERSIONNAME', 'YEAR'].includes(up.slice(9));
          return () => (isStr ? (raw ?? '') : Number(raw ?? 0) || 0);
        }
        return () => {
          this.note(`var:${up}`);
          return 0;
        };
    }
  }
  calcSetter(up: string, _idx: Value[], v: Value) {
    if (up === 'WINDOW_TITLE') {
      this.windowTitle = String(v);
      this.host.setTitle?.(this.windowTitle);
      return;
    }
    throw new EmueraError(`${up} is read-only`);
  }

  randInt(n: Int): Int {
    const m = Number(n);
    if (m <= 0) throw new EmueraError('RAND: argument must be positive');
    if (this.mt && !this.useNewRandom) return this.mt.nextMod(n);
    return Math.floor(this.rng() * m);
  }

  // -------------------------------------------------------------- compilation
  compileCall(e: Expr & { k: 'call' }, fn: FuncDef): Fn {
    const up = key(e.name);
    const user = this.prog.funcs.get(up)?.find((f) => f.method);
    if (user) {
      const args = e.args.map((a) => compileArg(a, fn, this, true));
      return (fr) =>
        this.callMethod(
          user,
          args.map((a) => a(fr)),
        );
    }
    const bf = FUNCS[up];
    if (!bf) {
      return () => {
        this.note(`fn:${up}`);
        throw new EmueraError(`unknown function ${e.name}`);
      };
    }
    // omitted arguments (`F(a,,b)`) reach raw builders as holes (undefined), so `args[i] ? compile(..) : default` applies the default
    // a trailing comma adds no argument (ExpressionParser.ReduceArguments stops at the end of the list), so `DT_ROW_ADD t, "a", 1,` has 3 arguments, not 4
    if (bf.raw) {
      const ra = [...e.args];
      while (ra.length && ra[ra.length - 1].k === 'var' && (ra[ra.length - 1] as { name: string }).name === '__EMPTY__')
        ra.pop();
      return bf.raw(
        this,
        ra.map((a) => (a.k === 'var' && a.name === '__EMPTY__' ? (undefined as unknown as typeof a) : a)),
        fn,
      );
    }
    // omitted arguments (`F(a,,b)`, `F(a,)`) arrive as undefined (the original's null) so each function applies its own default; trailing ones are dropped like an absent argument
    const eargs = [...e.args];
    while (
      eargs.length &&
      eargs[eargs.length - 1].k === 'var' &&
      (eargs[eargs.length - 1] as { name: string }).name === '__EMPTY__'
    )
      eargs.pop();
    const args = eargs.map((a) =>
      a.k === 'var' && a.name === '__EMPTY__' ? () => undefined as unknown as Value : compile(a, fn, this),
    );
    const run = bf.run;
    if (TRACE)
      return (fr) => {
        const t0 = performance.now();
        const r = run(
          this,
          args.map((a) => a(fr)),
          fr,
        );
        fnTime.set(up, (fnTime.get(up) ?? 0) + performance.now() - t0);
        return r;
      };
    switch (args.length) {
      case 0:
        return (fr) => run(this, [], fr);
      case 1: {
        const [a0] = args;
        return (fr) => run(this, [a0(fr)], fr);
      }
      case 2: {
        const [a0, a1] = args;
        return (fr) => run(this, [a0(fr), a1(fr)], fr);
      }
      case 3: {
        const [a0, a1, a2] = args;
        return (fr) => run(this, [a0(fr), a1(fr), a2(fr)], fr);
      }
      default: {
        // GROUPMATCH(x, c1, c2, ...) with literal candidates (optimization 'groupmatch-const'): count equal literals, no per-call argument array
        if (up === 'GROUPMATCH' && this.optimize && eargs.length >= 2 && eargs.slice(1).every((a) => a.k === 'int')) {
          const consts = eargs.slice(1).map((a) => (a as { v: Int }).v),
            a0 = args[0];
          return (fr) => {
            const x = a0(fr);
            let n = 0;
            for (let i = 0; i < consts.length; i++) if (consts[i] === x) n++;
            return n;
          };
        }
        const cnt = args.length;
        return (fr) => {
          const out = new Array<Value>(cnt);
          for (let i = 0; i < cnt; i++) out[i] = args[i](fr);
          return run(this, out, fr);
        };
      }
    }
  }

  /** FORM string given as a runtime value (PRINTFORMS, CALLFORM names, ...). */
  private resolver?: ReturnType<typeof makeResolver>;
  formString(src: string, fn: FuncDef): (fr: Frame) => string {
    const k = `${key(fn.name)}\u0000${src}`;
    let f = this.formCache.get(k);
    if (!f) {
      const parts = new ExprParser(new Cursor(src)).form('eol', false);
      (this.resolver ??= makeResolver(this.prog, this.tables)).parts(parts, fn); // runtime-parsed text gets the same CSV-name resolution as source text
      f = compileForm(parts, fn, this);
      this.formCache.set(k, f);
    }
    return f;
  }

  runnerFor(st: Stmt, fn: FuncDef): Runner {
    let r = this.runners.get(st);
    if (!r) {
      // INT_EXPRESSION statements: a missing argument reads as 0 (INT_EXPRESSION_ArgumentBuilder)
      if (ZERO_DEFAULT.has(st.cmd) && !(st.arg.a === 'exprs' && st.arg.list.length > 0))
        st.arg = { a: 'exprs', list: [{ k: 'int', v: 0 }] } as typeof st.arg;
      const factory = COMMANDS[st.cmd];
      const mf = factory ? undefined : methodStatement(st.cmd);
      if (mf) r = mf(st, fn, this);
      else if (!factory) {
        const name = st.cmd;
        r = () => {
          this.note(`cmd:${name}`);
        };
      } else r = factory(st, fn, this);
      this.runners.set(st, r);
      (st as any).$run = r;
    }
    return r;
  }

  // ---------------------------------------------------------------- functions
  private funcMemo = new Map<string, FuncDef | null>();
  findFunc(name: string): FuncDef | undefined {
    let r = this.funcMemo.get(name);
    if (r === undefined) {
      r = this.prog.funcs.get(key(name))?.[0] ?? null;
      this.funcMemo.set(name, r);
    }
    return r ?? undefined;
  }

  /** ring of the last 200 ERB functions entered (for playtest logs; the log prints 40, or all 200 in its verbose form) */
  trail: string[] = new Array(200).fill('');
  trailN = 0;
  recentCalls(last = 40): string[] {
    const n = this.trailN,
      out: string[] = [];
    for (let i = Math.max(0, n - Math.min(last, 200)); i < n; i++) out.push(this.trail[i % 200]);
    return out;
  }
  /** `record: false` is for diagnostics that only evaluate an expression (state dumps, log context): such frames are not calls and stay out of the trail */
  newFrame(fn: FuncDef, record = true): Frame {
    if (record) this.trail[this.trailN++ % 200] = fn.name;
    return new LazyFrame(fn, this);
  }

  bindArgs(fr: Frame, args: Value[]) {
    const fn = fr.fn;
    if (fn.params.length) {
      fn.params.forEach((p, i) => {
        if (p.target.k !== 'var') return;
        const ref = resolveRef(p.target, fn, this);
        let v: Value | undefined = args[i];
        if (isArrArg(v)) {
          const decl = fn.vars.get(key(p.target.name));
          if (decl?.isRef) {
            (fr.refs ??= new Map()).set(key(p.target.name), { arr: v.arr, off: v.off, dims: v.dims });
            return;
          }
          v = v.v;
        }
        if (v === undefined) v = p.def ? compile(p.def, fn, this)(fr) : ref.meta.isStr ? '' : 0;
        if ((typeof v === 'string') !== ref.meta.isStr) {
          // Process.CalledFunction.ConvertArg: a string argument for an integer parameter is always an error; an integer for a string parameter is wrapped
          // in TOSTR() only when 「ユーザー関数の引数に自動的にTOSTRを補完する」 (CompatiFuncArgAutoConvert) is on (AnonTW's config turns it on)
          if (ref.meta.isStr && typeof v !== 'string' && configValue(this.config, 'CompatiFuncArgAutoConvert') === 1)
            v = String(v);
          else
            throw new EmueraError(
              `@${fn.name}: argument ${i + 1} type mismatch${ref.meta.isStr && typeof v !== 'string' ? ` (an integer was passed for a string parameter; the config item "ユーザー関数の引数に自動的にTOSTRを補完する" / CompatiFuncArgAutoConvert would convert it)` : ''}`,
            );
        }
        ref.set(fr, v);
      });
      return;
    }
    let ni = 0,
      si = 0;
    for (let a of args) {
      if (isArrArg(a)) a = a.v;
      if (typeof a === 'string') fr.args[si++] = a;
      else fr.arg[ni++] = a;
    }
    (fr as LazyFrame).hiA = ni;
    (fr as LazyFrame).hiAS = si; // see LazyFrame.release
  }

  /** Call as a statement (CALL/EVENT): runs until RETURN; JUMP replaces the frame. */
  *callFunction(fn: FuncDef, args: Value[]): Gen<Frame> {
    const nat = this.natives?.get(fn);
    if (nat) {
      const rv = yield* nat(
        this,
        args.map((a) => (isArrArg(a) ? a.v : a)),
      );
      this.setResult(typeof rv === 'number' ? rv : 0);
      return this.newFrame(fn);
    } // a native may hand back what the function RETURNs (RESULT:0); other RESULT slots it sets itself
    let cur = fn;
    let curArgs = args;
    for (;;) {
      const fr = this.newFrame(cur);
      this.bindArgs(fr, curArgs);
      try {
        yield* this.exec(fr);
        if (!fr.returned) this.setResult(0);
        (fr as LazyFrame).release?.();
        return fr;
      } catch (e) {
        if (e instanceof JumpSignal) {
          cur = e.fn;
          curArgs = e.args;
          continue;
        }
        if (e instanceof ReturnSignal) {
          (fr as LazyFrame).release?.();
          return fr;
        }
        throw e;
      }
    }
  }

  /** Call from inside an expression (#FUNCTION): must not need user input. */
  callMethod(fn: FuncDef, args: Value[]): Value {
    const nat = this.natives?.get(fn);
    if (nat) {
      // a game patch's native replacement (src/engine/patches): runs to completion at once, its return value is what the function RETURNF-s
      const r = nat(
        this,
        args.map((a) => (isArrArg(a) ? a.v : a)),
      ).next();
      if (!r.done) throw new EmueraError(`@${fn.name}: expression function tried to wait for input`);
      return typeof r.value === 'number' ? r.value : fn.method === 'str' ? '' : 0;
    }
    const fr = this.newFrame(fn);
    this.bindArgs(fr, args);
    const g = this.exec(fr);
    for (;;) {
      try {
        const r = g.next(null);
        if (r.done) break;
        throw new EmueraError(`@${fn.name}: expression function tried to wait for input`);
      } catch (e) {
        if (e instanceof ReturnSignal) break;
        throw e;
      }
    }
    const rv = fr.retval ?? (fn.method === 'str' ? '' : 0);
    (fr as LazyFrame).release?.();
    return rv;
  }

  /**
   * Event functions (CalledFunction.ShiftNext): #ONLY alone, otherwise the groups #PRI, normal, #LATER in order.
   * A #SINGLE function that RETURNs 1 skips the rest of its own group. Returns false when no such event exists.
   */
  *callEvent(name: string): Gen<boolean> {
    const list = this.prog.funcs.get(key(name));
    if (!list) return false;
    const only = list.find((f) => f.only);
    if (only) {
      yield* this.callFunction(only, []);
      return true;
    }
    for (const kind of EVENT_KINDS) {
      for (const f of list) {
        const k = f.pri ? 'PRI' : f.later ? 'LATER' : 'NORMAL';
        if (k !== kind) continue;
        const fr = yield* this.callFunction(f, []);
        if (f.single && fr.returned && Number(this.global('RESULT')[0]) === 1) break;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------- execution
  *exec(fr: Frame): Gen {
    const body = fr.fn.body;
    const fn = fr.fn;
    let st: Stmt | undefined;
    try {
      while (fr.pc < body.length) {
        if (++this.stepCount > this.maxSteps) throw new EmueraError('step limit reached');
        if (TRACE && this.stepCount % TRACE === 0)
          console.error(`[trace] step ${this.stepCount} @${fr.fn.name} pc=${fr.pc} t=${Date.now() % 1000000}`);
        st = body[fr.pc];
        if (PROF) fnSteps.set(fn.name, (fnSteps.get(fn.name) ?? 0) + 1);
        fr.pc++;
        const run = (st as any).$run ?? this.runnerFor(st, fn);
        const r = run(fr);
        if (r !== undefined) yield* r as Gen;
      }
    } catch (e) {
      this.annotate(e, fr, st, fn);
      throw e;
    }
  }

  /** error context added where a statement fails: frame notes for the playtest log and the [file:line @fn CMD] suffix (once) */
  private annotate(e: unknown, fr: Frame, st: Stmt | undefined, fn: FuncDef) {
    if (e instanceof Error && !(e instanceof StarvedError)) noteFrame(e, fr, st);
    if (st && e instanceof EmueraError && !(e as any).located) {
      (e as any).located = true;
      e.message = `${e.message} [${st.pos.file.split('/').pop()}:${st.pos.line} @${fn.name} ${st.cmd}]`;
    }
  }

  // ---------------------------------------------------------------- snapshots
  /** variables Emuera keeps in global.sav rather than in a normal save: GLOBAL, GLOBALS and #DIM ... GLOBAL */
  isGlobalKind(k: string): boolean {
    if (k === 'GLOBAL' || k === 'GLOBALS') return true;
    return !!this.prog.globals.get(k)?.isGlobal;
  }
  /**
   * Serializable copy of the game data (valid at a state boundary, e.g. the SHOP input; call stacks are not saved).
   * forSave: what a SAVEDATA slot holds (no GLOBAL data, no non-SAVEDATA #DIM); otherwise a full crash snapshot.
   */
  snapshot(forSave = false): string {
    const enc = (k: string, v: unknown) => (typeof v === 'bigint' ? { $b: v.toString() } : v);
    const keep = (k: string, a: unknown[]) => {
      if (forSave) {
        if (this.isGlobalKind(k)) return false;
        const u = this.prog.globals.get(k);
        if (u && !u.isSave) return false;
      }
      return nonDefault(a) || !!this.store.defaultFor?.(k);
    };
    const data = {
      global: [...this.store.global].filter(([k, a]) => keep(k, a)),
      statics: forSave ? [] : [...this.store.statics].filter(([, a]) => nonDefault(a)),
      charas: this.store.charas.map((c) => ({ no: c.no, vars: [...c.vars].filter(([, a]) => nonDefault(a)) })),
      maps: [...this.maps]
        .filter(([k]) => !forSave || this.config.varExt.maps.save.has(k))
        .map(([k, m]) => [k, [...m]]),
      dts: [...this.dts].filter(([k]) => !forSave || this.config.varExt.dts.save.has(k)).map(([k, t]) => [k, t.dump()]),
      xmls: [...this.xmlDocs]
        .filter(([k]) => !forSave || this.config.varExt.xmls.save.has(k))
        .map(([k, d]) => [k, outerXml(d)]),
      system: { printCLength: this.system.printCLength },
      ver: Number(this.tables.gameBase.get('VERSION') ?? 0) || 0,
      code: String(this.tables.gameBase.get('GAMECODE') ?? '0'),
    };
    // A replacer function runs once per value, which for a big roster (eraRanceK day 3: 14 million array elements) took 0.7 s of every autosave against 0.17 s without one.
    // Plain stringify gives the same text; it only throws on a BigInt, so each part is tried plain first and falls back to the encoding replacer on its own
    // (a single BigInt in the globals must not drag the character data through the slow path). Parts are joined in the original key order.
    const ser = (v: unknown): string => {
      try {
        return JSON.stringify(v);
      } catch (e) {
        if (!(e instanceof TypeError)) throw e;
        return JSON.stringify(v, enc);
      }
    };
    return '{' + (Object.keys(data) as (keyof typeof data)[]).map((k) => `"${k}":${ser(data[k])}`).join(',') + '}';
  }
  restore(text: string, fromSave = false) {
    const d = parseSaveText(text);
    if (fromSave) {
      this.lastLoad.version = d.ver ?? 0;
      // LoadFromStream: SetDefaultValue + SetDefaultLocalValue first. Everything except GLOBAL data returns to its initial value, plain (non-SAVEDATA) #DIM and #DIM STATIC included (userDefinedStaticVarList); then what the save holds is put back.
      // (eraFGO K / eratohoK: FIRST_NAME_ADDRESS is a plain #DIM that EVENTLOAD's name-list builder only ever increments)
      for (const k of [...this.store.global.keys()]) if (!this.isGlobalKind(k)) this.store.global.delete(k);
      this.store.statics.clear();
      for (const [k, a] of d.global) this.store.global.set(k, a);
    } else {
      this.store.global = new Map(d.global);
      /* omitted arrays are all-default and re-created lazily */ this.store.statics = new Map(d.statics);
    }
    this.store.charas = d.charas.map((c: any) => {
      const ch = new Chara(c.no);
      ch.vars = new Map(c.vars);
      return ch;
    });
    if (fromSave) {
      // LoadFrom: RemoveEMSaveData first (SAVE_* maps / tables are emptied), then what the save holds is put back; other MAPs / DTs stay
      this.clearExt('save');
      for (const [k, m] of d.maps) this.maps.set(k, new Map(m));
      for (const [k, t] of d.dts ?? []) this.dts.set(k, DataTable.load(t));
      for (const [k, x] of d.xmls ?? []) this.xmlDocs.set(k, loadXml(x));
    } else {
      this.xmlDocs = new Map((d.xmls ?? []).map(([k, x]: [string, string]) => [k, loadXml(x)]));
      this.maps = new Map(d.maps.map(([k, m]: any) => [k, new Map(m)]));
      this.dts = new Map((d.dts ?? []).map(([k, t]: any) => [k, DataTable.load(t)]));
    }
    Object.assign(this.system, d.system);
  }

  // ------------------------------------------------------- data resets / echo
  /** EmueraConsole.doInputToEmueraProgram: the typed answer is printed as a line of its own (also with SKIPDISP) */
  echoInput(text: string) {
    if (text === '') return;
    this.host.print(text);
    this.host.newline();
  }

  /** VariableData.RemoveEM{Save,Global,Static}Data: maps and data tables of that group are emptied (they keep existing), XML documents are removed */
  clearExt(group: 'save' | 'global' | 'static') {
    const x = this.config.varExt;
    for (const n of x.maps[group]) this.maps.get(n)?.clear();
    for (const n of x.dts[group]) this.dts.get(n)?.clearRows();
    for (const n of x.xmls[group]) this.xmlDocs.delete(n); // XML documents are removed (not emptied)
  }
  /** VariableEvaluator.ResetData: everything except GLOBAL data returns to its initial value and all characters are removed */
  resetData() {
    for (const k of [...this.store.global.keys()]) if (!this.isGlobalKind(k)) this.store.global.delete(k);
    this.store.statics.clear();
    this.store.charas.length = 0;
    this.clearExt('save'); // ResetData: RemoveEMSaveData
    this.lastLoad = { no: -1, text: '', version: -1 };
  }
  private zero(name: string, ci?: number) {
    const m = this.store.meta(name);
    if (!m) return;
    const a = ci === undefined ? this.store.globalArr(m) : this.store.charaArr(ci, m);
    a.fill(m.isStr ? '' : 0);
  }
  /** per-character STAIN := the configured defaults (setDefaultStain) */
  setDefaultStain(ci: number) {
    const m = this.store.meta('STAIN');
    if (!m) return;
    const a = this.store.charaArr(ci, m),
      d = this.config.stainDefault;
    for (let i = 0; i < a.length; i++) a[i] = d[i] ?? 0;
  }
  updateInBeginTrain() {
    this.global('ASSIPLAY')[0] = 0;
    this.global('PREVCOM')[0] = -1;
    this.global('NEXTCOM')[0] = -1;
    this.zero('TFLAG');
    this.zero('TSTR');
    for (let c = 0; c < this.store.charas.length; c++) {
      for (const n of ['GOTJUEL', 'TEQUIP', 'EX']) this.zero(n, c);
      this.setDefaultStain(c);
      for (const n of ['PALAM', 'SOURCE', 'TCVAR']) this.zero(n, c);
    }
  }
  updateAfterShowUsercom() {
    for (const n of ['UP', 'DOWN', 'LOSEBASE']) this.zero(n);
    for (let c = 0; c < this.store.charas.length; c++) for (const n of ['DOWNBASE', 'CUP', 'CDOWN']) this.zero(n, c);
  }
  updateAfterInputCom() {
    for (let c = 0; c < this.store.charas.length; c++) this.zero('NOWEX', c);
  }
  updateAfterSourceCheck() {
    for (let c = 0; c < this.store.charas.length; c++) this.zero('SOURCE', c);
  }

  // --------------------------------------------------------------- top level
  /** state to start in (restored snapshots start at the SHOP menu) */
  /** the single 'interpreter optimizations' switch (opts.ts); default off = original-faithful paths */
  optimize = false;
  setOptimize(on: boolean) {
    this.optimize = on;
    this.store.readZero = on;
  }
  startState = 'TITLE';
  /** Runs the system state machine from the title until QUIT or (outside strict mode) the script ends. */
  *run(): Gen {
    const start =
      this.startState === 'SHOP' ? 'Shop_CallShowShop' : this.startState === 'TITLE' ? 'Title_Begin' : this.startState;
    try {
      yield* this.flow.run(start);
    } catch (e) {
      if (e instanceof QuitSignal) return;
      throw e;
    }
  }
}

export type { Int };
export { V };
