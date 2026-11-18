/** Functions backed by the game's CSV tables: palam/exp level lookup, ERD names, character-template lookup by name. */
import { asInt, compile, toNum } from './eval';
import { def, defRaw } from './funcs';
import * as V from './value';
import { EmueraError, Value } from './value';
import type { VM } from './vm';

const lvFn = (varName: string) => (vm: VM, a: Value[]) => {
  const v = asInt(a[0]),
    max = toNum(a[1]);
  const arr = vm.global(varName);
  // VariableEvaluator.getPalamLv/getExpLv (EM+EE, and PuchiEmuera's 1.82 base): scan UP from level 0 and return the first i with value < table[i+1]; maxlv when none is.
  // The table only has 10 default entries, the rest are 0: scanning down for 'value >= table[lv]' matched those zero tail entries and gave every value (0 included) the maximum level
  // (eraSumireTeru printed all its parameters as MAXED, GETPALAMLV PALAM, 17 returned 17 for 0). A table that is strictly rising gives the same answer both ways.
  for (let i = 0; i < max; i++) {
    if (i + 1 >= arr.length) return i;
    if (V.cmp(v, arr[i + 1] as V.Int) < 0) return i;
  }
  return max;
};
def('GETPALAMLV', lvFn('PALAMLV'));
def('GETEXPLV', lvFn('EXPLV'));

defRaw('ERDNAME', (vm, args, fn) => {
  const e = args[0];
  if (e.k !== 'var') throw new EmueraError('ERDNAME: variable expected');
  const idx = compile(args[1], fn, vm),
    dim = args[2] ? compile(args[2], fn, vm) : null;
  return (fr) => {
    const t = vm.tables.userTable(e.name, dim ? toNum(dim(fr)) - 1 : 0);
    return t?.names[toNum(idx(fr))] ?? '';
  };
});

// GETCSVNOBYNAME / CALLNAME / NICKNAME / MASTERNAME(str): the character template number whose name is str, -1 if none (GetCsvNoMethod; a later template with the same name wins)
for (const [fnName, field] of [
  ['GETCSVNOBYNAME', 'name'],
  ['GETCSVNOBYCALLNAME', 'callname'],
  ['GETCSVNOBYNICKNAME', 'nickname'],
  ['GETCSVNOBYMASTERNAME', 'mastername'],
] as const) {
  const maps = new WeakMap<object, Map<string, number>>();
  def(fnName, (vm, a) => {
    const t = vm.templates as unknown as
      | { list: { no: number; name?: string; callname?: string; nickname?: string; mastername?: string }[] }
      | undefined;
    if (!t) return -1;
    let m = maps.get(t);
    if (!m) {
      m = new Map();
      for (const c of t.list) {
        const k = c[field];
        if (k !== undefined && k !== null) m.set(k, c.no);
      }
      maps.set(t, m);
    }
    return m.get(String(a[0])) ?? -1;
  });
}
