/**
 * #DEFINE macros (ERH). Plain-text macros only: the original seals function-like macros (`#DEFINE F(A) ...` is an error, see
 * ErhLoader.analyzeSharpDefine). Expansion is token-level in Emuera (LexicalAnalyzer.expandMacro): only identifier words are replaced, so
 * string literals and numbers are never touched; the replacement is spliced in as text and re-scanned until no macro is left, with a
 * budget of MAX_EXPAND_MACRO expansions per line. Text splicing is equivalent because the replacement is itself a token run.
 */
import { ParseError } from './ast';
import { cfg } from './config';

export const MAX_EXPAND_MACRO = 100;
/** Characters that end an identifier (LexicalAnalyzer._searchValues). */
export const ID_STOP = new Set(Array.from(' 　.+-*/%=!<>|&^~?#)}],:({[$\\\'"@;\t'));
const isDigit = (c: string) => c >= '0' && c <= '9';

export const macroKey = (n: string) => n.toUpperCase();

/** a word that could start an identifier at s[i] */
export const idStart = (s: string, i: number) => i < s.length && !isDigit(s[i]) && !ID_STOP.has(s[i]);

/** pad a replacement so it cannot fuse with the characters around it (tokens stay separate in Emuera) */
export function spliceMacro(s: string, start: number, end: number, rep: string): string {
  const glue = (a: string | undefined, b: string | undefined) =>
    a !== undefined && b !== undefined && !ID_STOP.has(a) && !ID_STOP.has(b);
  const l = glue(s[start - 1], rep[0]) ? ' ' : '',
    r = glue(rep[rep.length - 1], s[end]) ? ' ' : '';
  return s.slice(0, start) + l + rep + r + s.slice(end);
}

/** end index of the string literal starting at s[i] === '"' */
function skipString(s: string, i: number): number {
  for (i++; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '"') return i + 1;
  }
  return s.length;
}

/** Expand every macro identifier in an expression text (used for #DEFINE bodies, which Emuera analyses with the macros known so far). */
export function expandText(text: string, budget = { n: 0 }): string {
  if (cfg.macros.size === 0) return text;
  let s = text;
  for (let i = 0; i < s.length; ) {
    const ch = s[i];
    if (ch === '"') {
      i = skipString(s, i);
      continue;
    }
    if (ch === '@' && s[i + 1] === '"') {
      i = skipString(s, i + 1);
      continue;
    }
    if (isDigit(ch)) {
      while (i < s.length && !ID_STOP.has(s[i])) i++;
      continue;
    }
    if (!idStart(s, i)) {
      i++;
      continue;
    }
    let j = i;
    while (j < s.length && !ID_STOP.has(s[j])) j++;
    const rep = cfg.macros.get(macroKey(s.slice(i, j)));
    if (rep === undefined) {
      i = j;
      continue;
    }
    if (++budget.n > MAX_EXPAND_MACRO)
      throw new ParseError(
        `macro expansion exceeded ${MAX_EXPAND_MACRO} iterations (self-referencing or circular macro?)`,
      );
    s = spliceMacro(s, i, j, rep);
  }
  return s;
}

/** strip a trailing `;comment` (not inside a string) */
export function stripLineComment(s: string): string {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') {
      i = skipString(s, i) - 1;
      continue;
    }
    if (s[i] === ';') return s.slice(0, i);
  }
  return s;
}

/** the replacement of a macro must be balanced in () and [] by itself (the original lexes it as one expression) */
export function checkBalanced(s: string): void {
  let p = 0,
    b = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      i = skipString(s, i) - 1;
      continue;
    }
    if (ch === '(') p++;
    else if (ch === ')') p--;
    else if (ch === '[') b++;
    else if (ch === ']') b--;
    if (p < 0) throw new ParseError("unmatched ')' in macro replacement");
    if (b < 0) throw new ParseError("unmatched ']' in macro replacement");
  }
  if (p > 0) throw new ParseError("unclosed '(' in macro replacement");
  if (b > 0) throw new ParseError("unclosed '[' in macro replacement");
}
