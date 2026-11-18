/**
 * Interpreter optimizations that are not part of the original Emuera's way of doing things.
 * One switch (VM.setOptimize / the "interpreter optimizations" checkbox) turns the whole set on or off; the
 * original code path stays in place for every entry, so `off` runs exactly what the port did before.
 * `equivalent: true` entries give byte-identical results by construction and are not behind the switch.
 */
export interface Optimization {
  id: string;
  equivalent: boolean;
  what: string;
}
export const OPTIMIZATIONS: Optimization[] = [
  {
    id: 'save-parse',
    equivalent: true,
    what: 'JSON.parse of a save skips the BigInt reviver when the text holds no {"$b":..}; the load screen parses a save once',
  },
  {
    id: 'chara-read-zero',
    equivalent: false,
    what: 'character variables: unset ones are read from one shared all-zero array instead of allocating one per character; arrays are found through per-character slot tables instead of a Map lookup by name; CFLAG:chara:index style reads and writes skip the index array and offset loop (same evaluation and error order)',
  },
  {
    id: 'call-no-wrapper',
    equivalent: true,
    what: 'CALL statements return the callee generator directly instead of through a delegating wrapper generator',
  },
  {
    id: 'frame-dirty',
    equivalent: false,
    what: 'releasing a call frame clears only the part of LOCAL/ARG/LOCALS/ARGS that was written (tracked on every write path; any array handed to a builtin counts as fully written) instead of all 1000 elements',
  },
  {
    id: 'groupmatch-const',
    equivalent: false,
    what: 'GROUPMATCH(x, literal, literal, ...) compares x against precomputed literals instead of building an argument array per call',
  },
  {
    id: 'compare-number',
    equivalent: true,
    what: '== != < > <= >= on two plain numbers compare directly instead of switching on the operator per evaluation',
  },
  {
    id: 'builtin-args-loop',
    equivalent: true,
    what: 'builtins with 4+ arguments fill their argument array with a loop instead of Array.map; MIN/MAX of two arguments skip map/reduce',
  },
  {
    id: 'scalar-access',
    equivalent: true,
    what: 'reading/writing a bare scalar variable (#DIM X, TARGET, RESULT, LOCAL, ARG ...) goes straight to element 0 instead of through the generic subscript path (no index array, no result object per access)',
  },
  {
    id: 'screen-line-needs',
    equivalent: true,
    what: 'the worker works out once per printed line which sprites and numeric tooltips it needs (cached) instead of walking every segment of every line of the screen for each command',
  },
  {
    id: 'incremental-log-dom',
    equivalent: false,
    what: 'the page keeps the DOM of log lines that did not change between screens (message lineIds) and only adds new lines, instead of emptying and rebuilding the whole log for each command; falls back to a full redraw when a sprite changed or the ids do not line up. Output (DOM) is identical; behind the checkbox so it can be compared',
  },
  {
    id: 'match-loop',
    equivalent: true,
    what: 'MATCH over a numeric value compares with === directly instead of calling the string-aware helper per element',
  },
];
