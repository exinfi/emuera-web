// HTML helpers: HTML_TAGSPLIT, HTML_SUBSTRING (HtmlManager.HtmlSubString), HTML_GETPRINTEDSTR, HTML_POPPRINTINGSTR,
// HTML_PRINT_ISLAND(+_CLEAR) and GETDISPLAYLINE. Line<->HTML conversion is the renderer's job (optional host hooks).
// Also: HTML_ESCAPE, HTML_TOPLAINTEXT, HTML_STRINGLEN, HTML_STRINGLINES and the HTML_PRINT statement.
import type { Expr } from '../compiler/ast';
import { compile, asStr, toNum } from './eval';
import { COMMANDS } from './commands';
import { def, refOf, S } from './funcs';
import { sjisWidth } from './text';
import { EmueraError } from './value';
import type { VM } from './vm';
import { configValue } from './config';
import { exprs } from './cmdargs';

export const htmlUnescape = (s: string): string => {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, g: string) => {
    switch (g) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
    }
    const n = g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
    return n > 0 && n < 0xffff ? String.fromCharCode(n) : m;
  });
};
export const htmlEscape = (s: string): string =>
  s.replace(/[&><"']/g, (c) => ({ '&': '&amp;', '>': '&gt;', '<': '&lt;', '"': '&quot;', "'": '&apos;' })[c]!);

/** HtmlManager.HtmlTagSplit: alternating text / <tag> pieces; null when a '<' has no closing '>' */
export function htmlTagSplit(str: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  while (i < str.length) {
    const lt = str.indexOf('<', i);
    if (lt < 0) {
      out.push(str.slice(i));
      break;
    }
    if (lt > i) out.push(str.slice(i, lt));
    const gt = str.indexOf('>', lt);
    if (gt < 0) return null;
    out.push(str.slice(lt, gt + 1));
    i = gt + 1;
  }
  return out;
}

/** width in pixels of plain text; the original measures with the real font, this uses the half/full-width cell (fontSize/2 per half-width column) */
function textWidth(vm: VM, s: string): number {
  return (sjisWidth(s) * vm.config.fontSize) / 2;
}
/** pixel width of the visible content of a snippet (tags cost nothing; <img>/<shape> count one full cell, or their width attribute) */
function htmlLength(vm: VM, s: string): number {
  let w = 0;
  for (const p of htmlTagSplit(s) ?? [s]) {
    if (p[0] === '<') {
      if (/^<(img|shape)\b/i.test(p)) {
        const m = /\bwidth\s*=\s*'?(\d+)/i.exec(p);
        w += m ? Math.round((Number(m[1]) * vm.config.fontSize) / 100) : vm.config.fontSize;
      }
    } else w += textWidth(vm, htmlUnescape(p));
  }
  return w;
}

interface Tag {
  tag: string;
  style: boolean;
}
/** HtmlManager.HtmlSubString: splits the markup after `length` half-width columns, keeping open style tags balanced on both sides */
export function htmlSubString(vm: VM, input: string, lengthCols: number): [string, string] {
  const begin: Tag[] = [],
    end: Tag[] = []; // top = last
  let length = (lengthCols * vm.config.fontSize) / 2;
  const str = htmlUnescape(input);
  let last = 0,
    delbr = 0,
    content = false;
  const getSubStr = (pref: string, suff: string, s: string): number => {
    let len = 0,
      i: number;
    for (i = 0; i < s.length; i++) {
      const t = htmlLength(vm, pref + s[i] + suff);
      if (len + t > length) {
        i--;
        break;
      }
      len += t;
    }
    if (i === s.length) i--;
    length -= len;
    return i + 1;
  };
  for (;;) {
    let found = str.indexOf('<', last);
    if (found !== last) {
      let pref = '',
        suff = '';
      for (let k = begin.length - 1; k >= 0; k--) if (begin[k].style) pref += begin[k].tag;
      const arr = [...end].reverse().reverse(); // copy; popping the copy's top == original bottom
      const copy = [...end].reverse(); // Stack<T>(IEnumerable) reverses
      void arr;
      while (copy.length) {
        const t = copy.pop()!;
        if (t.style) suff += t.tag;
      }
      const tstr = found < 0 ? str.slice(last) : str.slice(last, found);
      const tmp = getSubStr(pref, suff, tstr);
      last += tmp + 1;
      content = true;
      if (found < 0 || tmp < tstr.length) break;
    } else last++;
    found = str.indexOf('>', last);
    if (found <= 0) break;
    if (str[last] === '/') {
      begin.pop();
      end.pop();
    } else {
      let fspace = str.indexOf(' ', last);
      if (fspace < 0 || fspace > found) fspace = found;
      const tag = str.slice(last, fspace);
      if (tag === 'br') {
        delbr = 1;
        break;
      }
      if (tag === 'img' || tag === 'shape') {
        const pos = last - 1;
        length -= htmlLength(vm, str.slice(pos, found + 1));
        if (length < 0 && content) break;
      } else {
        const ist = tag === 'b' || tag === 'i' || tag === 's';
        begin.push({ tag: '<' + str.slice(last, found) + '>', style: ist });
        end.push({ tag: '</' + tag + '>', style: ist });
      }
    }
    last = found + 1;
  }
  if (last === 0) return ['', str];
  let a = str.slice(0, last - 1),
    b = '';
  while (end.length) a += end.pop()!.tag;
  while (begin.length) b = begin.pop()!.tag + b;
  b += str.slice(last - 1 + delbr * 4);
  return [a, b];
}

// HTML_TAGSPLIT str [, array [, countVar]]  (defaults RESULTS / RESULT:0; RESULT = -1 when malformed)
COMMANDS.HTML_TAGSPLIT = (st, fn, vm) => {
  const l: Expr[] = st.arg.a === 'exprs' ? st.arg.list : [];
  const src = compile(l[0], fn, vm);
  const dest = l[1] && l[1].k === 'var' ? refOf(l[1], fn, vm) : null;
  const num = l[2] && l[2].k === 'var' ? refOf(l[2], fn, vm) : null;
  return (fr) => {
    const parts = htmlTagSplit(String(src(fr)));
    const setNum = (n: number) => {
      if (num) {
        const { arr, off } = num.locate(fr);
        arr[off] = n;
      } else vm.setResult(n, 0);
    };
    if (!parts) {
      setNum(-1);
      return;
    }
    setNum(parts.length);
    if (dest) {
      const { arr, off } = dest.locate(fr);
      const room = Math.min(parts.length, arr.length - off);
      for (let i = 0; i < room; i++) arr[off + i] = parts[i];
    } else {
      const r = vm.global('RESULTS');
      for (let i = 0; i < Math.min(parts.length, r.length); i++) r[i] = parts[i];
    }
  };
};

def('HTML_SUBSTRING', (vm, a) => {
  const [x, y] = htmlSubString(vm, String(a[0]), Number(a[1]));
  const r = vm.global('RESULTS');
  r[0] = x;
  if (r.length > 1) r[1] = y;
  return x;
});
def('HTML_GETPRINTEDSTR', (vm, a) => {
  const n = a.length ? Number(a[0]) : 0;
  if (n < 0) throw new EmueraError(`HTML_GETPRINTEDSTR: argument 1 must not be negative (${n})`);
  return vm.host.htmlLine ? vm.host.htmlLine(n) : '';
});
def('HTML_POPPRINTINGSTR', (vm) => (vm.host.popPendingHtml ? vm.host.popPendingHtml() : ''));
def('GETDISPLAYLINE', (vm, a) => (vm.host.displayLine ? vm.host.displayLine(Number(a[0])) : ''));

COMMANDS.HTML_PRINT_ISLAND = (st, fn, vm) => {
  const l: Expr[] = st.arg.a === 'exprs' ? st.arg.list : [];
  const e = l[0] ? compile(l[0], fn, vm) : () => '';
  const ly = l[1] ? compile(l[1], fn, vm) : null; // optional layer (Emuera.NET HTML_PRINT_ISLAND html, layer; EM+EE accepts and ignores it)
  return (fr) => {
    if (vm.system.skipDisp) return;
    if (vm.host.island) vm.host.island(String(e(fr)), ly ? Number(ly(fr)) : undefined);
    else vm.host.note('HTML_PRINT_ISLAND is not supported by this host');
  };
};
COMMANDS.HTML_PRINT_ISLAND_CLEAR = (st, fn, vm) => {
  const l: Expr[] = st.arg.a === 'exprs' ? st.arg.list : [];
  const ly = l[0] ? compile(l[0], fn, vm) : null; // Emuera.NET: HTML_PRINT_ISLAND_CLEAR [layer]; no argument clears every layer
  return (fr) => {
    vm.host.clearIsland?.(ly ? Number(ly(fr)) : undefined);
  };
};

// ---- HTML text helpers
const unesc = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
def('HTML_ESCAPE', (_, a) =>
  S(a[0])
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;'),
);
// Html2PlainText: tags removed (Regex "<[^<]*>"), then entities unescaped
def('HTML_TOPLAINTEXT', (_, a) => unesc(S(a[0]).replace(/<[^<]*>/g, '')));
// HTML_STRINGLEN(html [, pixels]): the width of the first line. Default: half-width cells (width*2/FontSize, rounded up); with a non-zero 2nd argument the raw width.
// The browser has no GDI measurement, so width = columns * FontSize / 2 (full-width characters 2 columns, <img> one full-width cell), as for a monospace font.
def('HTML_STRINGLEN', (vm, a) => {
  const fs = Number(configValue(vm.config, 'FontSize') ?? 18) || 18;
  const first = S(a[0]).split(/<br\s*\/?>/i)[0];
  let cols = 0;
  const re = /<img\b[^>]*>|<[^>]*>|&[a-zA-Z0-9#]+;|[\s\S]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(first))) {
    const t = m[0];
    if (/^<img/i.test(t)) cols += 2;
    else if (t.length > 1 && t[0] === '<') continue;
    else cols += t.length > 1 && t[0] === '&' ? 1 : t.charCodeAt(0) > 0xff ? 2 : 1;
  }
  const px = (cols * fs) / 2;
  return a[1] === undefined || toNum(a[1]) === 0 ? Math.ceil((2 * px) / fs) : px;
});

/** HTML_STRINGLINES(html, width): how many display lines the markup takes at `width` half-width columns (tags cost nothing, <br> breaks, <img> counts as one full-width cell) */
def('HTML_STRINGLINES', (_, a) => {
  const str = S(a[0]),
    w = Math.max(1, toNum(a[1]));
  if (!str) return 0;
  let lines = 1,
    col = 0;
  const re = /<br\s*\/?>|<img\b[^>]*>|<[^>]*>|&[a-zA-Z0-9#]+;|[\s\S]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str))) {
    const t = m[0];
    if (/^<br/i.test(t)) {
      lines++;
      col = 0;
      continue;
    }
    if (t.length > 1 && t[0] === '<' && !/^<img/i.test(t)) continue;
    const cw = /^<img/i.test(t) ? 2 : t.length > 1 && t[0] === '&' ? 1 : t.charCodeAt(0) > 0xff ? 2 : 1;
    if (col + cw > w) {
      lines++;
      col = 0;
    }
    col += cw;
  }
  return lines;
});

COMMANDS.HTML_PRINT = (st, fn, vm) => {
  const l = exprs(st).map((e) => compile(e, fn, vm));
  return (fr) => {
    if (vm.system.skipDisp) return;
    vm.host.html(asStr(l[0](fr)), l[1] ? toNum(l[1](fr)) !== 0 : false);
  };
};
