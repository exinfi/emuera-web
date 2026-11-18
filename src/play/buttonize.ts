/** Emuera's automatic "[N]" buttons in plain printed text. */
export interface Seg {
  t: string;
  v?: string;
  c?: number;
  img?: unknown;
  b?: number;
  f?: string;
  i?: number;
  s?: number;
  u?: number;
  al?: string;
  tip?: string;
  nb?: boolean;
  div?: unknown;
  sp?: unknown;
  rc?: unknown;
  pos?: number;
  nw?: boolean;
}
interface Prim {
  str: string;
  can: boolean;
  input: string;
}

const numReg = /\[\s*(0[xXbB])?[+-]?[0-9]+([eEpP][0-9]+)?\s*\]/;
const isWs = (c: string) => c === ' ' || c === '\t' || c === '　';

function buttonCore(s: string): string | null {
  if (s.length < 3 || s[0] !== '[' || s[s.length - 1] !== ']' || !numReg.test(s)) return null;
  const m = /^\s*([+-]?)(0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]+)/.exec(s.slice(1, -1));
  if (!m) return null;
  const n =
    m[2].startsWith('0x') || m[2].startsWith('0X')
      ? parseInt(m[2].slice(2), 16)
      : /^0[bB]/.test(m[2])
        ? parseInt(m[2].slice(2), 2)
        : parseInt(m[2], 10);
  return String(m[1] === '-' ? -n : n);
}

function lex(s: string): string[] | null {
  const out: string[] = [];
  let state = 0,
    start = 0,
    i = 0;
  const reduce = () => {
    if (i === start) return;
    out.push(s.slice(start, i));
    start = i;
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '[') {
      if (state === 1) return null;
      reduce();
      state = 1;
      i++;
    } else if (c === ']') {
      if (state !== 1) return null;
      i++;
      reduce();
      state = 0;
    } else if (state === 0 && isWs(c)) {
      reduce();
      while (i < s.length && isWs(s[i])) i++;
      reduce();
    } else i++;
  }
  reduce();
  return out;
}

export function splitButtons(text: string): Prim[] {
  const none = [{ str: text, can: false, input: '' }];
  if (!text.includes('[') || !text.includes(']')) return none;
  const strs = lex(text);
  if (!strs) return none;
  let beforeButton = false,
    afterButton = false,
    count = 0,
    inp = '';
  for (const s of strs) {
    if (!s.length) continue;
    if (isWs(s[0])) continue;
    const b = buttonCore(s);
    if (b !== null) {
      count++;
      inp = b;
      afterButton = false;
    } else {
      afterButton = true;
      if (count === 0) beforeButton = true;
    }
  }
  if (count <= 1) return [{ str: text, can: count >= 1, input: inp }];
  const right = !beforeButton && afterButton,
    left = beforeButton && !afterButton,
    etc = !right && !left;
  const ret: Prim[] = [];
  let buf = '',
    can = false,
    input = '',
    state = 0;
  const reduce = () => {
    if (!buf.length) return;
    ret.push({ str: buf, can, input });
    buf = '';
    can = false;
    input = '';
  };
  for (const s of strs) {
    if (!s.length) continue;
    if (isWs(s[0])) {
      if ((state & 3) === 3 && etc && s.length >= 2) {
        reduce();
        buf += s;
        state = 0;
      } else buf += s;
      continue;
    }
    const b = buttonCore(s);
    if (b !== null) {
      if ((state & 1) === 1 || right) {
        reduce();
        buf += s;
        input = b;
        can = true;
        state = 1;
      } else if (left) {
        buf += s;
        input = b;
        can = true;
        reduce();
        state = 0;
      } else {
        buf += s;
        input = b;
        can = true;
        state = 1;
      }
      continue;
    }
    buf += s;
    state |= 2;
  }
  reduce();
  return ret;
}

/** turn runs of plain text segments into buttons where Emuera would */
export function buttonize(line: Seg[]): Seg[] {
  const out: Seg[] = [];
  let run: Seg[] = [];
  const flush = () => {
    if (!run.length) return;
    const text = run.map((s) => s.t).join('');
    if (!text.includes('[')) {
      out.push(...run);
      run = [];
      return;
    }
    const prims = splitButtons(text);
    if (prims.length === 1 && !prims[0].can) {
      out.push(...run);
      run = [];
      return;
    }
    let ri = 0,
      off = 0; // position inside run[ri]
    for (const p of prims) {
      let need = p.str.length;
      while (need > 0 && ri < run.length) {
        const s = run[ri];
        const take = Math.min(need, s.t.length - off);
        if (take > 0) out.push({ ...s, t: s.t.slice(off, off + take), v: p.can ? p.input : undefined });
        need -= take;
        off += take;
        if (off >= s.t.length) {
          ri++;
          off = 0;
        }
      }
    }
    run = [];
  };
  for (const s of line) {
    if (s.v === undefined && !s.img && !s.sp && !s.rc && !s.al && !s.div && !s.nb && !s.nw) run.push(s);
    else {
      flush();
      out.push(s);
    }
  }
  flush();
  return out;
}
