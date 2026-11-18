/** Minimal character cursor over one logical line. */
import { cfg } from './config';

export class Cursor {
  i = 0;
  /** macro expansions done on this line (limit MAX_EXPAND_MACRO) */
  macros = 0;
  constructor(public s: string) {}
  get eof() {
    return this.i >= this.s.length;
  }
  get cur() {
    return this.i < this.s.length ? this.s[this.i] : '\0';
  }
  at(n = 0) {
    return this.i + n < this.s.length ? this.s[this.i + n] : '\0';
  }
  startsWith(t: string) {
    return this.s.startsWith(t, this.i);
  }
  skipWs() {
    while (!this.eof) {
      const c = this.s[this.i];
      if (c === ' ' || c === '\t' || (c === '　' && cfg.fullWidthSpace)) this.i++;
      else break;
    }
  }
  rest() {
    return this.s.slice(this.i);
  }
}
