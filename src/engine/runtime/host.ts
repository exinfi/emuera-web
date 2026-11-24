/**
 * The only surface between the VM and the outside world.
 *  - Renderer: synchronous output sink (console text, colours, buttons, later graphics).
 *  - Request/Response: the VM is a generator; it *yields* a Request when it needs the user and is
 *    resumed with the response. This keeps the core free of DOM, timers and promises.
 */
export type InputKind = 'int' | 'str' | 'any' | 'wait' | 'oneint' | 'onestr' | 'anykey' | 'mousekey';
/** response prefix for INPUTMOUSEKEY: MK_PREFIX + JSON [type, r1, r2, r3, r4, r5]  (type 1 click, 2 wheel, 3 key, 4 timeout) */
export const MK_PREFIX = '\u0001MK';
/** response to a timed InputRequest whose limit ran out (the host sends this instead of text) */
export const TIMEOUT = '\u0001TIMEOUT';

export interface InputRequest {
  t: 'input';
  kind: InputKind;
  /** value used on empty input / timeout */
  def?: string;
  /** TINPUT/TWAIT limit in ms */
  timeoutMs?: number;
  /** the last printed line is the "Remaining: x.x" display: the host redraws it about every 100 ms until the request is answered (EmueraConsole.tickTimer) */
  countdown?: boolean;
  /** text shown after timeout (TINPUT) */
  timeoutMsg?: string;
  /** INPUTMOUSEKEY etc. */
  mouse?: boolean;
}
export type Request = InputRequest | { t: 'delay'; ms: number; marker?: string };
/** Response to an InputRequest: the entered text, or null if the host has no input (starved). */
export type Response = string | null;

export type SoundMsg =
  | { op: 'play'; file: string; repeat: number; bgm: boolean }
  | { op: 'stop'; bgm: boolean }
  | { op: 'volume'; vol: number; bgm: boolean };

export interface Renderer {
  /** append text to the current line */
  print(text: string): void;
  /** finish the current line */
  newline(): void;
  clearScreen(): void;
  /** remove the last n finished lines (CLEARLINE) */
  clearLines(n: number): void;
  drawLine(ch?: string): void;
  setColor(rgb: number): void;
  setBgColor(rgb: number): void;
  resetColor(): void;
  setFont(name: string): void;
  setStyle(bits: number): void;
  setAlign(a: 'left' | 'center' | 'right'): void;
  /** clickable button: text shown, value injected as input when clicked */
  button(text: string, value: string): void;
  /** replace the last printed line (REUSELASTLINE) */
  reuseLastLine?(text: string): void;
  /** true while printed text is waiting for its line to be finished (PrintFlush(false) ends it) */
  pending?(): boolean;
  /** LINECOUNT: finished logical lines on screen */
  lineCount?(): number;
  /** state of the last finished line, for the system flow's "was that input handled?" checks */
  lastLine?(): { temp: boolean; empty: boolean };
  /** inline image from the game's resources (PRINT_IMG); sizes are in 1/100 of a line height, 0 = natural */
  image?(
    name: string,
    height?: number,
    width?: number,
    o?: { hpx?: boolean; wpx?: boolean; ypos?: number; ypx?: boolean; srcb?: string },
  ): void;
  /** GETDISPLAYLINE: plain text of display line n ("" out of range) */
  displayLine?(n: number): string;
  /** HTML_GETPRINTEDSTR: markup of the logical line n counted from the latest (0) */
  htmlLine?(n: number): string;
  /** HTML_POPPRINTINGSTR: take the not yet finished line as markup */
  popPendingHtml?(): string;
  /** HTML_PRINT_ISLAND / _CLEAR: persistent overlay markup */
  /** `layer` (Emuera.NET: HTML_PRINT_ISLAND html, layer; _CLEAR [layer]) is given only when the game wrote one; a host that does not model layers ignores it */
  island?(markup: string, layer?: number): void;
  clearIsland?(layer?: number): void;
  /** CLEARTEXTBOX / GETTEXTBOX / MOVETEXTBOX / RESUMETEXTBOX / SETBGIMAGE...: optional UI hooks */
  clearText?(): void;
  getTextBox?(): string;
  /** SETTEXTBOX: put text in the input box (the next GETTEXTBOX returns it) */
  setTextBox?(text: string): void;
  /** PRINT_RECT: a filled rectangle in the current color; each value is a width/height in percent of the font size (px when the matching `px` entry is true); 1 value = width, 4 = x, y, width, height */
  rect?(v: number[], px: boolean[]): void;
  moveTextBox?(x: number, y: number, width: number): void;
  resumeTextBox?(): void;
  setTitle?(title: string): void;
  setBgImage?(name: string, depth: number, opacity: number): void;
  clearBgImage?(): void;
  removeBgImage?(name: string): void;
  /** raw HTML print (HTML_PRINT) */
  html(markup: string, noNewline?: boolean): void;
  /** audio (PLAYSOUND/PLAYBGM/...): the channel logic lives in the host's audio player; channel 'bgm' loops forever */
  sound?(m: SoundMsg): void;
  /** commands the host does not implement are reported here instead of throwing */
  note(msg: string): void;
}

export class NullRenderer implements Renderer {
  print() {}
  newline() {}
  clearScreen() {}
  clearLines() {}
  drawLine() {}
  setColor() {}
  setBgColor() {}
  resetColor() {}
  setFont() {}
  setStyle() {}
  setAlign() {}
  button() {}
  html() {}
  note() {}
}
