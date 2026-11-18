/**
 * Audio builtins. Semantics follow Emuera's PLAYSOUND/PLAYBGM/STOPSOUND/STOPBGM/SETSOUNDVOLUME/SETBGMVOLUME/EXISTSOUND
 * files live under sound/, a missing file is a silent no-op, PLAYSOUND's repeat is
 * clamped to >= 1, volume is clamped to 0..100. Channel selection (10 sound channels + 1 bgm; first idle channel else 0) needs to know
 * what is still playing, so it belongs to the host's audio player; the engine only forwards the intent.
 */
import { def, S } from './funcs';
import { toNum } from './eval';
import type { VM } from './vm';

const norm = (p: string) =>
  p
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .toLowerCase();
const has = (vm: VM, f: string) => vm.soundFiles.has(norm(f));
const clamp = (v: number) => Math.max(0, Math.min(100, Math.trunc(v)));

def('EXISTSOUND', (vm, a) => (has(vm, S(a[0])) ? 1 : 0));
def('PLAYSOUND', (vm, a) => {
  const f = S(a[0]);
  const repeat = a.length > 1 ? Math.max(Number(toNum(a[1])), 1) : 1;
  if (has(vm, f)) vm.host.sound?.({ op: 'play', file: norm(f), repeat, bgm: false });
  return 0;
});
def('PLAYBGM', (vm, a) => {
  const f = S(a[0]);
  if (has(vm, f)) vm.host.sound?.({ op: 'play', file: norm(f), repeat: -1, bgm: true });
  return 0;
});
def('STOPSOUND', (vm) => {
  vm.host.sound?.({ op: 'stop', bgm: false });
  return 0;
});
def('STOPBGM', (vm) => {
  vm.host.sound?.({ op: 'stop', bgm: true });
  return 0;
});
def('SETSOUNDVOLUME', (vm, a) => {
  vm.host.sound?.({ op: 'volume', vol: clamp(Number(toNum(a[0]))), bgm: false });
  return 0;
});
def('SETBGMVOLUME', (vm, a) => {
  vm.host.sound?.({ op: 'volume', vol: clamp(Number(toNum(a[0]))), bgm: true });
  return 0;
});
