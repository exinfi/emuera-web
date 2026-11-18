/** Queries about the running program and the host window: skip state, fonts, mouse, keys, hotkeys, config values, memory, user-function reflection. */
import type { Frame } from './eval';
import { def, S } from './funcs';
import { EmueraError, Value } from './value';
import type { VM } from './vm';
import { configValue } from './config';

/** CHKFONT: the browser cannot enumerate installed fonts, so report the common ones the page will resolve (or fall back from) */
const KNOWN_FONTS = new Set([
  'arial',
  'verdana',
  'times new roman',
  'georgia',
  'courier new',
  'tahoma',
  'ms gothic',
  'ms mincho',
  'meiryo',
  'yu gothic',
  'segoe ui',
  'comic sans ms',
  'trebuchet ms',
  'impact',
]);
const fontKey = (s: string) => s.toLowerCase().replace(/[\s\-_]+/g, ''); // same rule as host/screen.ts familyKey (the engine tier does not import the host tier)
def('CHKFONT', (vm, a) =>
  KNOWN_FONTS.has(S(a[0]).toLowerCase()) ||
  S(a[0]) === vm.config.fontName ||
  vm.fontFamilies.some((f) => fontKey(f) === fontKey(S(a[0])))
    ? 1
    : 0,
);
def('MOUSEX', (vm) => vm.mouse.x);
def('MOUSEY', (vm) => vm.mouse.y);
def('CLIENTWIDTH', (vm) => vm.config.windowWidth);
def('CLIENTHEIGHT', (vm) => vm.config.windowHeight);
const cfgGet = (vm: VM, name: Value | undefined, fn: string, want: 'int' | 'str') => {
  const n = S(name);
  if (n === '') throw new EmueraError(`${fn}: The 1 argument is empty string`);
  const v = configValue(vm.config, n);
  if (v === undefined) throw new EmueraError(`Config name "${n}" is invalid`);
  if (want === 'int' ? typeof v !== 'number' : typeof v !== 'string')
    throw new EmueraError(`${fn}: Wrong type (use the ${want === 'int' ? 'GETCONFIGS' : 'GETCONFIG'} function)`);
  return v;
};
def('GETCONFIG', (vm, a) => cfgGet(vm, a[0], 'GETCONFIG', 'int'));
def('GETCONFIGS', (vm, a) => cfgGet(vm, a[0], 'GETCONFIGS', 'str'));
for (const n of ['OUTPUTLOG', 'SETTEXTBOX', 'SETANIMETIMER']) def(n, () => 0);
def('ISSKIP', () => 0);

def('MESSKIP', (vm) => (vm.mesSkip ? 1 : 0));
def('MOUSESKIP', (vm) => (vm.mesSkip ? 1 : 0)); // deprecated alias of MESSKIP

def('GETMETH', (vm, a) => {
  const name = String(a[0]);
  const f = vm.findFunc(name);
  if (!f) {
    if (a.length < 2 || a[1] === undefined) throw new EmueraError(`function @${name} is not defined`);
    return a[1];
  }
  if (f.method !== 'int') throw new EmueraError(`@${name} is not an integer #FUNCTION`);
  return vm.callMethod(f, a.slice(2));
});
def('GETMETHS', (vm, a) => {
  const name = String(a[0]);
  const f = vm.findFunc(name);
  if (!f) {
    if (a.length < 2 || a[1] === undefined) throw new EmueraError(`function @${name} is not defined`);
    return a[1];
  }
  if (f.method !== 'str') throw new EmueraError(`@${name} is not a string #FUNCTIONS`);
  return vm.callMethod(f, a.slice(2));
});
// bit 1 = integer function, bit 2 = string function (user #FUNCTION only here; built-in methods are not reported)
def('EXISTMETH', (vm, a) => {
  const f = vm.findFunc(String(a[0]));
  return !f || !f.method ? 0 : f.method === 'int' ? 1 : 2;
});

def('GETMEMORYUSAGE', () => {
  const p: any = (globalThis as any).process;
  if (p?.memoryUsage) return p.memoryUsage().rss;
  return (performance as any).memory?.usedJSHeapSize ?? 0;
});
def('CLEARMEMORY', () => 0); // no GC control in a browser; the original returns the freed working-set bytes
def('GETDOINGFUNCTION', (_vm, _a, fr: Frame) => fr.fn.name);

def('BITMAP_CACHE_ENABLE', (vm, a) => {
  vm.bitmapCache = Number(a[0]) !== 0;
  return 0;
});
def('HOTKEY_STATE', (vm, a) => {
  vm.hotkeys.set(Number(a[0]), Number(a[1]));
  return 0;
});
def('HOTKEY_STATE_INIT', (vm, a) => {
  vm.hotkeys.delete(Number(a[0]));
  return 0;
});

// GETKEY / GETKEYTRIGGERED: 0 unless the window is active; keycodes outside 0..255 give 0.
// Windows' toggle bit flips per press; GETKEYTRIGGERED is 1 the first time and whenever the toggle differs from the previous query.
const keyState = (triggered: boolean) => (vm: any, a: any[]) => {
  const s = vm.inputState;
  if (!s.active) return 0;
  const k = Number(a[0]);
  if (k < 0 || k > 255) return 0;
  const down = s.keys.has(k);
  const prev = s.seen[k];
  s.seen[k] = s.toggleBit[k] + 1;
  return down && (!triggered || prev !== s.seen[k]) ? 1 : 0;
};
def('GETKEY', keyState(false));
def('GETKEYTRIGGERED', keyState(true));
def('ISACTIVE', (vm) => (vm.inputState.active ? 1 : 0));
def('MOUSEB', (vm) => vm.inputState.pointing);
