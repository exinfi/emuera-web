/**
 * Host protocol: the typed contract between the engine worker (src/play/worker.ts) and any page/shell.
 * Types only (plus option defaults). PROTOCOL_VERSION changes whenever a message name or payload shape changes.
 */
import type { SoundMsg, InputKind } from '../engine/runtime/host';
export type { SoundMsg, InputKind };

export const PROTOCOL_VERSION = 1;

/** what the game is waiting for: an input kind (int/oneint numbers, str/onestr text, any, wait, anykey, mousekey), or 'done' / 'error' when it has stopped */
export type ScreenKind = InputKind | 'done' | 'error';

// ---------------------------------------------------------------- start options (single source of defaults)
export interface StartOptions {
  /** missing characters read as zeros (trimmed test games only) */
  lenient: boolean;
  /** native speed-ups for known slow erablue_resort functions (identical results, fingerprint-gated) */
  patches: boolean;
  /** decode every image at boot (debug) */
  eager: boolean;
  /** parse each function on first call */
  lazy: boolean;
  /** interpreter optimizations (see src/engine/runtime/opts.ts) */
  opt: boolean;
  /** low memory loader (additive, optional, read by the page's loader, not by the engine; default on): ERB/ERH travel to the worker as bytes and are decoded and parsed one file at a time */
  xloader?: boolean;
  /** scan the game's code for folder names and load the extra files in them (additive, optional, read by the page's loader, default off) */
  xrefs?: boolean;
}
/** `hidden`: kept in the code and in `StartOptions` (so a host can still send it) but no checkbox is drawn; the page sends the default */
export interface OptionDef {
  id: string;
  key: keyof StartOptions;
  default: boolean;
  label: string;
  title: string;
  hidden?: boolean;
}
/** order = order of the checkboxes on the test page; `id` is the DOM id used by the test page */
export const OPTION_DEFS: readonly OptionDef[] = [
  {
    id: 'len',
    key: 'lenient',
    default: false,
    label: 'lenient (trimmed games)',
    title: 'Missing characters read as zeros. For trimmed games only.',
    hidden: true,
  },
  {
    id: 'lazy',
    key: 'lazy',
    default: true,
    label: 'lazy parse',
    title:
      'Parse each function the first time it is called (much faster boot, less memory). Untick to parse the whole game at load: same results, but every load-time ERB error is listed at boot.',
  },
  {
    id: 'opt',
    key: 'opt',
    default: true,
    label: 'interpreter optimizations',
    title:
      'Interpreter optimizations that differ from how the original Emuera works internally (e.g. unset character variables are not allocated on read). Same results are expected; untick if anything looks wrong.',
  },
  {
    id: 'patch',
    key: 'patches',
    default: true,
    label: 'per-game patches',
    title:
      'Fixes written for one specific game (speed-ups, layout), applied only to that game. Open the list to switch single patches off. Untick to run every game exactly as the original engine would.',
  },
  {
    id: 'eager',
    key: 'eager',
    default: false,
    label: 'decode all images up front',
    title: 'Debug: decode every image at boot (uses a lot of memory).',
  },
  {
    id: 'xloader',
    key: 'xloader',
    default: true,
    label: 'low memory loader',
    title:
      "ERB files go to the engine as bytes and are decoded and parsed one at a time instead of as two copies of the whole source text. Much lower memory for large games (phones). The parsed program is identical to the original loader's (checked on four games). The engine error report's source excerpt comes from the parsed text and is missing for the few functions with # lines. Untick for the original loader; applies the next time a game loads.",
  },
  {
    id: 'xrefs',
    key: 'xrefs',
    default: false,
    label: 'enable extra file check',
    title:
      "Normally only the standard game folders are loaded. This also loads files from other folders whose names appear in the game's code (a best guess; paths the game builds at run time are missed). Tick it if the game reports a missing file, then reload.",
  },
];
export const DEFAULT_OPTIONS: StartOptions = Object.fromEntries(
  OPTION_DEFS.map((d) => [d.key, d.default]),
) as unknown as StartOptions;

