// TRYCALLLIST / TRYJUMPLIST / TRYGOTOLIST ... FUNC x ... ENDFUNC, and TRYCALLF / TRYCALLFORMF
import type { FuncDef, Stmt } from '../compiler/types';
import { key } from '../util/key';
import { compileForm, compileArg, Frame } from './eval';
import { COMMANDS, Factory } from './commands';
import { EmueraError, Value } from './value';
import { JumpSignal, Gen, VM } from './vm';

function entries(st: Stmt, fn: FuncDef, vm: VM, goto: boolean) {
  const open = fn.body.indexOf(st);
  const out: { name: (fr: Frame) => string; args: ((fr: Frame) => Value)[] }[] = [];
  for (let i = open + 1; i < (st.jump ?? open); i++) {
    const s = fn.body[i];
    if (s.cmd !== 'FUNC') continue;
    const a = s.arg;
    if (a.a !== 'call') throw new EmueraError('FUNC: bad arguments');
    if (goto && (a.args.length || (a.sub && a.sub.length)))
      throw new EmueraError('TRYGOTOLIST: FUNC takes only a label name');
    let nm: (fr: Frame) => string;
    if (typeof a.name === 'string') {
      const n = a.name;
      nm = () => n;
    } else {
      const f = compileForm(a.name, fn, vm);
      nm = (fr) => f(fr).trim();
    }
    out.push({ name: nm, args: a.args.map((e) => compileArg(e, fn, vm)) });
  }
  return out;
}

const list =
  (mode: 'call' | 'jump' | 'goto'): Factory =>
  (st, fn, vm) => {
    const ents = entries(st, fn, vm, mode === 'goto');
    return (fr): void | Gen => {
      for (const e of ents) {
        const name = e.name(fr);
        if (mode === 'goto') {
          const idx = fn.labels.get(key(name));
          if (idx !== undefined) {
            fr.pc = idx + 1;
            return;
          }
          continue;
        }
        const f = vm.findFunc(name);
        if (!f) continue;
        const vals = e.args.map((a) => a(fr));
        if (mode === 'jump') throw new JumpSignal(f, vals);
        fr.pc = st.jump! + 1;
        return (function* (): Gen {
          if (f.event) yield* vm.callEvent(f.name);
          else yield* vm.callFunction(f, vals);
        })();
      }
      fr.pc = st.jump! + 1; // nothing found: skip to after ENDFUNC
    };
  };
COMMANDS.TRYCALLLIST = list('call');
COMMANDS.TRYJUMPLIST = list('jump');
COMMANDS.TRYGOTOLIST = list('goto');
COMMANDS.FUNC = () => () => {};
COMMANDS.ENDFUNC = () => () => {};

const tryF =
  (form: boolean): Factory =>
  (st, fn, vm) => {
    const a = st.arg;
    if (a.a !== 'call') throw new EmueraError(`${st.cmd}: bad arguments`);
    const nm =
      typeof a.name === 'string'
        ? (
            (n: string) => () =>
              n
          )(a.name)
        : (
            (f) => (fr: any) =>
              f(fr).trim()
          )(compileForm(a.name, fn, vm));
    const args = a.args.map((e) => compileArg(e, fn, vm, true));
    void form;
    return (fr) => {
      const f = vm.findFunc(nm(fr));
      // PATCH (erablue_resort image folders): a missing function leaves RESULT exactly as it was. EM+EE's TRYCALLF_Instruction.DoInstruction
      // is `if (mToken == null) return;` and never writes RESULT. This used to store 0, so a script that sets `RESULT = 1` and then does
      // `TRYCALLFORMF <optional per-character hook>(...)` (erablue's @GET_ALL_RESOURCES_FOLDERS, where only one character has a hook)
      // saw "hook rejected it" for every character without one: no image folder was ever accepted, and @FIX_RESOURCES_FOLDER fell back
      // to the English CALLNAME folder (10Fediel) even when the Japanese pack folder (10フェディエル) was loaded.
      if (!f) return;
      const v = vm.callMethod(
        f,
        args.map((x) => x(fr)),
      );
      vm.setResult(v);
    };
  };
COMMANDS.TRYCALLF = tryF(false);
COMMANDS.TRYCALLFORMF = tryF(true);
