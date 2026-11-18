/**
 * Statement runners. Each factory receives the Stmt + its function and returns a closure that
 * runs against a Frame. Control flow works by editing fr.pc (already advanced past the statement).
 */
import type { Expr, FormPart } from '../compiler/ast';
import { key } from '../util/key';
import type { FuncDef, Stmt } from '../compiler/types';
import { asInt, asStr, compile, compileArg, compileForm, Fn, Frame, resolveRef, toNum } from './eval';
import { Gen, JumpSignal, QuitSignal, VM } from './vm';
import * as V from './value';
import { EmueraError, Int, Value } from './value';
import { sjisWidth } from './text';
import { exprs } from './cmdargs';

export type Runner = (fr: Frame) => void | Gen;
export type Factory = (st: Stmt, fn: FuncDef, vm: VM) => Runner;

export const COMMANDS: Record<string, Factory> = {};

const toText = (v: Value) => (typeof v === 'string' ? v : String(v));

// ---------------------------------------------------------------- printing --
export class StarvedError extends Error {}

COMMANDS.DRAWLINE = (_s, _f, vm) => () => {
  if (!vm.system.skipDisp) vm.host.drawLine();
};
COMMANDS.SKIPDISP = (st, fn, vm) => {
  const e = compile(exprs(st)[0], fn, vm);
  return (fr) => {
    vm.system.skipDisp = !V.isZero(asInt(e(fr)));
  };
};
COMMANDS.CLEARLINE = (st, fn, vm) => {
  const e = exprs(st)[0] ? compile(exprs(st)[0], fn, vm) : null;
  return (fr) => vm.host.clearLines(e ? toNum(e(fr)) : 1);
};
// -------------------------------------------------------------- assignment --
type BinFn = (a: Value, b: Value) => Value;
const COMPOUND: Record<string, BinFn> = {
  '+=': (a, b) => (typeof a === 'string' ? a + asStr(b) : V.add(a, asInt(b))),
  '-=': (a, b) => V.sub(asInt(a), asInt(b)),
  '*=': (a, b) => (typeof a === 'string' ? a.repeat(Math.max(0, Number(b))) : V.mul(a, asInt(b))),
  '/=': (a, b) => V.div(asInt(a), asInt(b)),
  '%=': (a, b) => V.mod(asInt(a), asInt(b)),
  '|=': (a, b) => V.bitOr(asInt(a), asInt(b)),
  '&=': (a, b) => V.bitAnd(asInt(a), asInt(b)),
  '^=': (a, b) => V.bitXor(asInt(a), asInt(b)),
  '<<=': (a, b) => V.shl(asInt(a), asInt(b)),
  '>>=': (a, b) => V.shr(asInt(a), asInt(b)),
};

COMMANDS.SET = (st, fn, vm) => {
  const a = st.arg;
  if (a.a !== 'set') throw new EmueraError('bad assignment');
  if (a.target.k !== 'var') throw new EmueraError('assignment target is not a variable');
  const ref = resolveRef(a.target, fn, vm);
  const op = a.op;
  if (op === '++' || op === '--') {
    const d = op === '++' ? 1 : -1;
    return (fr) => ref.set(fr, V.add(asInt(ref.get(fr)), d));
  }
  if (a.form) {
    const f = compileForm(a.rhs as FormPart[], fn, vm);
    return (fr) => ref.set(fr, f(fr));
  }
  const rhs = (a.rhs as Expr[]).map((e) => compile(e, fn, vm));
  if (op === '=' || op === "'=") {
    if (rhs.length === 1) {
      const r = rhs[0];
      return (fr) => ref.set(fr, r(fr));
    }
    // SET_Instruction: every term is evaluated first, then the array is written (and its subscripts read). A term that calls a function writing to the same array
    // (ShinEraTenseiP: `RESULT_F = GET_CHARA_SKILLCOUNT(..), GET_CHARA_SKILLCOUNT(..)`, the second call runs `VARSET RESULT_F`) must not undo the values already computed.
    return (fr) => {
      const vals = rhs.map((f) => f(fr));
      const { arr, off } = ref.locate(fr);
      vals.forEach((v, i) => {
        if (off + i >= arr.length) throw new EmueraError(`${ref.meta.name}: index ${off + i} is out of range`);
        if (ref.meta.isStr !== (typeof v === 'string'))
          throw new EmueraError(`${ref.meta.name}: type mismatch in batch assignment`);
        arr[off + i] = v;
      });
    };
  }
  const f = COMPOUND[op];
  if (!f) throw new EmueraError(`unsupported assignment operator ${op}`);
  const r = rhs[0];
  return (fr) => ref.set(fr, f(ref.get(fr), r(fr)));
};

