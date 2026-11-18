/**
 * .NET regular expression source -> JavaScript RegExp. Emuera hands STRCOUNT / REPLACE / REGEXPMATCH / the array searches to System.Text.RegularExpressions,
 * so games write .NET syntax. The part JavaScript lacks that games actually use is the inline option group:
 *   `(?i)^uni|^usa`   a flag group with no body: applies from there to the end of the enclosing group (to the end of the pattern at top level)
 *   `(?i:abc)`        a flag group with a body
 * Flags i, m, s are mapped (x, n are dropped: JS has no equivalent, so a pattern that needs `x` is left as written). A group at the very start of the pattern
 * becomes a RegExp flag, which every engine accepts. One further inside the pattern is rewritten to the `(?i:...)` modifier form when this engine has it,
 * and otherwise applied to the whole pattern (the closest a RegExp can come). `\A`, `\Z`, `\z` become `^` and `$`.
 */
const FLAG_GROUP = /^\(\?([imsxn]*)(?:-([imsxn]+))?([:)])/;

function modifiersSupported(): boolean {
  try {
    new RegExp('(?i:a)');
    return true;
  } catch {
    return false;
  }
}
let modifiers: boolean | undefined;

export function netRegex(src: string, flags = ''): RegExp {
  const add = new Set(flags.split(''));
  let p = src;
  // leading option groups, possibly several: (?i)(?s)...
  for (;;) {
    const m = FLAG_GROUP.exec(p);
    if (!m || m[3] !== ')') break;
    for (const f of m[1]) if ('ims'.includes(f)) add.add(f);
    for (const f of m[2] ?? '') add.delete(f);
    p = p.slice(m[0].length);
  }
  p = p.replace(/\\A/g, '^').replace(/\\[Zz]/g, '$');
  // option groups later in the pattern
  if (/\(\?[imsxn-]/.test(p)) {
    modifiers ??= modifiersSupported();
    let out = '',
      depth = 0;
    const open: number[] = [];
    let i = 0,
      inClass = false;
    const pending: number[] = []; // for each open group, how many bodiless flag groups it must close
    pending.push(0);
    while (i < p.length) {
      const c = p[i];
      if (c === '\\') {
        out += c + (p[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (inClass) {
        if (c === ']') inClass = false;
        out += c;
        i++;
        continue;
      }
      if (c === '[') {
        inClass = true;
        out += c;
        i++;
        continue;
      }
      if (c === '(') {
        const m = FLAG_GROUP.exec(p.slice(i));
        if (m && /[imsxn]/.test(m[1] + (m[2] ?? ''))) {
          const on = [...m[1]].filter((f) => 'ims'.includes(f)).join(''),
            off = [...(m[2] ?? '')].filter((f) => 'ims'.includes(f)).join('');
          if (!on && !off) {
            i += m[0].length;
            continue;
          }
          if (!modifiers) {
            for (const f of on) add.add(f);
            i += m[0].length;
            if (m[3] === ':') {
              out += '(?:';
              pending.push(0);
              open.push(0);
              depth++;
            }
            continue;
          }
          const mod = `(?${on}${off ? '-' + off : ''}:`;
          out += mod;
          i += m[0].length;
          if (m[3] === ')')
            pending[pending.length - 1]++; // bodiless: runs to the end of the enclosing group
          else {
            pending.push(0);
            open.push(1);
            depth++;
          }
          continue;
        }
        pending.push(0);
        open.push(0);
        depth++;
        out += c;
        i++;
        continue;
      }
      if (c === ')') {
        out += ')'.repeat((pending.pop() ?? 0) + 1);
        open.pop();
        depth--;
        if (!pending.length) pending.push(0);
        i++;
        continue;
      }
      out += c;
      i++;
    }
    out += ')'.repeat(pending.pop() ?? 0);
    p = out;
  }
  return new RegExp(p, [...add].join(''));
}
