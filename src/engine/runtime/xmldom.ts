/**
 * System.Xml.XmlDocument stand-in for the XML_* built-ins (workers have no DOMParser): a mutable DOM with attribute nodes, .NET-style
 * serialisation (OuterXml / InnerXml / InnerText) and an XPath 1.0 evaluator for XmlNode.SelectNodes.
 * Behaviours copied from XmlDocument that games can observe:
 *  - LoadXml drops whitespace-only text nodes (PreserveWhitespace = false);
 *  - `<a/>` serialises as `<a />` while `<a></a>` keeps both tags (XmlElement.IsEmpty);
 *  - an attribute's ParentNode is null (so XML_REMOVENODE / XML_REPLACE cannot act on one), its OwnerElement is the element;
 *  - the document node's Value is null and an element's Value is null (setting it throws InvalidOperationException).
 */
import { parseXml, XNode, xEscape } from './xml';

export type DNode = DocNode | ElNode | AttrNode | TextNode;
export interface DocNode {
  t: 'doc';
  kids: (ElNode | TextNode)[];
  decl?: string;
  parent: null;
}
export interface ElNode {
  t: 'el';
  name: string;
  attrs: AttrNode[];
  kids: (ElNode | TextNode)[];
  empty: boolean;
  parent: DocNode | ElNode | null;
}
export interface AttrNode {
  t: 'attr';
  name: string;
  value: string;
  owner: ElNode | null;
  parent: null;
}
export interface TextNode {
  t: 'text';
  value: string;
  parent: DocNode | ElNode | null;
}

export class XPathError extends Error {}
export class DomError extends Error {}

