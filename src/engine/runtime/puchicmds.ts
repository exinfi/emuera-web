// Instructions of PuchiEmuera (profile 'puchi' only, eraSumireTeru): the parser knows them only under that profile (profile.ts PUCHI_ONLY_INSTRUCTIONS). The state lives in `vm.fixed` (fixedimg.ts), which
// exists only for that profile; the host animates, these instructions set the target and, like the original (it redraws in a loop), hold the script for the effect's duration.
import type { Expr } from '../compiler/ast';
import { COMMANDS } from './commands';
import { compile } from './eval';
import type { Gen } from './vm';

const args = (st: any): Expr[] => (st.arg.a === 'exprs' ? st.arg.list : []);
/** the game passes numbers as strings too ("1.0", "0,1"): read anything leniently */
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
};

// FADE alpha, group, ms, color  (alpha 0 = faded out, 1 = shown; group -1 = whole screen; color 1 red, 2 black, 3 white, other = background)
COMMANDS.FADE = (st, fn, vm) => {
  const l = args(st).map((e) => compile(e, fn, vm));
  return (fr): Gen =>
    (function* (): Gen {
      const fx = vm.fixed;
      if (!fx) return;
      // FADE_Instruction: alpha and group are read as strings; the group may be a comma list ("0,1") for a group fade, a single -1 means the whole screen; a negative time sets the value at once
      const a = num(l[0]?.(fr)),
        gs = String(l[1]?.(fr) ?? '-1')
          .split(',')
          .map((x) => Math.trunc(num(x))),
        ms = Math.trunc(num(l[2]?.(fr))),
        col = Math.trunc(num(l[3]?.(fr)));
      const c = col === 1 || col === 2 || col === 3 ? col : 0;
      for (const g of gs) fx.doFade(a, g, ms, c);
      if (ms > 0 && !vm.system.skipDisp) yield { t: 'delay', ms, marker: 'await' } as any;
    })();
};
// SHAKE coef, amp, "g[,g...]", ms  (coef is unused by the original too)
COMMANDS.SHAKE = (st, fn, vm) => {
  const l = args(st).map((e) => compile(e, fn, vm));
  return (fr): Gen =>
    (function* (): Gen {
      const fx = vm.fixed;
      if (!fx) return;
      const amp = num(l[1]?.(fr)),
        groups = String(l[2]?.(fr) ?? '')
          .split(',')
          .map((x) => x.trim())
          .filter((x) => x !== '')
          .map((x) => Math.trunc(num(x))),
        ms = Math.trunc(num(l[3]?.(fr)));
      fx.doShake(groups, amp, ms);
      if (ms > 0 && !vm.system.skipDisp) yield { t: 'delay', ms, marker: 'await' } as any;
    })();
};
// HTML_PRINTSL: HTML_PRINT that does not end the line (PuchiEmuera: HTML_PRINT_Instruction(noLineBreaks: true); the game uses it to print coloured text pieces on one line)
COMMANDS.HTML_PRINTSL = (st, fn, vm) => {
  const l = args(st).map((e) => compile(e, fn, vm));
  return (fr) => {
    if (vm.system.skipDisp) return;
    vm.host.html(String(l[0]?.(fr) ?? ''), true);
  };
};
COMMANDS.FONTEDGE = (st, fn, vm) => {
  const e = compile(args(st)[0], fn, vm);
  return (fr) => {
    vm.fixed?.fontEdge(num(e(fr)) !== 0);
  };
};
COMMANDS.FONTEDGE_COLOR = (st, fn, vm) => {
  const l = args(st).map((e) => compile(e, fn, vm));
  return (fr) => {
    vm.fixed?.setEdgeColor(num(l[0]?.(fr)), num(l[1]?.(fr)), num(l[2]?.(fr)));
  };
};
COMMANDS.RESET_FONTEDGE_COLOR = (_st, _fn, vm) => () => {
  vm.fixed?.resetEdgeColor();
};
// OUTPUTHINTS saves the resources/HINT/*.dat files next to the exe as .txt (a walkthrough note the player opens outside the game). The web build has no folder to write to, so this is a
// debug-log line, not an error; the game goes on.
COMMANDS.OUTPUTHINTS = (_st, _fn, vm) => () => {
  vm.debugPrint(
    'OUTPUTHINTS: the game asks to write its hint files (resources/HINT/*.dat -> .txt next to the game); not available in the web build, skipped',
  );
};