COMMANDS.VARSET = (st, fn, vm) => {
  const l = exprs(st);
  const target = l[0] as Expr & { k: 'var' };
  const ref = resolveRef(target, fn, vm);
  // an omitted or empty argument (`VARSET A,` / `VARSET A, , 2`) is "not given": the value defaults to 0 or "" by the variable's type (SP_VAR_SET_ArgumentBuilder)
  const given = (e?: Expr) => (e && !(e.k === 'var' && e.name === '__EMPTY__') ? compile(e, fn, vm) : null);
  const val = given(l[1]);
  const from = given(l[2]);
  const to = given(l[3]);
  const name = ref.meta.name;
  const oor = (which: number, v: number) =>
    new EmueraError(`The ${which} argument of "VARSET" instruction (${v}) is out of the range of the "${name}" array`);
  // VariableEvaluator.SetValueAll / VARSET_Instruction: 1-D arrays fill [start,end) (end defaults to the length; start>end swaps when a start is given;
  // anything but the whole array is range-checked 0..length). 2-D/3-D arrays are always filled completely. CALC variables ignore the assignment.
  return (fr) => {
    if (ref.meta.calc) return;
    const { arr } = ref.locate(fr);
    const v = val ? val(fr) : ref.meta.isStr ? '' : 0;
    if (ref.meta.rank > 1) {
      arr.fill(v as never);
      return;
    }
    const len = ref.meta.rank === 1 ? (ref.dimsOf(fr)[0] ?? arr.length) : 1;
    let end = to ? toNum(to(fr)) : ref.meta.rank === 1 ? len : 0;
    let start = 0;
    if (from) {
      start = toNum(from(fr));
      if (start > end) [start, end] = [end, start];
    }
    if (ref.meta.rank === 1 && (start !== 0 || end !== len)) {
      if (start < 0 || start > len) throw oor(3, start);
      if (end < 0 || end > len) throw oor(4, end);
    }
    for (let i = start; i < end; i++) arr[i] = v as never;
  };
};

// ------------------------------------------------------------- control flow --
function condOf(s: Stmt, fn: FuncDef, vm: VM): Fn {
  if (s.arg.a !== 'exprs' || !s.arg.list[0]) throw new EmueraError(`${s.cmd} needs a condition`);
  return compile(s.arg.list[0], fn, vm);
}
const truthy = (v: Value) => !V.isZero(asInt(v));

function branch(fr: Frame, t: number, fn: FuncDef, vm: VM) {
  const body = fn.body;
  for (;;) {
    const s = body[t];
    if (s.cmd === 'ELSEIF') {
      if (truthy(condOf(s, fn, vm)(fr))) {
        fr.pc = t + 1;
        return;
      }
      t = s.alt!;
    } else {
      fr.pc = t + 1;
      return;
    } // ELSE or ENDIF
  }
}
COMMANDS.IF = (st, fn, vm) => {
  const c = condOf(st, fn, vm);
  return (fr) => {
    if (!truthy(c(fr))) branch(fr, st.alt!, fn, vm);
  };
};
COMMANDS.ELSEIF = (st) => (fr) => {
  fr.pc = st.jump!;
};
COMMANDS.ELSE = COMMANDS.ELSEIF;
COMMANDS.ENDIF = () => () => {};
COMMANDS.SIF = (st, fn, vm) => {
  const c = condOf(st, fn, vm);
  return (fr) => {
    if (!truthy(c(fr))) fr.pc++;
  };
};

