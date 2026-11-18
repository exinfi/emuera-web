/** Emuera.EM DataTable (DT_*). Rows carry a unique `id` column; DT_SELECT filters use the .NET DataTable expression syntax. */
import { EmueraError, Int, Value } from './value';

export type CellType = 'int' | 'str';
export interface Column {
  name: string;
  type: CellType;
  bits: number;
  nullable: boolean;
  def?: Value;
}
export type Cell = Value | null;

const TYPE_NUM: Record<string, number> = { int8: 1, int16: 2, int32: 3, int64: 4, string: 5 };
export const typeFromArg = (v: Value): number | undefined =>
  typeof v === 'string' ? TYPE_NUM[v.toLowerCase()] : Number(v) >= 1 && Number(v) <= 5 ? Number(v) : undefined;

export class DataTable {
  cols: Column[] = [{ name: 'id', type: 'int', bits: 64, nullable: false }];
  rows: Cell[][] = [];
  caseSensitive = true;
  private nextId = 1;

  colIndex(name: string): number {
    let i = this.cols.findIndex((c) => c.name === name);
    if (i < 0) i = this.cols.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
    return i;
  }
  addColumn(name: string, typeNum: number | undefined, nullable: boolean): boolean {
    if (this.colIndex(name) >= 0) return false;
    const t = typeNum ?? 5;
    this.cols.push({
      name,
      type: t === 5 ? 'str' : 'int',
      bits: t === 1 ? 8 : t === 2 ? 16 : t === 3 ? 32 : 64,
      nullable,
    });
    for (const r of this.rows) r.push(this.defaultFor(this.cols[this.cols.length - 1]));
    return true;
  }
  removeColumn(name: string): boolean {
    const i = this.colIndex(name);
    if (i <= 0) return false;
    this.cols.splice(i, 1);
    for (const r of this.rows) r.splice(i, 1);
    return true;
  }
  typeNum(i: number): number {
    const c = this.cols[i];
    return c.type === 'str' ? 5 : c.bits === 8 ? 1 : c.bits === 16 ? 2 : c.bits === 32 ? 3 : 4;
  }
  defaultFor(c: Column): Cell {
    if (c.def !== undefined) return c.def;
    return c.nullable ? null : c.type === 'str' ? '' : 0;
  }
  clamp(c: Column, v: Int): Int {
    if (c.bits >= 64) return v;
    const lim = 2n ** BigInt(c.bits - 1);
    const b = BigInt(v);
    return Number(b < -lim ? -lim : b > lim - 1n ? lim - 1n : b);
  }
  newRow(): Cell[] {
    const r = this.cols.map((c) => this.defaultFor(c));
    r[0] = this.nextId++;
    return r;
  }
  /** DT_FROMXML: append a row with its stored id (the auto-increment continues after the largest id) */
  /** JSON-able copy (snapshots / save slots) */
  dump() {
    return { cols: this.cols, rows: this.rows, cs: this.caseSensitive, next: this.nextId };
  }
  static load(d: any): DataTable {
    const t = new DataTable();
    t.cols = d.cols;
    t.rows = d.rows;
    t.caseSensitive = d.cs;
    t.nextId = d.next;
    return t;
  }
  /** DataTable.Clear(): rows go, columns stay */
  clearRows(): void {
    this.rows = [];
  }
  restoreRow(cells: Cell[]): void {
    this.rows.push(cells);
    const id = Number(cells[0]);
    if (Number.isFinite(id) && id >= this.nextId) this.nextId = id + 1;
  }
  findId(id: Int): number {
    return this.rows.findIndex((r) => r[0] === id || Number(r[0]) === Number(id));
  }

