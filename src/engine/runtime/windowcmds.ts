/** Commands and functions that act on the host window: the input text box and the background image. */
import { compile, compileForm } from './eval';
import { COMMANDS } from './commands';
import { def } from './funcs';

def('GETTEXTBOX', (vm) => vm.host.getTextBox?.() ?? '');
def('MOVETEXTBOX', (vm, a) => {
  vm.host.moveTextBox?.(Number(a[0]), Number(a[1]), Number(a[2]));
  return 1;
});
def('RESUMETEXTBOX', (vm) => {
  vm.host.resumeTextBox?.();
  return 1;
});
COMMANDS.CLEARTEXTBOX = (_st, _fn, vm) => () => {
  vm.host.clearText?.();
};

// SETBGIMAGE name [, depth [, opacity 0..255]] / CLEARBGIMAGE / REMOVEBGIMAGE name
COMMANDS.SETBGIMAGE = (st, fn, vm) => {
  const l =
    st.arg.a === 'form'
      ? [compileForm(st.arg.parts, fn, vm)]
      : st.arg.a === 'exprs'
        ? st.arg.list.map((e) => compile(e, fn, vm))
        : []; // plain values: compileArg would hand a variable back as an array handle
  return (fr) => {
    const v = l.map((f) => String(f(fr)));
    vm.host.setBgImage?.(v[0] ?? '', v[1] ? parseInt(v[1], 10) : 0, v[2] ? parseInt(v[2], 10) / 255 : 1);
  };
};
COMMANDS.CLEARBGIMAGE = (_st, _fn, vm) => () => {
  vm.host.clearBgImage?.();
};
COMMANDS.REMOVEBGIMAGE = (st, fn, vm) => {
  const f = st.arg.a === 'form' ? compileForm(st.arg.parts, fn, vm) : () => '';
  return (fr) => {
    vm.host.removeBgImage?.(String(f(fr)));
  };
};