// ---------------------------------------------------------------- shared payload shapes
export interface SavedSlot {
  info: string;
  data: string;
}
export interface Img {
  n: string;
  alt?: string;
  h?: number;
  w?: number;
  hpx?: boolean;
  wpx?: boolean;
  ypos?: number;
  ypx?: boolean;
  srcb?: string;
}
export interface Len {
  n: number;
  px: boolean;
}
export interface Div {
  x?: Len;
  y?: Len;
  w?: Len;
  h?: Len;
  color?: number;
  depth: number;
  box: { [k: string]: Len[] };
  bcolor?: number[];
  lines: Seg[][];
  /** Emuera.NET only: value (and tooltip) of a <button> that encloses the whole <div>; a click anywhere on the box presses it */
  v?: string;
  tip?: string;
}
/** one run of a screen line: text, optional button value `v`, color `c` (-1 default, -2 grey, else 0xRRGGBB), bold, tooltip, image, div, alignment marker */
/** `sp` is a `<shape type='space' param=N>` gap: N percent of the font size (px when `px`), no text (additive) */
/** `f` font family (SETFONT / <font face>; absent = the game's default font), `i` italic, `s` strikeout, `u` underline (all optional, additive) */
/** `pos` (px, additive): <button|nonbutton pos=N> locks the part's x to N from the line start (ConsoleButtonString.PointXisLocked); `nw` (additive): marker for <nobr>, the line is not wrapped (PRINTSINGLE-like) */
/** `<shape type='rect' param=...>`: a filled rectangle at x,y (from the line's top-left) of w x h; `c` color (absent = default text color). `sp` on the same segment is the width the part takes (x+w) in px (additive) */
export interface Rc {
  x: Len;
  y: Len;
  w: Len;
  h: Len;
  c?: number;
}
export interface Seg {
  t: string;
  v?: string;
  c?: number;
  img?: Img;
  b?: number;
  f?: string;
  i?: number;
  s?: number;
  u?: number;
  al?: string;
  tip?: string;
  nb?: boolean;
  div?: Div;
  sp?: Len;
  rc?: Rc;
  pos?: number;
  nw?: boolean;
}
export interface Sprite {
  bmp: ImageBitmap;
  w: number;
  h: number;
  anim?: { bmp: ImageBitmap; delay: number }[];
}
export interface CbgLayer {
  key: string;
  x: number;
  y: number;
  z: number;
}
export interface CbgButton {
  index: number;
  normal: string;
  hover: string;
  x: number;
  y: number;
  z: number;
  tooltip?: string;
}
export interface TooltipCfg {
  custom: boolean;
  font?: string;
  size?: number;
  fg?: number;
  bg?: number;
  delay: number;
  duration: number;
  format: number;
  img: boolean;
}
export interface ScreenCfg {
  w: number;
  h: number;
  fontSize: number;
  lineHeight: number;
  font: string;
  fg: number;
  bg: number;
}

// ---------------------------------------------------------------- page -> worker
/** a font file's face, registered by family name in the page and in the worker (graphics text) */
export interface FontFile {
  family: string;
  weight: number;
  italic: boolean;
  data: ArrayBuffer;
}
export interface StartMsg extends StartOptions {
  type: 'start';
  gameId: string;
  erb: Record<string, string>;
  /** optional (additive, experimental loader): ERB/ERH file bytes (transferred, not copied); `erb` is then empty. The worker decodes each file as the parser reaches it and drops the bytes. */
  erbBytes?: Record<string, ArrayBuffer>;
  csv: Record<string, string>;
  rescsv: Record<string, string>;
  texts: Record<string, string>;
  images: Record<string, ArrayBuffer>;
  /** optional (additive): paths in the game zip the loader did not load; the engine notes it when the game asks for one of them */
  unloaded?: string[];
  sounds: string[];
  saves: Record<string, SavedSlot>;
  files: Record<string, string>;
  /** optional (additive): fonts to register for the engine's own text drawing/measuring and CHKFONT */
  fonts?: FontFile[];
  /** optional (additive): budget for decoded resource images in MB (default 256). A low-memory host (phone) can ask for less; images are decoded again on demand. */
  imageBudgetMB?: number;
  /** optional (additive): overrides the game's window width in px (CLIENTWIDTH, wrapping, stage width); absent = the game's own config */
  windowWidth?: number;
  /** optional (additive): ids of per-game patches switched off (see src/engine/patches/registry.ts); `patches` is the master switch */
  patchOff?: string[];
  /** optional (additive): the most history log lines to keep. The game's own limit (`履歴ログの行数`) is lowered to this when it asks for more (never raised, never below 500); a debug note says so. Absent = the game's limit as is. Suggested defaults: `src/host/web/logcap.ts` */
  logCap?: number;
  /** optional (additive): send each finished line to the page once. Later `screen`/`frame` messages carry `null` in `lines` for a line the page already holds (same id in `lineIds`) and the message has `delta: true`. `Client` rebuilds the full `lines` before any hook sees the message, so a shell that uses `Client` changes nothing but this flag; a host that does not use `Client` must not set it. Absent = every line in every message, as before. */
  deltaLines?: boolean;
}
export type ToWorker =
  | StartMsg
  | { type: 'input'; value: string }
  /** INPUTMOUSEKEY event: [kind(1 click, 2 wheel, 3 key, 4 timeout), r1..r5]; click: [1, button, x, y, 0, 0] with y measured from the stage bottom (<= 0) */
  | { type: 'mousekey'; ev: number[] }
  | { type: 'mousepos'; x: number; y: number }
  | { type: 'keystate'; code: number; down: boolean }
  | { type: 'active'; active: boolean }
  | { type: 'pointing'; value: string }
  | { type: 'inputtext'; value: string }
  | { type: 'card'; saves: Record<string, SavedSlot>; files: Record<string, string> }
  | { type: 'exportlog'; note?: string; withState?: boolean; verbose?: boolean }
  /** optional (additive): only the game snapshot (`logexport` comes back with empty `text`) */
  | { type: 'exportsnapshot' }
  /** optional (additive): convert between our slot records and Emuera's own save files; the answer is a `native` message with the same id */
  | { type: 'native'; id: number; op: 'import'; files: { name: string; bytes: ArrayBuffer }[] }
  | { type: 'native'; id: number; op: 'export'; keys: string[] };