  // ---- DT_SELECT ----------------------------------------------------------
  select(filter?: string | null, sort?: string | null): Cell[][] {
    let out = this.rows;
    if (filter && filter.trim()) {
      const pred = compileFilter(filter, this);
      out = out.filter((r) => pred(r) === true);
    } else out = [...out];
    if (sort && sort.trim()) {
      const keys = sort.split(',').map((s) => {
        const m = /^\s*(?:\[([^\]]+)\]|(\S+?))\s*(ASC|DESC)?\s*$/i.exec(s);
        if (!m) throw new EmueraError(`DT_SELECT: bad sort rule '${sort}'`);
        const i = this.colIndex(m[1] ?? m[2]);
        if (i < 0) throw new EmueraError(`DT_SELECT: no column '${m[1] ?? m[2]}'`);
        return { i, desc: (m[3] ?? '').toUpperCase() === 'DESC' };
      });
      out = [...out].sort((a, b) => {
        for (const k of keys) {
          const c = this.cmp(a[k.i], b[k.i]);
          if (c) return k.desc ? -c : c;
        }
        return 0;
      });
    }
    return out;
  }
  cmp(a: Cell, b: Cell): number {
    if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
    if (typeof a === 'string' || typeof b === 'string') {
      const x = String(a),
        y = String(b);
      const [p, q] = this.caseSensitive ? [x, y] : [x.toLowerCase(), y.toLowerCase()];
      return p < q ? -1 : p > q ? 1 : 0;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  }
}

