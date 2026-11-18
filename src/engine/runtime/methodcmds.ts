/** Statement forms of expression functions (`STRLENS x`, `SUBSTRING s,a,b`, ...) and the STRLEN* statements. */
import { compile, compileForm } from './eval';
import { COMMANDS, Factory } from './commands';
import { FUNCS } from './funcs';

/** Statement form of an expression function (STRLENS x, SUBSTRING s,a,b ...): result goes to RESULT/RESULTS. */
export function methodStatement(name: string): Factory | undefined {
  const b = FUNCS[name];
  if (!b) return undefined;
  if (b.raw) {
    return (st, fn, vm) => {
      const list = st.arg.a === 'exprs' ? [...st.arg.list] : [];
      while (
        list.length &&
        list[list.length - 1].k === 'var' &&
        (list[list.length - 1] as { name: string }).name === '__EMPTY__'
      )
        list.pop(); // a trailing comma adds no argument (ReduceArguments)
      const f = b.raw!(
        vm,
        list.map((a) => (a.k === 'var' && a.name === '__EMPTY__' ? (undefined as unknown as typeof a) : a)),
        fn,
      );
      return (fr) => {
        vm.setResult(f(fr));
      };
    };
  }
  return (st, fn, vm) => {
    const a = st.arg;
    const l = a.a === 'exprs' ? a.list.map((e) => compile(e, fn, vm)) : [];
    return (fr) => {
      vm.setResult(
        b.run(
          vm,
          l.map((f) => f(fr)),
          fr,
        ),
      );
    };
  };
}
// STRLEN* statements take raw / FORM text
const strLenCmd =
  (fnName: 'STRLENS' | 'STRLENSU'): Factory =>
  (st, fn, vm) => {
    const a = st.arg;
    const f =
      a.a === 'form'
        ? compileForm(a.parts, fn, vm)
        : a.a === 'raw'
          ? (
              (t: string) => () =>
                t
            )(a.text)
          : () => '';
    return (fr) => vm.setResult(FUNCS[fnName].run(vm, [f(fr)], fr));
  };
COMMANDS.STRLEN = strLenCmd('STRLENS');
COMMANDS.STRLENFORM = strLenCmd('STRLENS');
COMMANDS.STRLENU = strLenCmd('STRLENSU');
COMMANDS.STRLENFORMU = strLenCmd('STRLENSU');
