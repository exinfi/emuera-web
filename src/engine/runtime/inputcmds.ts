// INPUT family and INPUTMOUSEKEY, with the semantics of the original console:
//  - an empty answer takes the default, except while a timed input's timer still runs (then an empty int is refused)
//  - when the time limit runs out the host answers TIMEOUT; TimeUpMes replaces the "Remaining:" line (or is printed) and the default is taken
//  - the accepted text is echoed; INPUTANY accepts both: an integer goes to RESULT, other text to RESULTS
import type { Stmt, FuncDef } from '../compiler/types';
import { compile, compileForm, Frame, toNum } from './eval';
import type { Expr } from '../compiler/ast';
import { COMMANDS, Factory, StarvedError } from './commands';
import { def } from './funcs';
import { TIMEOUT, MK_PREFIX } from './host';
import * as V from './value';
import { EmueraError, Value } from './value';
import { Gen, VM } from './vm';
import { exprs } from './cmdargs';

/**
 * An input command's arguments are plain values (time limit, default, flags). `compileArg` is for REF parameters and hands a variable back as an array handle ({ arrArg, arr, off }):
 * a local `#DIM T` is such a one-element array, so `TINPUT T, 4, 1` read the time limit as NaN and the timer, the "Remaining" line and the time-up default all silently vanished
 * (AnonTW's hanetsuki passes ACTUAL_TIMEOUT, a variable). An omitted argument (`__EMPTY__`) stays undefined.
 */
const valueArg = (e: Expr, fn: FuncDef, vm: VM) =>
  e.k === 'var' && e.name === '__EMPTY__' ? ((() => undefined) as unknown as (fr: Frame) => Value) : compile(e, fn, vm);
const intRe = /^\s*[+-]?\d+\s*$/;
const list = (st: Stmt) => (st.arg.a === 'exprs' ? st.arg.list : []);
const txt = (v: Value) => (typeof v === 'string' ? v : String(v));

/** one answer from the host; handles starvation and returns [text, timedOut] */
function* ask(vm: VM, req: Record<string, unknown>): Generator<any, [string, boolean], string | null> {
  const r = (yield { t: 'input', ...req }) as string | null;
  if (r === null) throw new StarvedError();
  vm.lastTimeout = r === TIMEOUT;
  return r === TIMEOUT ? ['', true] : [r, false];
}

type Spec = { str: boolean; one: boolean; timed: boolean };
/** EmueraConsole mouse handling: a click that answers a mouse-flagged INPUT(S) also sets RESULT:1 (click type), RESULT:2 (modifier bits) and RESULTS:1 (the clicked button's text) */
const applyClick = (vm: VM, mouseOn: boolean, text: string) => {
  const c = vm.inputState.click;
  vm.inputState.click = null;
  if (!mouseOn || !c) return;
  vm.setResult(c.b, 1);
  vm.setResult(c.k, 2);
  if (text !== '') vm.setResult(text, 1);
};
/** ONEINPUT-family waits take one character, unless the answer is a clicked button and the config allows long input by mouse (EmueraConsole.PressEnterKey, `!AllowLongInputByMouse || !changedByMouse`) */
const keepLong = (vm: VM) => vm.config.allowLongInputByMouse && vm.inputState.byMouse;
const make =
  ({ str, one, timed }: Spec): Factory =>
  (st, fn, vm) => {
    let a = list(st).map((e) => valueArg(e, fn, vm));
    if (st.arg.a === 'inputs') {
      const f = st.arg.def ? compileForm(st.arg.def, fn, vm) : null;
      a = [
        ...(f ? [(fr: Frame) => f(fr) as Value] : [undefined as any]),
        ...st.arg.rest.map((e) => valueArg(e, fn, vm)),
      ];
    }
    // INPUT [def [, mouse [, canskip]]]  /  TINPUT time, def [, disp [, timeoutmsg [, mouse [, canskip]]]]
    const [time, dflt, disp, tmsg, mouse, canSkip] = timed ? a : [undefined, a[0], undefined, undefined, a[1], a[2]];
    if (timed && a.length < 2) throw new EmueraError(`${st.cmd}: too few arguments`);
    return (fr): Gen =>
      (function* (): Gen {
        const hasDef = timed || !!dflt;
        let defV: Value = hasDef ? dflt!(fr) : str ? '' : 0;
        if (!timed && one && !str && typeof defV !== 'string') {
          /* ONEINPUT: Emuera EM+EE no longer truncates the default */
        }
        const mouseOn = mouse ? (timed ? Number(mouse(fr)) === 1 : !V.isZero(mouse(fr) as any)) : false; // TINPUT tests `== 1`, INPUT `!= 0`
        if (canSkip && vm.mesSkip) {
          // EE: skip-able input answers with its default
          if (!mouseOn) vm.setResult(defV, 0);
          else vm.setResult(defV, 1);
          return;
        }
        const limit = timed ? Number(time!(fr)) : 0;
        const show = timed ? (disp ? !V.isZero(disp(fr) as any) : true) : false;
        const upMsg = timed ? (tmsg ? txt(tmsg(fr)) : vm.config.timeupLabel) : '';
        if (timed && limit > 0 && show) {
          vm.host.print(`Remaining: ${(limit / 1000).toFixed(1)}`);
          vm.host.newline();
        }
        for (;;) {
          const [raw, timedOut] = yield* ask(vm, {
            kind: str ? (one ? 'onestr' : 'str') : one ? 'oneint' : 'int',
            def: hasDef ? txt(defV) : undefined,
            timeoutMs: limit > 0 ? limit : undefined,
            countdown: limit > 0 && show,
            mouse: mouseOn,
          });
          const running = limit > 0 && !timedOut;
          let text = raw;
          if (timedOut) {
            // changeLastLine(TimeUpMes) when the countdown was shown, else PrintSingleLine(TimeUpMes)
            if (show) vm.host.clearLines(1);
            if (show || tmsg) {
              vm.host.print(upMsg);
              vm.host.newline();
            }
          }
          if (str) {
            if (text === '' && hasDef && !running) text = txt(defV);
            if (one && !keepLong(vm)) text = text.slice(0, 1);
            vm.echoInput(text);
            vm.setResult(text, 0);
            applyClick(vm, mouseOn, text);
            return;
          }
          if (text.trim() === '' && hasDef && !running) text = txt(defV);
          if (!intRe.test(text)) continue;
          const shown = one && !keepLong(vm) ? text.trim().slice(0, 1) : text.trim();
          if (one && !intRe.test(shown)) continue;
          vm.echoInput(shown);
          vm.setResult(V.parseIntLoose(shown), 0);
          applyClick(vm, mouseOn, '');
          return;
        }
      })();
  };
