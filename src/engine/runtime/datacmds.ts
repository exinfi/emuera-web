/** PRINTDATA / STRDATA data blocks: DATA, DATAFORM, DATALIST items chosen at random. */
import { compile, compileForm, resolveRef } from './eval';
import { COMMANDS, Factory } from './commands';
import type { Gen } from './vm';
import { convertKana, printText, withPlain } from './printcmds';
import { exprs, varExpr } from './cmdargs';

function collectData(st: any, fn: any, vm: import('./vm').VM): ((fr: any) => string)[] {
  const out: ((fr: any) => string)[] = [];
  const body = fn.body;
  const end = st.jump!;
  for (let i = findStart(body, st) + 1; i < end; i++) {
    const s = body[i];
    if (s.cmd === 'DATA' || s.cmd === 'DATAFORM') {
      const a = s.arg;
      if (a.a === 'form') out.push(compileForm(a.parts, fn, vm));
      else if (a.a === 'raw') {
        const t = a.text;
        out.push(() => t);
      } else if (a.a === 'exprs' && a.list[0]) {
        const f = compile(a.list[0], fn, vm);
        out.push((fr) => String(f(fr)));
      } else out.push(() => '');
    } else if (s.cmd === 'DATALIST') {
      const parts: ((fr: any) => string)[] = [];
      let j = i + 1;
      for (; j < end && body[j].cmd !== 'ENDLIST'; j++) {
        const a = body[j].arg;
        if (a.a === 'form') parts.push(compileForm(a.parts, fn, vm));
        else if (a.a === 'raw') {
          const t = a.text;
          parts.push(() => t);
        }
      }
      out.push((fr) => parts.map((p) => p(fr)).join('\n'));
      i = j;
    }
  }
  return out;
}
const findStart = (body: any[], st: any) => body.indexOf(st);

const printData =
  (name: string): Factory =>
  (st, fn, vm) => {
    const items = collectData(st, fn, vm);
    const l = exprs(st).map((e) => compile(e, fn, vm));
    const ref = st.arg.a === 'exprs' && st.arg.list[0]?.k === 'var' ? resolveRef(st.arg.list[0], fn, vm) : null;
    const m = /^PRINTDATA(K?)(D?)([LW]?)$/.exec(name)!;
    const kana = !!m[1],
      plain = !!m[2],
      newline = m[3] !== '',
      wait = m[3] === 'W';
    void l;
    return (fr): void | Gen => {
      fr.pc = st.jump! + 1;
      if (!items.length || vm.system.skipDisp) return; // PRINT_DATA_Instruction: nothing is drawn (and RESULT var untouched) while display is skipped
      const n = vm.randInt(items.length);
      ref?.set(fr, Number(n));
      let text = items[Number(n)](fr);
      if (kana) text = convertKana(vm, text); // PRINTDATAK: ConvertStringType
      return (function* (): Gen {
        withPlain(vm, plain, () => printText(vm, text)); // PRINTDATAD: user SETCOLOR ignored
        if (newline) vm.host.newline();
        if (wait) {
          const r = yield { t: 'input', kind: 'wait' };
          void r;
        }
      })();
    };
  };
for (const n of [
  'PRINTDATA',
  'PRINTDATAL',
  'PRINTDATAW',
  'PRINTDATAK',
  'PRINTDATAKL',
  'PRINTDATAKW',
  'PRINTDATAD',
  'PRINTDATADL',
  'PRINTDATADW',
])
  COMMANDS[n] = printData(n);
COMMANDS.STRDATA = (st, fn, vm) => {
  const items = collectData(st, fn, vm);
  const ref = resolveRef(varExpr(exprs(st)[0], 'STRDATA'), fn, vm);
  return (fr) => {
    fr.pc = st.jump! + 1;
    if (!items.length) return;
    ref.set(fr, items[Number(vm.randInt(items.length))](fr));
  };
};
for (const n of ['DATA', 'DATAFORM', 'DATALIST', 'ENDLIST', 'ENDDATA']) COMMANDS[n] = () => () => {};
