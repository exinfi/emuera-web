// Small XML reader/writer (workers have no DOMParser) for MAP_/DT_ TOXML/FROMXML and the XML_* functions.
export interface XNode {
  name: string;
  attrs: Map<string, string>;
  kids: (XNode | string)[];
  parent?: XNode;
  /** written as `<a/>` (XmlElement.IsEmpty) */ selfClosed?: boolean;
}
export class XmlError extends Error {}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const xUnescape = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, g: string) => {
    if (g[0] === '#') {
      const n = g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return String.fromCodePoint(n);
    }
    return ENT[g] ?? m;
  });
export const xEscape = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const xEscapeAttr = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** parse a document; returns the root element (a synthetic #document wrapper holds it) */
export function parseXml(src: string): XNode {
  const doc: XNode = { name: '#document', attrs: new Map(), kids: [] };
  let cur = doc,
    i = 0;
  const err = (m: string) => new XmlError(`${m} (position ${i})`);
  while (i < src.length) {
    if (src[i] !== '<') {
      const j = src.indexOf('<', i),
        t = src.slice(i, j < 0 ? src.length : j);
      if (cur === doc) {
        if (t.trim()) throw err('Data at the root level is invalid');
      } else cur.kids.push(xUnescape(t));
      i = j < 0 ? src.length : j;
      continue;
    }
    if (src.startsWith('<?', i)) {
      const j = src.indexOf('?>', i);
      if (j < 0) throw err('unterminated declaration');
      i = j + 2;
      continue;
    }
    if (src.startsWith('<!--', i)) {
      const j = src.indexOf('-->', i);
      if (j < 0) throw err('unterminated comment');
      i = j + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const j = src.indexOf(']]>', i);
      if (j < 0) throw err('unterminated CDATA');
      cur.kids.push(src.slice(i + 9, j));
      i = j + 3;
      continue;
    }
    if (src.startsWith('<!', i)) {
      const j = src.indexOf('>', i);
      if (j < 0) throw err('unterminated DOCTYPE');
      i = j + 1;
      continue;
    }
    if (src[i + 1] === '/') {
      const j = src.indexOf('>', i);
      if (j < 0) throw err('unterminated end tag');
      const name = src.slice(i + 2, j).trim();
      if (cur === doc || cur.name !== name) throw err(`The '${name}' end tag does not match the start tag`);
      cur = cur.parent!;
      i = j + 1;
      continue;
    }
    // start tag
    let j = i + 1;
    while (j < src.length && !/[\s/>]/.test(src[j])) j++;
    const node: XNode = { name: src.slice(i + 1, j), attrs: new Map(), kids: [], parent: cur };
    if (!node.name) throw err('invalid start tag');
    for (;;) {
      while (/\s/.test(src[j] ?? '')) j++;
      if (j >= src.length) throw err('unterminated start tag');
      if (src[j] === '>' || src[j] === '/') break;
      const eq = src.indexOf('=', j);
      if (eq < 0) throw err('attribute without value');
      const an = src.slice(j, eq).trim();
      let k = eq + 1;
      while (/\s/.test(src[k] ?? '')) k++;
      const q = src[k];
      if (q !== '"' && q !== "'") throw err('attribute value must be quoted');
      const e2 = src.indexOf(q, k + 1);
      if (e2 < 0) throw err('unterminated attribute value');
      node.attrs.set(an, xUnescape(src.slice(k + 1, e2)));
      j = e2 + 1;
    }
    cur.kids.push(node);
    if (src[j] === '/') {
      j++;
      if (src[j] !== '>') throw err('invalid empty-element tag');
      node.selfClosed = true;
      i = j + 1;
      continue;
    }
    cur = node;
    i = j + 1;
  }
  if (cur !== doc) throw err(`The '${cur.name}' start tag is not closed`);
  const root = doc.kids.find((k) => typeof k !== 'string') as XNode | undefined;
  if (!root) throw new XmlError('Root element is missing.');
  return doc;
}
export const elements = (n: XNode, name?: string): XNode[] =>
  n.kids.filter((k): k is XNode => typeof k !== 'string' && (name === undefined || k.name === name));
export const innerText = (n: XNode): string => n.kids.map((k) => (typeof k === 'string' ? k : innerText(k))).join('');
export function outerXml(n: XNode): string {
  const a = [...n.attrs].map(([k, v]) => ` ${k}="${xEscapeAttr(v)}"`).join('');
  return n.kids.length ? `<${n.name}${a}>${innerXml(n)}</${n.name}>` : `<${n.name}${a} />`;
}
export const innerXml = (n: XNode): string =>
  n.kids.map((k) => (typeof k === 'string' ? xEscape(k) : outerXml(k))).join('');
