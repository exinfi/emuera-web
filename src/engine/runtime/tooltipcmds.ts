// TOOLTIP_*: they only change the tooltip state; the web page draws the tooltip
import { compile } from './eval';
import { COMMANDS } from './commands';
import * as V from './value';
import { EmueraError } from './value';
import type { VM } from './vm';

const arg = (st: any, fn: any, vm: VM, i: number) =>
  st.arg.a === 'exprs' && st.arg.list[i] ? compile(st.arg.list[i], fn, vm) : null; // plain values (compileArg returns a variable as an array handle)
const color = (v: unknown, n: number): number => {
  const c = Number(v);
  if (!(c >= 0 && c <= 0xffffff)) throw new EmueraError(`TOOLTIP_SETCOLOR: argument ${n} is not a valid color code`);
  return c;
};
COMMANDS.TOOLTIP_CUSTOM = (st, fn, vm) => {
  const e = arg(st, fn, vm, 0);
  return (fr) => {
    vm.tooltip.custom = e ? !V.isZero(e(fr) as any) : false;
  };
};
COMMANDS.TOOLTIP_SETFONTSIZE = (st, fn, vm) => {
  const e = arg(st, fn, vm, 0);
  return (fr) => {
    if (e) vm.tooltip.size = Number(e(fr));
  };
};
COMMANDS.TOOLTIP_SETFONT = (st, fn, vm) => {
  const e = arg(st, fn, vm, 0);
  return (fr) => {
    if (e) vm.tooltip.font = String(e(fr));
  };
};
COMMANDS.TOOLTIP_SETCOLOR = (st, fn, vm) => {
  const a = arg(st, fn, vm, 0),
    b = arg(st, fn, vm, 1);
  return (fr) => {
    if (a && b) {
      vm.tooltip.fg = color(a(fr), 1);
      vm.tooltip.bg = color(b(fr), 2);
    }
  };
};
COMMANDS.TOOLTIP_SETDELAY = (st, fn, vm) => {
  const e = arg(st, fn, vm, 0);
  return (fr) => {
    if (e) vm.tooltip.delay = Math.max(0, Number(e(fr)));
  };
};
COMMANDS.TOOLTIP_SETDURATION = (st, fn, vm) => {
  const e = arg(st, fn, vm, 0);
  return (fr) => {
    if (e) vm.tooltip.duration = Math.max(0, Number(e(fr)));
  };
};
COMMANDS.TOOLTIP_FORMAT = (st, fn, vm) => {
  const e = arg(st, fn, vm, 0);
  return (fr) => {
    if (e) vm.tooltip.format = Number(e(fr));
  };
};
COMMANDS.TOOLTIP_IMG = (st, fn, vm) => {
  const e = arg(st, fn, vm, 0);
  return (fr) => {
    vm.tooltip.img = e ? !V.isZero(e(fr) as any) : false;
  };
};
