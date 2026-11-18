/**
 * Line-level preprocessing of ERB/ERH text, ported from ErbLoader/EraStreamReader:
 *  - [IF_DEBUG]/[IF_NDEBUG]/[IF X]/[ELSEIF X]/[ELSE]/[ENDIF]/[SKIPSTART]/[SKIPEND]
 *  - `{` ... `}` line continuation (joined with a single space)
 *  - `;!;` / `;^;` EMEE executable-comment prefixes
 * Output: logical lines with their 1-based starting line number. Whole-line
 * comments and blank lines are dropped.
 */
import { cfg } from './config';

export interface LogicalSrc {
  line: number;
  text: string;
}

export interface PPOptions {
  debug?: boolean;
  /** upper-cased macro names; [IF X] tests this set */
  macros?: Set<string>;
  /** ERH files: an active `#DEFINE NAME` line adds NAME to `macros` as the file is read, so later [IF NAME] lines in the same file see it */
  collectDefines?: boolean;
}

class PPState {
  skip = false;
  done = false;
  disabled = false;
  private disabledStack: boolean[] = [];
  private doneStack: boolean[] = [];
  private match: string[] = [];
  constructor(private o: PPOptions) {}
  private has(n: string) {
    return !!this.o.macros?.has(n.toUpperCase());
  }
  add(token: string, token2: string) {
    switch (token) {
      case 'SKIPSTART':
        if (token2 || this.skip) break;
        this.match.push('SKIPEND');
        this.disabledStack.push(this.disabled);
        this.doneStack.push(this.done);
        this.skip = true;
        this.disabled = true;
        this.done = false;
        break;
      case 'IF_DEBUG':
        if (token2) break;
        this.match.push('ELSEIF');
        this.disabledStack.push(this.disabled);
        this.doneStack.push(this.done);
        this.disabled = !this.o.debug;
        this.done = !this.disabled;
        break;
      case 'IF_NDEBUG':
        if (token2) break;
        this.match.push('ELSEIF');
        this.disabledStack.push(this.disabled);
        this.doneStack.push(this.done);
        this.disabled = !!this.o.debug;
        this.done = !this.disabled;
        break;
      case 'IF':
        if (!token2) break;
        this.match.push('ELSEIF');
        this.disabledStack.push(this.disabled);
        this.doneStack.push(this.done);
        this.disabled = !this.has(token2);
        this.done = !this.disabled;
        break;
      case 'ELSEIF':
        if (!token2) break;
        if (this.match.length === 0 || this.match.pop() !== 'ELSEIF') break;
        this.match.push('ELSEIF');
        this.disabled = this.done || !this.has(token2);
        this.done = this.done || !this.disabled;
        break;
      case 'ELSE':
        if (token2) break;
        if (this.match.length === 0 || this.match.pop() !== 'ELSEIF') break;
        this.match.push('ENDIF');
        this.disabled = this.done;
        this.done = true;
        break;
      case 'SKIPEND': {
        if (token2) break;
        const m = this.match.length ? this.match.pop() : '';
        if (m !== 'SKIPEND') break;
        this.skip = false;
        this.disabled = this.disabledStack.pop()!;
        this.done = this.doneStack.pop()!;
        break;
      }
      case 'ENDIF': {
        if (token2) break;
        const m = this.match.length ? this.match.pop() : '';
        if (m !== 'ENDIF' && m !== 'ELSEIF') break;
        this.disabled = this.disabledStack.pop()!;
        this.done = this.doneStack.pop()!;
        break;
      }
    }
    if (this.skip) this.disabled = true;
  }
}

/** Strip a trailing `;comment`, ignoring `;` inside double quotes. */
function stripComment(line: string): string {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"') q = !q;
    else if (ch === ';' && !q) return line.slice(0, i);
  }
  return line;
}

const isWs = (c: string) => c === ' ' || c === '\t' || c === '　';

export function preprocess(text: string, opts: PPOptions = {}): LogicalSrc[] {
  const raw = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  const out: LogicalSrc[] = [];
  const pp = new PPState(opts);
  for (let i = 0; i < raw.length; i++) {
    const lineNo = i + 1;
    let line = raw[i];
    // leading whitespace, EMEE ";!;" ";^;" prefixes, then comment check
    let p = 0;
    for (;;) {
      while (p < line.length && (line[p] === ' ' || line[p] === '\t' || (line[p] === '\u3000' && cfg.fullWidthSpace)))
        p++; // EraStreamReader.ReadEnabledLine -> LexicalAnalyzer.SkipWhiteSpace
      if (line.startsWith(';!;', p) || line.startsWith(';^;', p)) {
        p += 3;
        continue;
      }
      if (opts.debug && line.startsWith(';#;', p)) {
        p += 3;
        continue;
      }
      break;
    }
    if (p >= line.length || line[p] === ';') continue;
    line = line.slice(p);
    // preprocessor directive
    if (line[0] === '[' && line[1] !== '[') {
      const m = /^\[\s*([A-Za-z_]+)\s*([^\]\s]*)\s*\]/.exec(line);
      if (m) pp.add(m[1], m[2]);
      continue;
    }
    if (pp.disabled) {
      // still need to track `{` blocks? Emuera skips them line-by-line when disabled (no continuation handling)
      continue;
    }
    if (opts.collectDefines && opts.macros && line[0] === '#') {
      const m = /^#\s*DEFINE\s+([^\s(;.+\-*\/%=!<>|&^~?#)}\],:({[$\\'"@]+)/i.exec(line);
      if (m) opts.macros.add(m[1].toUpperCase());
    }
    if (line[0] === '}') throw new Error(`${lineNo}: unexpected '}'`);
    if (line[0] === '{') {
      if (line.trim() !== '{') throw new Error(`${lineNo}: text after '{'`);
      // Emuera joins the raw lines (comments included) *before* comment handling, so a `;`
      // anywhere in the block comments out everything after it - and a block that starts
      // with a `;` line is entirely a comment (used by authors as a block-comment idiom).
      let buf = '';
      let j = i + 1;
      for (; j < raw.length; j++) {
        const t = raw[j].trimStart();
        if (t[0] === '}') {
          if (t.trimEnd() !== '}') throw new Error(`${j + 1}: text after '}'`);
          break;
        }
        if (t.trimEnd() === '{') throw new Error(`${j + 1}: nested '{'`);
        buf += raw[j] + ' ';
      }
      if (j >= raw.length) throw new Error(`${lineNo}: '{' not closed`);
      i = j;
      const joined = buf.replace(/^[ \t]+/, '');
      if (joined[0] === ';' && !joined.startsWith(';!;') && !joined.startsWith(';^;')) continue;
      out.push({ line: lineNo, text: joined });
      continue;
    }
    out.push({ line: lineNo, text: line });
  }
  return out;
}

export { isWs };