const CMP_OPS = new Set(['==', '!=', '<', '>', '<=', '>=']);
COMMANDS.SELECTCASE = (st, fn, vm) => {
  const v = condOf(st, fn, vm);
  return (fr) => {
    const val = v(fr);
    let t = st.alt!;
    const body = fn.body;
    for (;;) {
      const s = body[t];
      if (s.cmd === 'CASE' && s.arg.a === 'case') {
        for (const c of s.arg.conds) {
          let ok = false;
          if (c.c === 'eq') ok = compile(c.e, fn, vm)(fr) === val;
          else if (c.c === 'range') {
            const lo = compile(c.lo, fn, vm)(fr),
              hi = compile(c.hi, fn, vm)(fr);
            ok =
              typeof val === 'string'
                ? val >= (lo as string) && val <= (hi as string)
                : V.cmp(val, lo as Int) >= 0 && V.cmp(val, hi as Int) <= 0;
          } else {
            const o = compile(c.e, fn, vm)(fr);
            if (!CMP_OPS.has(c.op)) {
              // any other binary operator: evaluate `val <op> operand`, true when non-zero
              const lit: Expr = typeof val === 'string' ? { k: 'str', v: val } : { k: 'int', v: val };
              const r = compile({ k: 'bin', op: c.op, l: lit, r: c.e }, fn, vm)(fr);
              if (typeof r === 'string' ? r !== '' : !V.isZero(r as Int)) {
                fr.pc = t + 1;
                return;
              }
              continue;
            }
            const k =
              typeof val === 'string' ? (val < (o as string) ? -1 : val > (o as string) ? 1 : 0) : V.cmp(val, o as Int);
            ok =
              c.op === '=='
                ? k === 0
                : c.op === '!='
                  ? k !== 0
                  : c.op === '<'
                    ? k < 0
                    : c.op === '>'
                      ? k > 0
                      : c.op === '<='
                        ? k <= 0
                        : k >= 0;
          }
          if (ok) {
            fr.pc = t + 1;
            return;
          }
        }
        t = s.alt!;
      } else {
        fr.pc = t + 1;
        return;
      } // CASEELSE or ENDSELECT
    }
  };
};
COMMANDS.CASE = (st) => (fr) => {
  fr.pc = st.jump!;
};
COMMANDS.CASEELSE = COMMANDS.CASE;
COMMANDS.ENDSELECT = () => () => {};

COMMANDS.REPEAT = (st, fn, vm) => {
  const n = compile(exprs(st)[0], fn, vm);
  const count = () => vm.global('COUNT');
  return (fr) => {
    const end = asInt(n(fr));
    const pcHead = fr.pc - 1;
    count()[0] = 0;
    if (V.cmp(0, end) >= 0) {
      fr.pc = st.jump! + 1;
      return;
    }
    fr.loops.set(pcHead, { end, step: 1 });
  };
};
COMMANDS.REND = (st, _fn, vm) => (fr) => {
  const head = st.jump!;
  const L = fr.loops.get(head)!;
  const c = vm.global('COUNT');
  c[0] = V.add(c[0] as Int, 1);
  if (V.cmp(c[0] as Int, L.end) < 0) fr.pc = head + 1;
};
COMMANDS.FOR = (st, fn, vm) => {
  const l = exprs(st);
  const ref = resolveRef(l[0] as Expr & { k: 'var' }, fn, vm);
  const a = compile(l[1], fn, vm),
    b = compile(l[2], fn, vm),
    c = l[3] && !(l[3].k === 'var' && l[3].name === '__EMPTY__') ? compile(l[3], fn, vm) : null; // an empty step means 1
  return (fr) => {
    const start = asInt(a(fr)),
      end = asInt(b(fr)),
      step = c ? asInt(c(fr)) : 1;
    ref.set(fr, start);
    const done = V.cmp(step, 0) >= 0 ? V.cmp(start, end) >= 0 : V.cmp(start, end) <= 0;
    if (done) {
      fr.pc = st.jump! + 1;
      return;
    }
    fr.loops.set(fr.pc - 1, { end, step });
  };
};
COMMANDS.NEXT = (st, fn, vm) => {
  const headSt = () => fn.body[st.jump!];
  let ref: ReturnType<typeof resolveRef> | null = null;
  return (fr) => {
    const head = st.jump!;
    if (!ref) ref = resolveRef(exprs(headSt())[0] as Expr & { k: 'var' }, fn, vm);
    const L = fr.loops.get(head)!;
    const v = V.add(asInt(ref.get(fr)), L.step);
    ref.set(fr, v);
    const more = V.cmp(L.step, 0) >= 0 ? V.cmp(v, L.end) < 0 : V.cmp(v, L.end) > 0;
    if (more) fr.pc = head + 1;
  };
};
COMMANDS.WHILE = (st, fn, vm) => {
  const c = condOf(st, fn, vm);
  return (fr) => {
    if (!truthy(c(fr))) fr.pc = st.jump! + 1;
  };
};
COMMANDS.WEND = (st) => (fr) => {
  fr.pc = st.jump!;
};
COMMANDS.DO = () => () => {};
COMMANDS.LOOP = (st, fn, vm) => {
  const c = condOf(st, fn, vm);
  return (fr) => {
    if (truthy(c(fr))) fr.pc = st.jump! + 1;
  };
};
const loopHead = (st: Stmt, fn: FuncDef) => {
  const h = st.jump === undefined ? undefined : fn.body[st.jump];
  if (!h || !(h.cmd === 'REPEAT' || h.cmd === 'FOR' || h.cmd === 'WHILE' || h.cmd === 'DO'))
    throw new EmueraError(`${st.cmd} outside a loop`); // the linker's note says where; the original stops here too
  return h;
};
COMMANDS.BREAK = (st, fn, vm) => {
  // eramaker quirk: BREAK still advances the REPEAT/FOR counter
  const head = () => loopHead(st, fn);
  let ref: ReturnType<typeof resolveRef> | null = null;
  return (fr) => {
    const h = head();
    if (h.cmd === 'REPEAT') {
      const c = vm.global('COUNT');
      c[0] = V.add(c[0] as Int, 1);
    } else if (h.cmd === 'FOR') {
      if (!ref) ref = resolveRef(exprs(h)[0] as Expr & { k: 'var' }, fn, vm);
      const L = fr.loops.get(st.jump!);
      if (L) ref.set(fr, V.add(asInt(ref.get(fr)), L.step));
    }
    fr.pc = h.jump! + 1;
  };
};
COMMANDS.CONTINUE = (st, fn) => (fr) => {
  fr.pc = fn.body[st.jump!].jump!;
};
COMMANDS.$ = () => () => {};
COMMANDS.NOSKIP = () => () => {};
COMMANDS.ENDNOSKIP = () => () => {};