// ---------------------------------------------------------------------------
// minimal .NET DataColumn.Expression subset: comparisons, AND/OR/NOT, LIKE, IN, IS [NOT] NULL,
// + - * / %, parentheses, 'strings', numbers, [bracketed] or bare column names.
type Tok = { t: 'num' | 'str' | 'id' | 'op' | 'kw'; v: string };
const KW = new Set(['AND', 'OR', 'NOT', 'LIKE', 'IN', 'IS', 'NULL', 'TRUE', 'FALSE']);

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'") {
      let j = i + 1,
        v = '';
      for (; j < s.length; j++) {
        if (s[j] === "'") {
          if (s[j + 1] === "'") {
            v += "'";
            j++;
            continue;
          }
          break;
        }
        v += s[j];
      }
      out.push({ t: 'str', v });
      i = j + 1;
      continue;
    }
    if (c === '[') {
      const j = s.indexOf(']', i);
      out.push({ t: 'id', v: s.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      out.push({ t: 'id', v: s.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (['<>', '<=', '>=', '!='].includes(two)) {
      out.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('=<>()+-*/%,'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    let j = i;
    while (j < s.length && !/[\s=<>()+\-*/%,'[\]]/.test(s[j])) j++;
    const w = s.slice(i, j);
    if (/^\d+(\.\d+)?$/.test(w)) out.push({ t: 'num', v: w });
    else if (KW.has(w.toUpperCase())) out.push({ t: 'kw', v: w.toUpperCase() });
    else out.push({ t: 'id', v: w });
    i = j;
  }
  return out;
}

type Row = Cell[];
type Ev = (r: Row) => Cell | boolean;

function compileFilter(src: string, dt: DataTable): (r: Row) => Cell | boolean {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isKw = (v: string) => peek()?.t === 'kw' && peek().v === v;
  const isOp = (v: string) => peek()?.t === 'op' && peek().v === v;
  const fail = (m: string): never => {
    throw new EmueraError(`DT_SELECT: ${m} in filter '${src}'`);
  };

  const num = (x: Cell | boolean): number | bigint =>
    typeof x === 'boolean' ? (x ? 1 : 0) : x === null ? 0 : typeof x === 'string' ? Number(x) : x;
  const like = (v: string, pat: string): boolean => {
    const rx = new RegExp(
      '^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[%*]/g, '.*') + '$',
      dt.caseSensitive ? 's' : 'is',
    );
    return rx.test(v);
  };

  function orE(): Ev {
    let l = andE();
    while (isKw('OR')) {
      p++;
      const a = l,
        b = andE();
      l = (r) => a(r) === true || b(r) === true;
    }
    return l;
  }
  function andE(): Ev {
    let l = notE();
    while (isKw('AND')) {
      p++;
      const a = l,
        b = notE();
      l = (r) => a(r) === true && b(r) === true;
    }
    return l;
  }
  function notE(): Ev {
    if (isKw('NOT')) {
      p++;
      const a = notE();
      return (r) => a(r) !== true;
    }
    return cmpE();
  }
  function cmpE(): Ev {
    const l = addE();
    const t = peek();
    if (t?.t === 'op' && ['=', '<>', '!=', '<', '>', '<=', '>='].includes(t.v)) {
      p++;
      const r2 = addE();
      return (row) => {
        const a = l(row),
          b = r2(row);
        if (a === null || b === null) return false;
        const c =
          typeof a === 'string' || typeof b === 'string'
            ? dt.cmp(String(a), String(b))
            : ((x, y) => (x < y ? -1 : x > y ? 1 : 0))(num(a), num(b));
        switch (t.v) {
          case '=':
            return c === 0;
          case '<>':
          case '!=':
            return c !== 0;
          case '<':
            return c < 0;
          case '>':
            return c > 0;
          case '<=':
            return c <= 0;
          default:
            return c >= 0;
        }
      };
    }
    if (t?.t === 'kw' && (t.v === 'LIKE' || (t.v === 'NOT' && toks[p + 1]?.v === 'LIKE'))) {
      const neg = t.v === 'NOT';
      p += neg ? 2 : 1;
      const r2 = addE();
      return (row) => {
        const a = l(row),
          b = r2(row);
        if (a === null || b === null) return false;
        const m = like(String(a), String(b));
        return neg ? !m : m;
      };
    }
    if (t?.t === 'kw' && (t.v === 'IN' || (t.v === 'NOT' && toks[p + 1]?.v === 'IN'))) {
      const neg = t.v === 'NOT';
      p += neg ? 2 : 1;
      if (!isOp('(')) fail('expected ( after IN');
      p++;
      const items: Ev[] = [];
      while (!isOp(')')) {
        items.push(addE());
        if (isOp(',')) p++;
        else if (!isOp(')')) fail('bad IN list');
      }
      p++;
      return (row) => {
        const a = l(row);
        const hit = items.some((e) => {
          const b = e(row);
          return (
            a !== null &&
            b !== null &&
            (typeof a === 'string' || typeof b === 'string' ? dt.cmp(String(a), String(b)) === 0 : num(a) === num(b))
          );
        });
        return neg ? !hit : hit;
      };
    }
    if (isKw('IS')) {
      p++;
      let neg = false;
      if (isKw('NOT')) {
        p++;
        neg = true;
      }
      if (!isKw('NULL')) fail('expected NULL');
      p++;
      return (row) => {
        const isNull = l(row) === null;
        return neg ? !isNull : isNull;
      };
    }
    return l;
  }
  function addE(): Ev {
    let l = mulE();
    while (isOp('+') || isOp('-')) {
      const op = peek().v;
      p++;
      const a = l,
        b = mulE();
      l = (r) => {
        const x = a(r),
          y = b(r);
        if (op === '+' && (typeof x === 'string' || typeof y === 'string')) return String(x ?? '') + String(y ?? '');
        if (x === null || y === null) return null;
        return op === '+' ? Number(num(x)) + Number(num(y)) : Number(num(x)) - Number(num(y));
      };
    }
    return l;
  }
  function mulE(): Ev {
    let l = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = peek().v;
      p++;
      const a = l,
        b = unary();
      l = (r) => {
        const x = a(r),
          y = b(r);
        if (x === null || y === null) return null;
        const m = Number(num(x)),
          n = Number(num(y));
        return op === '*' ? m * n : op === '/' ? m / n : m % n;
      };
    }
    return l;
  }
  function unary(): Ev {
    if (isOp('-')) {
      p++;
      const a = unary();
      return (r) => {
        const x = a(r);
        return x === null ? null : -Number(num(x));
      };
    }
    return primary();
  }
  function primary(): Ev {
    const t = toks[p++];
    if (!t) return fail('unexpected end');
    if (t.t === 'op' && t.v === '(') {
      const e = orE();
      if (!isOp(')')) fail('missing )');
      p++;
      return e;
    }
    if (t.t === 'num') {
      const v = t.v.includes('.') ? Number(t.v) : Number(t.v);
      return () => v;
    }
    if (t.t === 'str') {
      const v = t.v;
      return () => v;
    }
    if (t.t === 'kw' && (t.v === 'TRUE' || t.v === 'FALSE')) {
      const v = t.v === 'TRUE';
      return () => v;
    }
    if (t.t === 'kw' && t.v === 'NULL') return () => null;
    if (t.t === 'id') {
      const i = dt.colIndex(t.v);
      if (i < 0) return fail(`unknown column '${t.v}'`);
      return (r) => r[i];
    }
    return fail(`unexpected '${t.v}'`);
  }
  const e = orE();
  if (p < toks.length) fail(`unexpected '${toks[p].v}'`);
  return e;
}