// ------------------------------------------------------------------ build / serialise
const attrEsc = (s: string) =>
  s.replace(
    /[&<>"\n\r\t]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\n': '&#xA;', '\r': '&#xD;', '\t': '&#x9;' })[c]!,
  );

function fromX(x: XNode, parent: DocNode | ElNode): ElNode {
  const el: ElNode = { t: 'el', name: x.name, attrs: [], kids: [], empty: !!x.selfClosed, parent };
  for (const [n, v] of x.attrs) el.attrs.push({ t: 'attr', name: n, value: v, owner: el, parent: null });
  for (const k of x.kids) {
    if (typeof k !== 'string') {
      el.kids.push(fromX(k, el));
      continue;
    }
    const last = el.kids[el.kids.length - 1];
    if (last && last.t === 'text') last.value += k;
    else el.kids.push({ t: 'text', value: k, parent: el });
  }
  el.kids = el.kids.filter((k) => k.t !== 'text' || k.value.trim() !== '');
  return el;
}
/** XmlDocument.LoadXml; throws XmlError for malformed input */
export function loadXml(src: string): DocNode {
  const root = parseXml(src);
  const doc: DocNode = { t: 'doc', kids: [], parent: null };
  const m = /^﻿?\s*<\?xml\s+([^?]*)\?>/.exec(src);
  if (m) doc.decl = `<?xml ${m[1].trim().replace(/'/g, '"')}?>`;
  for (const k of root.kids) if (typeof k !== 'string') doc.kids.push(fromX(k, doc));
  return doc;
}

export function outerXml(n: DNode): string {
  switch (n.t) {
    case 'doc':
      return (n.decl ?? '') + n.kids.map(outerXml).join('');
    case 'text':
      return xEscape(n.value);
    case 'attr':
      return `${n.name}="${attrEsc(n.value)}"`;
    case 'el': {
      const a = n.attrs.map((x) => ` ${outerXml(x)}`).join('');
      if (n.kids.length === 0 && n.empty) return `<${n.name}${a} />`;
      return `<${n.name}${a}>${n.kids.map(outerXml).join('')}</${n.name}>`;
    }
  }
}
export function innerXml(n: DNode): string {
  if (n.t === 'text') return '';
  if (n.t === 'attr') return xEscape(n.value);
  return n.kids.map(outerXml).join('');
}
export function innerText(n: DNode): string {
  if (n.t === 'text') return n.value;
  if (n.t === 'attr') return n.value;
  return n.kids.map(innerText).join('');
}
/** XmlNode.Value: null (reported as "") for document and element nodes */
export const nodeValue = (n: DNode): string | null => (n.t === 'text' ? n.value : n.t === 'attr' ? n.value : null);
export const nodeName = (n: DNode): string => (n.t === 'doc' ? '#document' : n.t === 'text' ? '#text' : n.name);

// ------------------------------------------------------------------ mutation (XmlNode members)
const kidsOf = (p: DocNode | ElNode) => p.kids;
export function detach(n: ElNode | TextNode): void {
  if (!n.parent) return;
  const k = kidsOf(n.parent),
    i = k.indexOf(n);
  if (i >= 0) k.splice(i, 1);
  n.parent = null;
}
function checkInsert(parent: DocNode | ElNode, c: ElNode | TextNode, replacing?: ElNode | TextNode): void {
  if (parent.t === 'doc' && (c.t === 'text' || parent.kids.some((k) => k.t === 'el' && k !== c && k !== replacing)))
    throw new DomError("This document already has a 'DocumentElement' node.");
  for (let p: DocNode | ElNode | null = parent; p; p = p.parent)
    if (p === c) throw new DomError('Cannot insert the node in the specified location (it is an ancestor).');
}
export function appendChild(p: DocNode | ElNode, c: ElNode | TextNode): void {
  checkInsert(p, c);
  detach(c);
  p.kids.push(c);
  c.parent = p;
  if (p.t === 'el') p.empty = false;
}
export function insertAt(ref: ElNode | TextNode, c: ElNode | TextNode, after: boolean): void {
  const p = ref.parent!;
  checkInsert(p, c);
  if (c === ref) return;
  detach(c);
  const i = p.kids.indexOf(ref);
  p.kids.splice(after ? i + 1 : i, 0, c);
  c.parent = p;
  if (p.t === 'el') p.empty = false;
}
export function replaceChild(newNode: ElNode | TextNode, old: ElNode | TextNode): void {
  const p = old.parent!;
  if (newNode === old) return;
  checkInsert(p, newNode, old);
  detach(newNode);
  const i = p.kids.indexOf(old);
  p.kids[i] = newNode;
  newNode.parent = p;
  old.parent = null;
}
export function removeNode(n: ElNode | TextNode): boolean {
  if (!n.parent) return false;
  detach(n);
  return true;
}
export function appendAttr(el: ElNode, a: AttrNode): void {
  if (a.owner && a.owner !== el) throw new DomError('The node is already an attribute of another element.');
  const i = el.attrs.findIndex((x) => x.name === a.name);
  if (i >= 0) {
    el.attrs[i].owner = null;
    el.attrs[i] = a;
  } else el.attrs.push(a);
  a.owner = el;
}
export function insertAttr(ref: AttrNode, a: AttrNode, after: boolean): void {
  const el = ref.owner!;
  if (a === ref) return;
  const old = el.attrs.findIndex((x) => x.name === a.name && x !== a);
  if (old >= 0) {
    el.attrs[old].owner = null;
    el.attrs.splice(old, 1);
  }
  const cur = el.attrs.indexOf(a);
  if (cur >= 0) el.attrs.splice(cur, 1);
  const i = el.attrs.indexOf(ref);
  el.attrs.splice(after ? i + 1 : i, 0, a);
  a.owner = el;
}
export function removeAttr(a: AttrNode): boolean {
  const el = a.owner;
  if (!el) return false;
  el.attrs.splice(el.attrs.indexOf(a), 1);
  a.owner = null;
  return true;
}

/** XmlNode.Value = v */
export function setValue(n: DNode, v: string): void {
  if (n.t === 'attr' || n.t === 'text') {
    n.value = v;
    return;
  }
  throw new DomError(`Cannot set a value on node type '${n.t === 'doc' ? 'Document' : 'Element'}'.`);
}
/** XmlNode.InnerText = v */
export function setInnerText(n: DNode, v: string): void {
  if (n.t === 'attr' || n.t === 'text') {
    n.value = v;
    return;
  }
  if (n.t === 'doc') throw new DomError('The document node cannot have an InnerText.');
  for (const k of n.kids) k.parent = null;
  n.kids = v === '' ? [] : [{ t: 'text', value: v, parent: n }];
  if (v !== '') n.empty = false;
}
/** XmlNode.InnerXml = v (the fragment is parsed inside the node) */
export function setInnerXml(n: DNode, v: string): void {
  if (n.t === 'attr') {
    n.value = v.replace(
      /&(amp|lt|gt|quot|apos);/g,
      (_m, g: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[g]!,
    );
    return;
  }
  if (n.t !== 'el') throw new DomError('Cannot set InnerXml on this node type.');
  const frag = loadXml(`<x>${v}</x>`).kids[0] as ElNode;
  for (const k of n.kids) k.parent = null;
  n.kids = frag.kids;
  for (const k of n.kids) k.parent = n;
  if (n.kids.length) n.empty = false;
}
/** XmlDocument.CreateNode(...) + copy of attributes and InnerXml, as the add / replace built-ins do */
export function cloneShallowWithInner(src: ElNode, into: DocNode): ElNode {
  const el: ElNode = { t: 'el', name: src.name, attrs: [], kids: [], empty: true, parent: null };
  for (const a of src.attrs) el.attrs.push({ t: 'attr', name: a.name, value: a.value, owner: el, parent: null });
  setInnerXml(el, innerXml(src));
  void into;
  return el;
}

// ------------------------------------------------------------------ document order
function pathOf(n: DNode): number[] {
  const out: number[] = [];
  let cur: DNode = n;
  for (;;) {
    if (cur.t === 'attr') {
      const o = cur.owner!;
      out.push(-1 - 0, o.attrs.indexOf(cur));
      cur = o;
      continue;
    }
    const p = cur.parent;
    if (!p) break;
    out.push(p.kids.indexOf(cur as ElNode | TextNode));
    cur = p;
  }
  return out.reverse();
}
function sortDoc(ns: DNode[]): DNode[] {
  const seen = new Set<DNode>(),
    uniq = ns.filter((n) => !seen.has(n) && seen.add(n));
  const keyed = uniq.map((n) => ({ n, p: pathOf(n) }));
  keyed.sort((a, b) => {
    for (let i = 0; i < Math.min(a.p.length, b.p.length); i++) if (a.p[i] !== b.p[i]) return a.p[i] - b.p[i];
    return a.p.length - b.p.length;
  });
  return keyed.map((k) => k.n);
}

// ------------------------------------------------------------------ XPath 1.0
type Tok = { k: 'num' | 'lit' | 'name' | 'op'; v: string };
type Val = DNode[] | string | number | boolean;
type Axis =
  | 'child'
  | 'descendant'
  | 'descendant-or-self'
  | 'parent'
  | 'ancestor'
  | 'ancestor-or-self'
  | 'following-sibling'
  | 'preceding-sibling'
  | 'following'
  | 'preceding'
  | 'attribute'
  | 'self';
type Test = { k: 'name'; name: string } | { k: 'any' } | { k: 'node' } | { k: 'text' } | { k: 'comment' } | { k: 'pi' };
type Step = { axis: Axis; test: Test; preds: Ex[] };
type Ex =
  | { k: 'num'; v: number }
  | { k: 'lit'; v: string }
  | { k: 'path'; abs: boolean; start?: Ex; steps: Step[] }
  | { k: 'bin'; op: string; a: Ex; b: Ex }
  | { k: 'neg'; a: Ex }
  | { k: 'union'; a: Ex; b: Ex }
  | { k: 'fn'; name: string; args: Ex[] }
  | { k: 'filter'; e: Ex; preds: Ex[] };

const NAME_START = /[A-Za-z_À-￿]/,
  NAME_CHAR = /[A-Za-z0-9_.\-·À-￿]/;
function tokenize(src: string): Tok[] {
  const t: Tok[] = [];
  let i = 0;
  // XPath 1.0 lexical rule: `*` is the multiply operator only when the previous token ends an operand
  const prevIsOperand = () => {
    const p = t[t.length - 1];
    return !!p && (p.k !== 'op' || p.v === ')' || p.v === ']' || p.v === '.' || p.v === '..');
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const j = src.indexOf(c, i + 1);
      if (j < 0) throw new XPathError('unterminated string literal');
      t.push({ k: 'lit', v: src.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^\d*\.?\d*/.exec(src.slice(i))![0];
      t.push({ k: 'num', v: m });
      i += m.length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['//', '::', '..', '!=', '<=', '>='].includes(two)) {
      t.push({ k: 'op', v: two });
      i += 2;
      continue;
    }
    if ('/()[]@,|+-=<>*.'.includes(c)) {
      // `*` after an operand is multiplication; elsewhere it is the wildcard name test
      if (c === '*' && !prevIsOperand()) {
        t.push({ k: 'name', v: '*' });
        i++;
        continue;
      }
      t.push({ k: 'op', v: c });
      i++;
      continue;
    }
    if (NAME_START.test(c)) {
      let j = i + 1;
      while (j < src.length && (NAME_CHAR.test(src[j]) || (src[j] === ':' && src[j + 1] !== ':' && src[j - 1] !== ':')))
        j++;
      let name = src.slice(i, j);
      if (name.endsWith(':*') === false && src[j] === ':' && src[j + 1] === '*') {
        name += ':*';
        j += 2;
      }
      t.push({ k: 'name', v: name });
      i = j;
      continue;
    }
    throw new XPathError(`unexpected character '${c}'`);
  }
  return t;
}

const AXES = new Set<string>([
  'child',
  'descendant',
  'descendant-or-self',
  'parent',
  'ancestor',
  'ancestor-or-self',
  'following-sibling',
  'preceding-sibling',
  'following',
  'preceding',
  'attribute',
  'self',
]);
function parseXPath(src: string): Ex {
  const toks = tokenize(src);
  let p = 0;
  const peek = (o = 0) => toks[p + o];
  const isOp = (v: string, o = 0) => {
    const x = peek(o);
    return !!x && x.k === 'op' && x.v === v;
  };
  const isOpName = (v: string) => {
    const x = peek();
    return !!x && x.k === 'name' && x.v === v && p > 0;
  };
  const eat = (v: string) => {
    if (!isOp(v)) throw new XPathError(`'${v}' expected`);
    p++;
  };
  const bin = (sub: () => Ex, ops: string[], names: string[] = []): Ex => {
    let a = sub();
    for (;;) {
      const x = peek();
      if (x && ((x.k === 'op' && ops.includes(x.v)) || (x.k === 'name' && names.includes(x.v) && p > 0))) {
        p++;
        a = { k: 'bin', op: x.v, a, b: sub() };
      } else return a;
    }
  };
  const or = (): Ex => bin(and, [], ['or']);
  const and = (): Ex => bin(eq, [], ['and']);
  const eq = (): Ex => bin(rel, ['=', '!=']);
  const rel = (): Ex => bin(add, ['<', '<=', '>', '>=']);
  const add = (): Ex => bin(mul, ['+', '-']);
  const mul = (): Ex => bin(unary, ['*'], ['div', 'mod']);
  const unary = (): Ex => {
    if (isOp('-')) {
      p++;
      return { k: 'neg', a: unary() };
    }
    return union();
  };
  const union = (): Ex => {
    let a = pathExpr();
    while (isOp('|')) {
      p++;
      a = { k: 'union', a, b: pathExpr() };
    }
    return a;
  };
  const preds = (): Ex[] => {
    const l: Ex[] = [];
    while (isOp('[')) {
      p++;
      l.push(or());
      eat(']');
    }
    return l;
  };
  const nodeTypeTest = (n: string) => ['node', 'text', 'comment', 'processing-instruction'].includes(n);
  const startsFilter = () => {
    const x = peek();
    if (!x) return false;
    if (x.k === 'num' || x.k === 'lit') return true;
    if (x.k === 'op' && x.v === '(') return true;
    return x.k === 'name' && isOp('(', 1) && !nodeTypeTest(x.v);
  };
  const pathExpr = (): Ex => {
    if (startsFilter()) {
      let e = primary();
      const ps = preds();
      if (ps.length) e = { k: 'filter', e, preds: ps };
      if (isOp('/') || isOp('//')) {
        const dbl = peek().v === '//';
        p++;
        return { k: 'path', abs: false, start: e, steps: [...(dbl ? [descSelf()] : []), ...relSteps()] };
      }
      return e;
    }
    if (isOp('/')) {
      p++;
      const x = peek();
      const more = x && (x.k === 'name' || isOp('@') || isOp('.') || isOp('..'));
      return { k: 'path', abs: true, steps: more ? relSteps() : [] };
    }
    if (isOp('//')) {
      p++;
      return { k: 'path', abs: true, steps: [descSelf(), ...relSteps()] };
    }
    return { k: 'path', abs: false, steps: relSteps() };
  };
  const descSelf = (): Step => ({ axis: 'descendant-or-self', test: { k: 'node' }, preds: [] });
  const relSteps = (): Step[] => {
    const l = [step()];
    while (isOp('/') || isOp('//')) {
      const dbl = peek().v === '//';
      p++;
      if (dbl) l.push(descSelf());
      l.push(step());
    }
    return l;
  };
  const step = (): Step => {
    if (isOp('.')) {
      p++;
      return { axis: 'self', test: { k: 'node' }, preds: [] };
    }
    if (isOp('..')) {
      p++;
      return { axis: 'parent', test: { k: 'node' }, preds: [] };
    }
    let axis: Axis = 'child';
    if (isOp('@')) {
      p++;
      axis = 'attribute';
    } else if (peek()?.k === 'name' && isOp('::', 1)) {
      const a = peek().v;
      if (!AXES.has(a)) throw new XPathError(`unknown axis '${a}'`);
      axis = a as Axis;
      p += 2;
    }
    const x = peek();
    if (!x || x.k !== 'name') throw new XPathError('node test expected');
    p++;
    let test: Test;
    if (isOp('(') && nodeTypeTest(x.v)) {
      p++;
      if (x.v === 'processing-instruction' && peek()?.k === 'lit') p++;
      eat(')');
      test =
        x.v === 'node'
          ? { k: 'node' }
          : x.v === 'text'
            ? { k: 'text' }
            : x.v === 'comment'
              ? { k: 'comment' }
              : { k: 'pi' };
    } else test = x.v === '*' ? { k: 'any' } : { k: 'name', name: x.v };
    return { axis, test, preds: preds() };
  };
  const primary = (): Ex => {
    const x = peek();
    if (x.k === 'num') {
      p++;
      return { k: 'num', v: parseFloat(x.v) };
    }
    if (x.k === 'lit') {
      p++;
      return { k: 'lit', v: x.v };
    }
    if (isOp('(')) {
      p++;
      const e = or();
      eat(')');
      return e;
    }
    p++;
    eat('(');
    const args: Ex[] = [];
    if (!isOp(')'))
      for (;;) {
        args.push(or());
        if (isOp(',')) {
          p++;
          continue;
        }
        break;
      }
    eat(')');
    return { k: 'fn', name: x.v, args };
  };
  void isOpName;
  const e = or();
  if (p < toks.length) throw new XPathError(`unexpected '${toks[p].v}'`);
  return e;
}

interface Ctx {
  node: DNode;
  pos: number;
  size: number;
}
const isNodes = (v: Val): v is DNode[] => Array.isArray(v);
export function numToStr(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (!Number.isFinite(n)) return n < 0 ? '-Infinity' : 'Infinity';
  if (Number.isInteger(n)) return Object.is(n, -0) ? '0' : Math.abs(n) < 1e21 ? n.toString() : BigInt(n).toString();
  let s = n.toString();
  if (/e/i.test(s)) s = n.toFixed(20).replace(/0+$/, '');
  return s;
}
const strOf = (v: Val): string =>
  isNodes(v)
    ? v.length
      ? stringValue(sortDoc(v)[0])
      : ''
    : typeof v === 'boolean'
      ? v
        ? 'true'
        : 'false'
      : typeof v === 'number'
        ? numToStr(v)
        : v;
const stringValue = (n: DNode): string => innerText(n);
const strToNum = (s: string): number => {
  const t = s.trim();
  return /^-?(\d+\.?\d*|\.\d+)$/.test(t) ? parseFloat(t) : NaN;
};
const numOf = (v: Val): number =>
  typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : strToNum(strOf(v));
const boolOf = (v: Val): boolean =>
  isNodes(v)
    ? v.length > 0
    : typeof v === 'boolean'
      ? v
      : typeof v === 'number'
        ? v !== 0 && !Number.isNaN(v)
        : v.length > 0;

function cmp(op: string, a: Val, b: Val): boolean {
  const rel = (x: number | string | boolean, y: number | string | boolean): boolean => {
    if (op === '=' || op === '!=') {
      let r: boolean;
      if (typeof x === 'boolean' || typeof y === 'boolean') r = boolOf(x) === boolOf(y);
      else if (typeof x === 'number' || typeof y === 'number') r = numOf(x) === numOf(y);
      else r = x === y;
      return op === '=' ? r : !r;
    }
    const m = numOf(x),
      n = numOf(y);
    return op === '<' ? m < n : op === '<=' ? m <= n : op === '>' ? m > n : m >= n;
  };
  if (isNodes(a) && isNodes(b)) return a.some((x) => b.some((y) => rel(stringValue(x), stringValue(y))));
  if (isNodes(a)) {
    if (typeof b === 'boolean') return rel(boolOf(a), b);
    return a.some((x) => rel(typeof b === 'number' ? numOf(stringValue(x)) : stringValue(x), b as number | string));
  }
  if (isNodes(b)) {
    if (typeof a === 'boolean') return rel(a, boolOf(b));
    return b.some((y) => rel(a as number | string, typeof a === 'number' ? numOf(stringValue(y)) : stringValue(y)));
  }
  return rel(a, b);
}

function axisNodes(axis: Axis, n: DNode): DNode[] {
  const out: DNode[] = [];
  const kids = (x: DNode): DNode[] => (x.t === 'doc' || x.t === 'el' ? x.kids : []);
  const desc = (x: DNode) => {
    for (const k of kids(x)) {
      out.push(k);
      desc(k);
    }
  };
  switch (axis) {
    case 'child':
      return [...kids(n)];
    case 'descendant':
      desc(n);
      return out;
    case 'descendant-or-self':
      out.push(n);
      desc(n);
      return out;
    case 'self':
      return [n];
    case 'attribute':
      return n.t === 'el' ? [...n.attrs] : [];
    case 'parent': {
      const p = n.t === 'attr' ? n.owner : n.parent;
      return p ? [p] : [];
    }
    case 'ancestor':
    case 'ancestor-or-self': {
      if (axis === 'ancestor-or-self') out.push(n);
      for (let p = n.t === 'attr' ? n.owner : n.parent; p; p = p.parent) out.push(p);
      return out;
    }
    case 'following-sibling':
    case 'preceding-sibling': {
      if (n.t === 'attr' || n.t === 'doc' || !n.parent) return [];
      const k = n.parent.kids,
        i = k.indexOf(n);
      return axis === 'following-sibling' ? k.slice(i + 1) : k.slice(0, i).reverse();
    }
    case 'following':
    case 'preceding': {
      let cur: DNode = n.t === 'attr' ? n.owner! : n;
      const res: DNode[] = [];
      while (cur.t !== 'doc' && cur.parent) {
        const sib = cur.parent.kids,
          i = sib.indexOf(cur as ElNode | TextNode);
        if (axis === 'following')
          for (const s of sib.slice(i + 1)) {
            res.push(s);
            const o = out.length;
            desc(s);
            res.push(...out.splice(o));
          }
        else
          for (const s of sib.slice(0, i).reverse()) {
            const o = out.length;
            desc(s);
            const d = out.splice(o).reverse();
            res.push(...d, s);
          }
        cur = cur.parent;
      }
      return res;
    }
  }
}
function testNode(test: Test, axis: Axis, n: DNode): boolean {
  if (test.k === 'node') return true;
  if (test.k === 'text') return n.t === 'text';
  if (test.k === 'comment' || test.k === 'pi') return false;
  const principal = axis === 'attribute' ? 'attr' : 'el';
  if (n.t !== principal) return false;
  if (test.k === 'any') return true;
  if (test.name.endsWith(':*')) return (n as ElNode | AttrNode).name.startsWith(test.name.slice(0, -1));
  return (n as ElNode | AttrNode).name === test.name;
}
const REVERSE = new Set<Axis>(['ancestor', 'ancestor-or-self', 'preceding', 'preceding-sibling', 'parent']);

function evalPreds(nodes: DNode[], preds: Ex[], ctxRoot: DocNode, reverse: boolean): DNode[] {
  let cur = nodes;
  for (const pr of preds) {
    const size = cur.length;
    cur = cur.filter((n, i) => {
      const v = ev(pr, { node: n, pos: i + 1, size }, ctxRoot);
      return typeof v === 'number' ? v === i + 1 : boolOf(v);
    });
  }
  void reverse;
  return cur;
}
function runSteps(start: DNode[], steps: Step[], root: DocNode): DNode[] {
  let cur = start;
  for (const s of steps) {
    const next: DNode[] = [];
    for (const n of cur) {
      let cand = axisNodes(s.axis, n).filter((c) => testNode(s.test, s.axis, c));
      cand = evalPreds(cand, s.preds, root, REVERSE.has(s.axis));
      next.push(...cand);
    }
    cur = sortDoc(next);
  }
  return cur;
}
const rootOf = (n: DNode): DocNode => {
  let c: DNode = n.t === 'attr' ? n.owner! : n;
  while (c.parent) c = c.parent;
  return c as DocNode;
};

function callFn(name: string, args: Ex[], c: Ctx, root: DocNode): Val {
  const a = args.map((x) => () => ev(x, c, root));
  const s = (i: number) => (args[i] ? strOf(a[i]()) : stringValue(c.node));
  const need = (min: number, max = min) => {
    if (args.length < min || args.length > max) throw new XPathError(`wrong number of arguments for ${name}()`);
  };
  switch (name) {
    case 'last':
      need(0);
      return c.size;
    case 'position':
      need(0);
      return c.pos;
    case 'count': {
      need(1);
      const v = a[0]();
      if (!isNodes(v)) throw new XPathError('count() needs a node-set');
      return v.length;
    }
    case 'local-name':
    case 'name': {
      const v = args[0] ? a[0]() : [c.node];
      if (!isNodes(v)) throw new XPathError(`${name}() needs a node-set`);
      const n = sortDoc(v)[0];
      if (!n || n.t === 'text' || n.t === 'doc') return '';
      return name === 'name' ? n.name : n.name.replace(/^.*:/, '');
    }
    case 'namespace-uri':
      return '';
    case 'string':
      return s(0);
    case 'concat':
      if (args.length < 2) throw new XPathError('concat() needs 2 or more arguments');
      return a.map((f) => strOf(f())).join('');
    case 'starts-with':
      need(2);
      return s(0).startsWith(s(1));
    case 'contains':
      need(2);
      return s(0).includes(s(1));
    case 'substring-before': {
      need(2);
      const x = s(0),
        i = x.indexOf(s(1));
      return i < 0 ? '' : x.slice(0, i);
    }
    case 'substring-after': {
      need(2);
      const x = s(0),
        y = s(1),
        i = x.indexOf(y);
      return i < 0 ? '' : x.slice(i + y.length);
    }
    case 'substring': {
      need(2, 3);
      const x = [...s(0)],
        r = (v: number) => Math.floor(v + 0.5);
      const st = r(numOf(a[1]())),
        ln = args[2] ? r(numOf(a[2]())) : Infinity;
      if (Number.isNaN(st) || Number.isNaN(ln)) return '';
      const from = st,
        to = st + ln;
      return x.filter((_ch, i) => i + 1 >= from && i + 1 < to).join('');
    }
    case 'string-length':
      return [...s(0)].length;
    case 'normalize-space':
      return s(0).trim().replace(/\s+/g, ' ');
    case 'translate': {
      need(3);
      const f = [...s(1)],
        t = [...s(2)];
      return [...s(0)]
        .map((ch) => {
          const i = f.indexOf(ch);
          return i < 0 ? ch : (t[i] ?? '');
        })
        .join('');
    }
    case 'boolean':
      need(1);
      return boolOf(a[0]());
    case 'not':
      need(1);
      return !boolOf(a[0]());
    case 'true':
      return true;
    case 'false':
      return false;
    case 'lang':
      return false;
    case 'number':
      return args[0] ? numOf(a[0]()) : strToNum(stringValue(c.node));
    case 'sum': {
      need(1);
      const v = a[0]();
      if (!isNodes(v)) throw new XPathError('sum() needs a node-set');
      return v.reduce((t, n) => t + strToNum(stringValue(n)), 0);
    }
    case 'floor':
      need(1);
      return Math.floor(numOf(a[0]()));
    case 'ceiling':
      need(1);
      return Math.ceil(numOf(a[0]()));
    case 'round': {
      need(1);
      const v = numOf(a[0]());
      return Number.isFinite(v) ? Math.floor(v + 0.5) : v;
    }
    default:
      throw new XPathError(`unknown function '${name}'`);
  }
}
function ev(e: Ex, c: Ctx, root: DocNode): Val {
  switch (e.k) {
    case 'num':
      return e.v;
    case 'lit':
      return e.v;
    case 'neg':
      return -numOf(ev(e.a, c, root));
    case 'union': {
      const x = ev(e.a, c, root),
        y = ev(e.b, c, root);
      if (!isNodes(x) || !isNodes(y)) throw new XPathError("'|' needs node-sets");
      return sortDoc([...x, ...y]);
    }
    case 'fn':
      return callFn(e.name, e.args, c, root);
    case 'filter': {
      const v = ev(e.e, c, root);
      if (!isNodes(v)) throw new XPathError('a predicate needs a node-set');
      return evalPreds(sortDoc(v), e.preds, root, false);
    }
    case 'path': {
      let start: DNode[];
      if (e.start) {
        const v = ev(e.start, c, root);
        if (!isNodes(v)) throw new XPathError('a path step needs a node-set');
        start = v;
      } else start = [e.abs ? rootOf(c.node) : c.node];
      return runSteps(start, e.steps, root);
    }
    case 'bin': {
      const op = e.op;
      if (op === 'or') return boolOf(ev(e.a, c, root)) || boolOf(ev(e.b, c, root));
      if (op === 'and') return boolOf(ev(e.a, c, root)) && boolOf(ev(e.b, c, root));
      const x = ev(e.a, c, root),
        y = ev(e.b, c, root);
      if (['=', '!=', '<', '<=', '>', '>='].includes(op)) return cmp(op, x, y);
      const m = numOf(x),
        n = numOf(y);
      return op === '+' ? m + n : op === '-' ? m - n : op === '*' ? m * n : op === 'div' ? m / n : m % n;
    }
  }
}

/** XmlNode.SelectNodes(path) from the document node; throws XPathError for an invalid expression or one that does not yield a node-set */
export function selectNodes(doc: DocNode, path: string): DNode[] {
  const ast = parseXPath(path);
  const v = ev(ast, { node: doc, pos: 1, size: 1 }, doc);
  if (!isNodes(v)) throw new XPathError(`Expression must evaluate to a node-set.`);
  return sortDoc(v);
}