// ------------------------------------------------------------------- calls --
function nameOf(st: Stmt, fn: FuncDef, vm: VM): (fr: Frame) => string {
  const a = st.arg;
  if (a.a !== 'call') throw new EmueraError(`${st.cmd}: bad arguments`);
  if (typeof a.name === 'string') {
    const n = a.name;
    return () => n;
  }
  const f = compileForm(a.name, fn, vm);
  return (fr) => f(fr).trim();
}
function argsOf(st: Stmt, fn: FuncDef, vm: VM): ((fr: Frame) => Value)[] {
  return st.arg.a === 'call'
    ? st.arg.args.map((e) =>
        e.k === 'var' && e.name === '__EMPTY__' ? () => undefined as unknown as Value : compileArg(e, fn, vm, true),
      )
    : [];
}

function callLike(mode: 'call' | 'jump' | 'goto', optional: boolean, withCatch = false): Factory {
  return (st, fn, vm) => {
    const nm = nameOf(st, fn, vm);
    const args = argsOf(st, fn, vm);
    return (fr): void | Gen => {
      const name = nm(fr);
      if (mode === 'goto') {
        const idx = fn.labels.get(key(name));
        if (idx === undefined) {
          if (optional) {
            if (withCatch) fr.pc = st.alt! + 1;
            return;
          } // a missing TRY target leaves RESULT alone (CALL_Instruction / GOTO_Instruction)
          throw new EmueraError(`label $${name} not found`);
        }
        fr.pc = idx + 1;
        if (withCatch) fr.pc = idx + 1;
        return;
      }
      const f = vm.findFunc(name);
      if (!f) {
        if (optional) {
          if (withCatch) fr.pc = st.alt! + 1; // run the CATCH block
          return;
        }
        throw new EmueraError(`function @${name} not found`);
      }
      const vals = args.map((a) => a(fr));
      if (mode === 'jump') throw new JumpSignal(f, vals);
      // (the call is handed to exec directly: a wrapper generator that only delegated to it added nothing)
      // TRYC*: after a successful call the code up to CATCH runs, then CATCH..ENDCATCH is skipped
      return (f.event ? vm.callEvent(f.name) : vm.callFunction(f, vals)) as unknown as Gen; // the callee's own return value is not used by the caller
    };
  };
}
const regCall = (name: string, mode: 'call' | 'jump' | 'goto', optional: boolean, c = false) => {
  COMMANDS[name] = callLike(mode, optional, c);
};
regCall('CALL', 'call', false);
regCall('CALLFORM', 'call', false);
regCall('TRYCALL', 'call', true);
regCall('TRYCALLFORM', 'call', true);
regCall('JUMP', 'jump', false);
regCall('JUMPFORM', 'jump', false);
regCall('TRYJUMP', 'jump', true);
regCall('TRYJUMPFORM', 'jump', true);
regCall('GOTO', 'goto', false);
regCall('GOTOFORM', 'goto', false);
regCall('TRYGOTO', 'goto', true);
regCall('TRYGOTOFORM', 'goto', true);
regCall('TRYCCALL', 'call', true, true);
regCall('TRYCCALLFORM', 'call', true, true);
regCall('TRYCJUMP', 'jump', true, true);
regCall('TRYCJUMPFORM', 'jump', true, true);
regCall('TRYCGOTO', 'goto', true, true);
regCall('TRYCGOTOFORM', 'goto', true, true);
COMMANDS.CATCH = (st) => (fr) => {
  fr.pc = st.jump!;
};
COMMANDS.ENDCATCH = () => () => {};