/** result of converting one native save file into one of our slot records */
export interface NativeImported {
  name: string;
  key: string | null;
  ok: boolean;
  /** why it was not converted */
  error?: string;
  info?: string;
  data?: string;
  /** game code / game version / format version the file declares, and the game's own code and version */
  fileCode?: string;
  fileVer?: number;
  fmt?: number;
  gameCode?: string;
  gameVer?: number;
  /** variables of the file this game does not have (not loaded) and other notes */
  skipped?: string[];
  warnings?: string[];
}
export interface NativeExported {
  key: string;
  name: string;
  ok: boolean;
  error?: string;
  bytes?: ArrayBuffer;
}

// ---------------------------------------------------------------- worker -> page
export interface ScreenMsg {
  type: 'screen';
  lines: Seg[][];
  /** optional, one per entry of `lines`: a stable id of that line (>= 0), or -1 for the unfinished line being typed. Lets a view that opts in keep the DOM of lines it already drew. Absent = redraw everything. */
  lineIds?: number[];
  /** set only when `StartMsg.deltaLines` is on: entries of `lines` may be `null` (the page already holds that line, see `lineIds`). `Client` fills them in; shells never see it. */
  delta?: boolean;
  island: Seg[][];
  bgs: { key: string; alpha: number }[];
  /** profile 'puchi' only (eraSumireTeru): the fixed-image layer, screen fades, shake and text outline (engine/runtime/fixedimg.ts); absent for every other game, and a host that ignores it just shows the text */
  fixed?: import('../engine/runtime/fixedimg').FixedMsg;
  /** what the game is waiting for */
  kind: ScreenKind;
  /** engine diagnostics and notes for this screen (debug-level text) */
  notes: string[];
  imgStats: { n: number; of: number; mb: number };
  sprites: Record<string, Sprite>;
  tooltip: TooltipCfg;
  layers: CbgLayer[];
  buttons: CbgButton[];
  sizes: Record<string, { w: number; h: number }>;
  missing: string[];
  cfg: ScreenCfg;
  /** optional (additive): sprite keys (of earlier `sprites`) that nothing on this screen uses any more. A view that keeps bitmaps by key closes and forgets them; one that ignores this only holds more memory. */
  drop?: string[];
}
/** a mid-run redraw (AWAIT): the same content as a screen but no `kind`, because the game is not waiting for anything; the client does not touch input state. A host that ignores it just misses the animation frames. Additive in protocol 1. */
export interface FrameMsg extends Omit<ScreenMsg, 'type' | 'kind'> {
  type: 'frame';
}
export type ToPage =
  | ScreenMsg
  | FrameMsg
  | { type: 'sound'; m: SoundMsg }
  | { type: 'title'; title: string }
  | { type: 'textbox'; op: 'clear' }
  | { type: 'textbox'; op: 'move'; x: number; y: number; width: number }
  | { type: 'textbox'; op: 'resume' }
  | { type: 'status'; msg: string }
  | { type: 'persist'; key: string; value: SavedSlot | null }
  | { type: 'persistFile'; key: string; text: string }
  | { type: 'restart' }
  | { type: 'errreport'; text: string; snapshot: string }
  | { type: 'fatal'; msg: string }
  | { type: 'logexport'; text: string; snapshot: string }
  /** additive: which per-game patches the engine applied once the game was parsed, and the window width in effect with where it came from */
  | {
      type: 'patches';
      active: string[];
      width: number;
      widthFrom: 'game' | 'patch' | 'override';
      /** additive: the boot summary lines for the debug view (game, engine profile, patches applied / ignored / switched off) */ boot?: string[];
    }
  | { type: 'native'; id: number; imported?: NativeImported[]; exported?: NativeExported[]; error?: string };

/** how a shell should treat engine text: `debug` lines may be silenced or sent to a separate panel */
export type DiagnosticLevel = 'debug' | 'warn' | 'error' | 'user';
