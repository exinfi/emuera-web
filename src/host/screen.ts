/** Pure helpers shared by shells (no DOM). */
import type { Sprite, ScreenKind } from './protocol';

/** screen colour -> CSS: -1 = default (empty), -2 = grey, else 0xRRGGBB */
export function hex(c: number): string {
  return c === -1 ? '' : c === -2 ? '#666' : '#' + (c & 0xffffff).toString(16).padStart(6, '0');
}

/** a sprite bitmap as held by a shell; `total` and `start` belong to the animation clock */
export type Bmp = Sprite & { total?: number; start?: number };

/** total length of an animated sprite's loop (call once when the sprite arrives) */
export function animTotal(b: Bmp): number | undefined {
  return b.anim ? b.anim.reduce((t, f) => t + f.delay, 0) : undefined;
}

/** which frame of an animated sprite shows at `now` (ms). The clock starts the first time the sprite is asked for, as in Emuera. */
export function frameAt(b: Bmp, now: number): number {
  if (!b.anim || !b.total) return 0;
  if (b.start === undefined) b.start = now;
  let m = (now - b.start) % b.total;
  for (let i = 0; i < b.anim.length; i++) {
    if (m < b.anim[i].delay) return i;
    m -= b.anim[i].delay;
  }
  return 0;
}

/** DOM mouse button 0/1/2 -> WinForms MouseButtons Left/Middle/Right (INPUTMOUSEKEY button codes) */
export const MOUSE_BUTTONS = [0x100000, 0x400000, 0x200000];
export const mouseButtonCode = (domButton: number): number => MOUSE_BUTTONS[domButton] ?? 0x100000;
/** Keys modifier bits for INPUTMOUSEKEY key events */
export const modifierBits = (m: { shift: boolean; ctrl: boolean; alt: boolean }): number =>
  (m.shift ? 0x10000 : 0) | (m.ctrl ? 0x20000 : 0) | (m.alt ? 0x40000 : 0);

/** the original only turns the literal text "<br>" into a line break; everything else is shown as written */
export const tipText = (t: string): string => t.replace(/<br>/g, '\n');

/** presentation only: drop blank lines at the start and end of tooltip text (games pad their tooltips with leading/trailing `<br>` for the original's tight tooltip box); inner blank lines are kept */
export const stripTipText = (t: string): string =>
  t.replace(/^(?:[ \t\u3000]*\r?\n)+/, '').replace(/(?:\r?\n[ \t\u3000]*)+$/, '');

/** TOOLTIP_FORMAT (TextFormatFlags) applies only to owner-drawn tooltips: padding, alignment and direction */
export function tipLayout(flags: number): {
  padding: string;
  textAlign: 'left' | 'center' | 'right';
  direction: 'ltr' | 'rtl';
} {
  return {
    padding: flags & 0x10000000 ? '2px' : flags & 0x20000000 ? '6px 18px' : '6px 10px',
    textAlign: flags & 1 ? 'center' : flags & 2 ? 'right' : 'left',
    direction: flags & 0x20000 ? 'rtl' : 'ltr',
  };
}

/** how a shell should present the current wait: 'number' (int/oneint: numeric keypad), 'text' (str/onestr), 'any' (number or text), 'wait' (continue: click or Enter; anykey too), 'mouse' (INPUTMOUSEKEY: stage events, no typing), 'none' (done/error) */
export function promptClass(kind: ScreenKind | ''): 'number' | 'text' | 'any' | 'wait' | 'mouse' | 'none' {
  switch (kind) {
    case 'int':
    case 'oneint':
      return 'number';
    case 'str':
    case 'onestr':
      return 'text';
    case 'any':
      return 'any';
    case 'wait':
    case 'anykey':
      return 'wait';
    case 'mousekey':
      return 'mouse';
    default:
      return 'none';
  }
}

/** comparison key for font family names: case, spaces, hyphens and underscores are ignored ("BIZ UD Gothic" = "BIZ UDGothic") */
export const familyKey = (s: string): string => s.toLowerCase().replace(/[\s\-_]+/g, '');
/** the registered family a requested name refers to (Emuera matches by family name), or the name itself when none matches */
export function resolveFamily(name: string, registered: readonly string[]): string {
  const k = familyKey(name);
  return registered.find((f) => familyKey(f) === k) ?? name;
}