COMMANDS.CALLF = (st, fn, vm) => {
  const nm = nameOf(st, fn, vm);
  const args = argsOf(st, fn, vm);
  return (fr) => {
    const f = vm.findFunc(nm(fr));
    if (!f) throw new EmueraError(`function @${nm(fr)} not found`);
    vm.callMethod(
      f,
      args.map((a) => a(fr)),
    );
  };
};
COMMANDS.CALLFORMF = COMMANDS.CALLF;

// a statement whose arguments the original rejects at load time: an error line, thrown when executed
COMMANDS.__ERRLINE = (st) => {
  const msg = (st.arg as { text: string }).text;
  return () => {
    throw new EmueraError(msg);
  };
};
COMMANDS.RETURN = (st, fn, vm) => {
  const l = exprs(st).map((e) => compile(e, fn, vm));
  return (fr) => {
    if (l.length === 0) vm.setResult(0);
    // every expression is evaluated exactly once, in order (a call inside it may itself RETURN and rewrite RESULT)
    const vals = l.map((f) => f(fr));
    vals.forEach((v, i) => vm.setResult(v, i));
    if (fn.method && vals.length) fr.retval = vm.global(typeof vals[0] === 'string' ? 'RESULTS' : 'RESULT')[0];
    fr.returned = true;
    fr.pc = fn.body.length;
  };
};
COMMANDS.RETURNF = (st, fn, vm) => {
  const l = exprs(st).map((e) => compile(e, fn, vm));
  return (fr) => {
    fr.retval = l.length ? l[0](fr) : fn.method === 'str' ? '' : 0;
    fr.returned = true;
    fr.pc = fn.body.length;
  };
};
COMMANDS.RETURNFORM = (st, fn, vm) => {
  const e0 = exprs(st)[0];
  const f: (fr: Frame) => string =
    st.arg.a === 'form'
      ? compileForm(st.arg.parts, fn, vm)
      : e0
        ? (
            (c) => (fr: Frame) =>
              String(c(fr))
          )(compile(e0, fn, vm))
        : () => '0';
  return (fr) => {
    const v = f(fr);
    vm.setResult(V.parseIntLoose(v));
    fr.returned = true;
    fr.pc = fn.body.length;
  };
};

COMMANDS.QUIT = () => () => {
  throw new QuitSignal();
};

