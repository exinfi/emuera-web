/** Commands about the program itself rather than the game: quit/restart, THROW, time, log skipping, RESTART/RESETGLOBAL, and the commands the web build deliberately does not implement. */
import { compile, compileForm } from './eval';
import { COMMANDS } from './commands';
import { nowNumber, nowText } from './funcs';
import * as V from './value';
import { EmueraError } from './value';
import { QuitSignal } from './vm';

COMMANDS.SKIPLOG = (st, fn, vm) => {
  const e = st.arg.a === 'exprs' && st.arg.list[0] ? compile(st.arg.list[0], fn, vm) : null;
  return (fr) => {
    vm.mesSkip = e ? !V.isZero(e(fr) as any) : false;
  };
};
// forceUpdateGeneration: button generations are a display detail of the original; nothing to do for the web renderer
COMMANDS.BREAKBUTTON = () => () => {};
COMMANDS.QUIT_AND_RESTART = (_st, _fn, vm) => () => {
  vm.restart = true;
  throw new QuitSignal();
};
COMMANDS.FORCE_QUIT = () => () => {
  throw new QuitSignal();
};
COMMANDS.FORCE_QUIT_AND_RESTART = (_st, _fn, vm) => () => {
  vm.restart = true;
  throw new QuitSignal();
};
// the web build never contacts an update server: RESULT 4 = update check forbidden
COMMANDS.UPDATECHECK = (_st, _fn, vm) => () => {
  vm.setResult(4, 0);
};

// THROW <form string>: always stops with that message (Process.ScriptProc: throw new CodeEE(text)). ASSERT is DEBUG_FUNC in the original (skipped outside debug mode), so it stays a no-op.
COMMANDS.THROW = (st, fn, vm) => {
  const f = st.arg.a === 'form' ? compileForm(st.arg.parts, fn, vm) : () => '';
  return (fr) => {
    throw new EmueraError(f(fr));
  };
};
// GETTIME as a statement sets RESULT (yyyyMMddHHmmssfff) and RESULTS (yyyy/MM/dd HH:mm:ss); the function form only returns the number
COMMANDS.GETTIME = (_st, _fn, vm) => () => {
  const d = new Date();
  vm.setResult(nowNumber(d), 0);
  vm.setResult(nowText(d), 0);
};

// ---- restart and global reset
COMMANDS.RESTART = () => (fr) => {
  fr.pc = 0;
};
// RESETDATA lives in system.ts (vm.resetData)
COMMANDS.RESETGLOBAL = (_s, _f, vm) => () => {
  for (const k of ['GLOBAL', 'GLOBALS']) vm.store.global.delete(k);
  for (const [k, d] of vm.prog.globals) if (d.isGlobal) vm.store.global.delete(k);
  vm.clearExt('global');
  vm.clearExt('static'); // ResetGlobalData: RemoveEMGlobalData + RemoveEMStaticData
};

// the original throws NotImplCodeEE for these
for (const n of ['REF', 'REFBYNAME', 'SAVEVAR', 'LOADVAR'])
  COMMANDS[n] = () => () => {
    throw new EmueraError(`${n} is not implemented (Emuera: NotImplCodeEE)`);
  };
// CALLSHARP calls a method of a C# plugin DLL, which the web build cannot load (erablue_resort uses it for LAUNCH_BROWSER on its title screen).
// The game is not stopped: the call is recorded as unimplemented (it shows with the other "unimplemented" lines of the page and the error report) and carry on.
COMMANDS.CALLSHARP = (st, _fn, vm) => {
  // the argument parses as `METHOD(args)`; show the method and its literal arguments (anything else as ?)
  const c: any = st.arg.a === 'exprs' ? st.arg.list[0] : undefined;
  const lit = (e: any) => (e?.k === 'str' ? JSON.stringify(e.v) : e?.k === 'num' || e?.k === 'int' ? String(e.v) : '?');
  const what = c?.k === 'call' ? `${c.name}(${(c.args ?? []).map(lit).join(', ')})`.slice(0, 160) : '';
  const msg = `CALLSHARP ${what} (plugin methods are not available in the web build)`;
  return () => {
    vm.note(msg);
  };
};