for (const [n, s] of Object.entries({
  INPUT: { str: false, one: false, timed: false },
  INPUTS: { str: true, one: false, timed: false },
  ONEINPUT: { str: false, one: true, timed: false },
  ONEINPUTS: { str: true, one: true, timed: false },
  TINPUT: { str: false, one: false, timed: true },
  TINPUTS: { str: true, one: false, timed: true },
  TONEINPUT: { str: false, one: true, timed: true },
  TONEINPUTS: { str: true, one: true, timed: true },
} as Record<string, Spec>))
  COMMANDS[n] = make(s);
COMMANDS.BINPUT = COMMANDS.INPUT;
COMMANDS.BINPUTS = COMMANDS.INPUTS;
COMMANDS.ONEBINPUT = COMMANDS.ONEINPUT;
COMMANDS.ONEBINPUTS = COMMANDS.ONEINPUTS;

// INPUTANY: an integer answer goes to RESULT, anything else to RESULTS
COMMANDS.INPUTANY =
  (_st, _fn, vm) =>
  (_fr: Frame): Gen =>
    (function* (): Gen {
      const [raw] = yield* ask(vm, { kind: 'any' });
      if (intRe.test(raw)) vm.setResult(V.parseIntLoose(raw.trim()), 0);
      else vm.setResult(raw, 0);
      vm.echoInput(raw);
    })();

// TWAIT time [, mode]: waits for a key for a limited time; the mode 1 ignores keys (waits the full time)
COMMANDS.TWAIT = (st, fn, vm) => {
  const a = list(st).map((e) => valueArg(e, fn, vm));
  return (fr): Gen =>
    (function* (): Gen {
      if (vm.system.skipDisp) return; // IS_PRINT: skipped under SKIPDISP
      const ms = Number(a[0](fr));
      const force = a[1] ? !V.isZero(a[1](fr) as any) : false;
      yield* ask(vm, { kind: 'wait', timeoutMs: ms > 0 ? ms : undefined, force });
    })();
};

// FLOWINPUT def [, enable [, canskip [, forceskip]]] / FLOWINPUTS enable [, def$]: configure the system flow's input requests
def('FLOWINPUT', (vm, args) => {
  const s = vm.flow;
  s.flowinputDef = Number(args[0] ?? 0);
  if (args.length > 1) s.flowinput = !V.isZero(args[1] as any);
  if (args.length > 2) s.flowinputCanSkip = !V.isZero(args[2] as any);
  if (args.length > 3) s.flowinputForceSkip = !V.isZero(args[3] as any);
  return 0;
});
def('FLOWINPUTS', (vm, args) => {
  const s = vm.flow;
  s.flowinputString = !V.isZero(args[0] as any);
  if (args.length > 1) s.flowinputDefString = txt(args[1]);
  return 0;
});
void ({} as FuncDef);

// INPUTMOUSEKEY [timeout ms]: RESULT:0 = event type (1 click, 2 wheel, 3 key, 4 timeout); the rest depend on the type (see Emuera's EmueraConsole.InputMouseKey)
COMMANDS.INPUTMOUSEKEY = (st, fn, vm) => {
  const l = exprs(st).map((e) => compile(e, fn, vm));
  return (fr): Gen =>
    (function* (): Gen {
      const ms = l[0] ? toNum(l[0](fr)) : 0;
      const r = yield { t: 'input', kind: 'mousekey', timeoutMs: ms > 0 ? ms : undefined, mouse: true };
      if (r === null) throw new StarvedError();
      let ev: number[];
      if (r.startsWith(MK_PREFIX)) ev = JSON.parse(r.slice(MK_PREFIX.length));
      else {
        const k = r.length ? r.toUpperCase().charCodeAt(0) : 13;
        ev = [3, k, k, 0, 0, 0];
      } // plain text (headless): a key press
      for (let i = 0; i < 6; i++) vm.setResult(ev[i] ?? 0, i);
    })();
};