// ------------------------------------------------------------------- input --
function inputFactory(kind: 'int' | 'str' | 'oneint' | 'onestr'): Factory {
  return (st, fn, vm) => {
    const def = exprs(st)[0] ? compile(exprs(st)[0], fn, vm) : null;
    return (fr): Gen =>
      (function* (): Gen {
        const dflt = def ? toText(def(fr)) : undefined;
        for (;;) {
          const r = yield { t: 'input', kind, def: dflt };
          if (r === null) throw new StarvedError();
          let text = r.trim();
          if (text === '' && dflt !== undefined) text = dflt;
          if (kind === 'str' || kind === 'onestr') {
            // EmueraConsole.doInputToEmueraProgram: an empty answer takes the default; the answer is echoed as a line
            let v = r.trim() === '' && dflt !== undefined ? dflt : r;
            if (kind === 'onestr') v = v.slice(0, 1);
            vm.echoInput(v);
            vm.setResult(v, 0);
            return;
          }
          if (text === '') continue;
          if (!/^[+-]?\d+$/.test(text)) continue;
          const shown = kind === 'oneint' ? text.slice(0, 1) : text;
          if (kind === 'oneint' && !/^[+-]?\d+$/.test(shown)) continue;
          vm.echoInput(shown);
          const v = V.parseIntLoose(shown);
          vm.setResult(v, 0);
          return;
        }
      })();
  };
}
COMMANDS.INPUT = inputFactory('int');
COMMANDS.INPUTS = inputFactory('str');
COMMANDS.ONEINPUT = inputFactory('oneint');
COMMANDS.ONEINPUTS = inputFactory('onestr');
COMMANDS.TINPUT = (st, fn, vm) => {
  const l = exprs(st).map((e) => compile(e, fn, vm));
  return (fr): Gen =>
    (function* (): Gen {
      const r = yield { t: 'input', kind: 'int', timeoutMs: toNum(l[0](fr)), def: l[1] ? toText(l[1](fr)) : undefined };
      if (r === null) throw new StarvedError();
      const text = r.trim();
      vm.setResult(/^[+-]?\d+$/.test(text) ? V.parseIntLoose(text) : l[1] ? asInt(l[1](fr)) : 0, 0);
    })();
};
// WAIT, FORCEWAIT, WAITANYKEY and TWAIT carry IS_PRINT: ProcessScriptProc skips them while SKIPDISP is on (erablue's COM scripts run with SKIPDISP 1 for their executability check and end with WAIT)
COMMANDS.WAIT =
  (_s, _f, vm) =>
  (_fr): Gen =>
    (function* (): Gen {
      if (vm.system.skipDisp) return;
      const r = yield { t: 'input', kind: 'wait' };
      if (r === null) throw new StarvedError();
    })();
COMMANDS.FORCEWAIT = COMMANDS.WAIT;
COMMANDS.WAITANYKEY = COMMANDS.WAIT;
// ------------------------------------------------------------- misc no-ops --
for (const n of ['RANDOMIZE', 'DUMPRAND', 'INITRAND', 'ASSERT', 'DEBUGCLEAR', 'MOUSESKIP', 'SETANIMETIMER']) {
  COMMANDS[n] = () => () => {};
}
// DEBUGPRINT[FORM][L]: nothing on the game screen (the original prints to its debug console); the text is kept for the playtest log (VM.debugLines)
for (const n of ['DEBUGPRINT', 'DEBUGPRINTL', 'DEBUGPRINTFORM', 'DEBUGPRINTFORML']) {
  COMMANDS[n] = (st, fn, vm) => {
    const f =
      st.arg.a === 'form'
        ? compileForm(st.arg.parts, fn, vm)
        : st.arg.a === 'raw'
          ? (): string => (st.arg as { text: string }).text
          : null;
    return f
      ? (fr) => {
          let t = '';
          try {
            t = String(f(fr));
          } catch {
            /* a bad debug line never stops the game */
          }
          vm.debugPrint(t);
        }
      : () => {};
  };
}
// AWAIT [ms]: the console redraws and sleeps (EmueraConsole.Await: RefreshStrings, DoEvents, Thread.Sleep). The host gets a frame; a host that ignores frames just skips the pause.
COMMANDS.AWAIT = (st, fn, vm) => {
  const l = exprs(st).map((e) => compile(e, fn, vm));
  return (fr): Gen =>
    (function* (): Gen {
      const ms = l[0] ? toNum(l[0](fr)) : -1;
      if (ms < 0 && l[0]) throw new EmueraError(`AWAIT: a negative value (${ms}) was given`);
      if (ms > 10000) throw new EmueraError(`AWAIT: a wait of ${ms} ms (over 10 seconds) was given`);
      yield { t: 'delay', ms: Math.max(ms, 0), marker: 'await' } as any;
    })();
};
void sjisWidth;

// CALLEVENT name: runs all event functions of that name (CalledFunction.CallEventFunction); a missing one is a no-op
COMMANDS.CALLEVENT = (st, _fn, vm) => {
  const name = st.arg.a === 'raw' ? st.arg.text.trim() : '';
  return (): Gen =>
    (function* (): Gen {
      yield* vm.callEvent(name);
    })();
};
