// MAP_TOXML / MAP_FROMXML / DT_TOXML / DT_FROMXML.
// DataTable's XML is .NET's WriteXmlSchema/WriteXml layout (XSD + <DocumentElement> rows); the reader accepts what the writer produces.
import type { Expr } from '../compiler/ast';
import { compile } from './eval';
import { def, defRaw, refOf } from './funcs';
import { Cell, DataTable } from './datatable';
import { EmueraError, Value } from './value';
import { elements, innerText, innerXml, parseXml, xEscape, XmlError } from './xml';

def('MAP_TOXML', (vm, a) => {
  const m = vm.maps.get(String(a[0]));
  if (!m) return '';
  let s = '<map>';
  for (const [k, v] of m) s += `<p><k>${k}</k><v>${v}</v></p>`; // the original does not escape
  return s + '</map>';
});
def('MAP_FROMXML', (vm, a) => {
  const m = vm.maps.get(String(a[0]));
  if (!m) return 0;
  const xml = String(a[1]);
  let root;
  try {
    root = parseXml(xml);
  } catch (e) {
    if (e instanceof XmlError) throw new EmueraError(`MAP_FROMXML: failed to parse "${xml}": ${e.message}`);
    throw e;
  }
  const top = elements(root)[0];
  if (top && top.name === 'map')
    for (const p of elements(top, 'p')) {
      const k = elements(p, 'k'),
        v = elements(p, 'v');
      if (k.length !== 1 || v.length !== 1) continue;
      m.set(innerText(k[0]), innerXml(v[0]));
    }
  return 1;
});

const XS: Record<number, string> = { 1: 'xs:byte', 2: 'xs:short', 3: 'xs:int', 4: 'xs:long', 5: 'xs:string' };
const XS_BACK: Record<string, number> = {
  'xs:byte': 1,
  'xs:short': 2,
  'xs:int': 3,
  'xs:long': 4,
  'xs:string': 5,
  'xs:unsignedByte': 1,
};
export function schemaXml(t: DataTable, name: string): string {
  let cols = '';
  t.cols.forEach((c, i) => {
    const d = c.def !== undefined ? ` default="${xEscape(String(c.def))}"` : '';
    cols += `<xs:element name="${c.name}" type="${XS[t.typeNum(i)]}"${d}${i === 0 || !c.nullable ? '' : ' minOccurs="0"'} />`;
  });
  return `<?xml version="1.0" encoding="utf-16"?><xs:schema id="NewDataSet" xmlns="" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:msdata="urn:schemas-microsoft-com:xml-msdata"><xs:element name="NewDataSet" msdata:IsDataSet="true" msdata:MainDataTable="${name}" msdata:UseCurrentLocale="true"><xs:complexType><xs:choice minOccurs="0" maxOccurs="unbounded"><xs:element name="${name}"><xs:complexType><xs:sequence>${cols}</xs:sequence></xs:complexType></xs:element></xs:choice></xs:complexType><xs:unique name="Constraint1" msdata:PrimaryKey="true"><xs:selector xpath=".//${name}" /><xs:field xpath="id" /></xs:unique></xs:element></xs:schema>`;
}
export function dataXml(t: DataTable, name: string): string {
  let s = '<?xml version="1.0" encoding="utf-16"?><DocumentElement>';
  for (const r of t.rows) {
    s += `<${name}>`;
    t.cols.forEach((c, i) => {
      const v = r[i];
      if (v !== null && v !== undefined) s += `<${c.name}>${xEscape(String(v))}</${c.name}>`;
    });
    s += `</${name}>`;
  }
  return s + '</DocumentElement>';
}

// DT_TOXML name [, stringVar]: returns the rows as XML; the XSD goes to RESULTS:1 (or to the given string variable)
defRaw('DT_TOXML', (vm, args: Expr[], fn) => {
  const name = compile(args[0], fn, vm);
  const out = args[1] && args[1].k === 'var' ? refOf(args[1], fn, vm) : null;
  return (fr) => {
    const n = String(name(fr));
    const t = vm.dts.get(n);
    if (!t) return '';
    const schema = schemaXml(t, n);
    if (out) {
      const { arr, off } = out.locate(fr);
      arr[off] = schema;
    } else vm.global('RESULTS')[1] = schema;
    return dataXml(t, n);
  };
});

/** DataTable from .NET-style schema + data XML (DT_FROMXML and native save files); null when the schema does not hold the table */
export function dtFromXml(name: string, schemaText: string, dataText: string): DataTable | null {
  {
    const sch = elements(parseXml(schemaText))[0];
    const table = new DataTable();
    // the stored table keeps the name it had when written (MainDataTable), not the key it is loaded under
    const dsEl = elements(sch, 'xs:element')[0];
    let tname = dsEl?.attrs.get('msdata:MainDataTable') ?? name;
    const findTable = (want: string | null): any =>
      (function find(n): any {
        for (const e of elements(n)) {
          if (e.name === 'xs:element' && e.attrs.get('name') === want) return e;
          const r = find(e);
          if (r) return r;
        }
        return null;
      })(sch);
    // DataTable.ReadXmlSchema on a DataSet-style schema loads the table the schema defines; a MainDataTable hint that names no element
    // (AnonTW's schema says "db" but defines "bbas_dataset") does not make it fail, so fall back to the first nested table element.
    let tableEl = findTable(tname);
    if (!tableEl && dsEl) {
      const first = (function find(n): any {
        for (const e of elements(n)) {
          if (e.name === 'xs:element' && e !== dsEl && e.attrs.get('name') && elements(e, 'xs:complexType').length)
            return e;
          const r = find(e);
          if (r) return r;
        }
        return null;
      })(dsEl);
      if (first) {
        tableEl = first;
        tname = first.attrs.get('name');
      }
    }
    if (!tableEl) return null;
    const seq = (function find(n): any {
      for (const e of elements(n)) {
        if (e.name === 'xs:sequence') return e;
        const r = find(e);
        if (r) return r;
      }
      return null;
    })(tableEl);
    const defs = new Map<string, Value>();
    for (const c of elements(seq ?? tableEl, 'xs:element')) {
      const cn = c.attrs.get('name')!;
      if (cn.toLowerCase() === 'id') continue;
      const ty = XS_BACK[c.attrs.get('type') ?? 'xs:string'] ?? 5;
      table.addColumn(cn, ty, c.attrs.get('minOccurs') === '0');
      const d = c.attrs.get('default');
      if (d !== undefined) defs.set(cn, ty === 5 ? d : Number(d));
    }
    for (const [cn, d] of defs) table.cols[table.colIndex(cn)].def = d;
    const data = elements(parseXml(dataText))[0];
    for (const rowEl of elements(data, tname)) {
      const cells: Cell[] = table.cols.map((c) => (c.name === 'id' ? 0 : c.nullable ? null : table.defaultFor(c)));
      for (const f of elements(rowEl)) {
        const ci = table.colIndex(f.name);
        if (ci < 0) continue;
        const txt = innerText(f);
        cells[ci] = table.cols[ci].type === 'str' ? txt : Number(txt);
      }
      table.restoreRow(cells);
    }
    return table;
  }
}
def('DT_FROMXML', (vm, a) => {
  try {
    const table = dtFromXml(String(a[0]), String(a[1]), String(a[2]));
    if (!table) return 0;
    vm.dts.set(String(a[0]), table);
    return 1;
  } catch (e) {
    if ((globalThis as any).process?.env?.DBG) console.error('DT_FROMXML', e);
    return 0;
  } // malformed/empty XML: the original's try/catch also answers 0 (no `process` in a browser worker)
});

// ============================================================================ XML_* (System.Xml.XmlDocument + XPath SelectNodes)
// Every function takes a document first: an integer id (XML_DOCUMENT store), a string id for the _BYNAME forms, or XML text. XML text that is passed
// in a string VARIABLE is rewritten with the edited document (`saveToArg0`) when at least one node matched. -1 = no such document id.
import type { FuncDef } from '../compiler/types';
import type { VM } from './vm';
import * as D from './xmldom';

const isEmptyArg = (e: Expr | undefined): boolean => !e || (e.k === 'var' && e.name === '__EMPTY__');
const keyOf = (v: Value): string => (typeof v === 'string' ? v : String(v));

interface Opened {
  doc: D.DocNode;
  save: ((fr: any) => void) | null;
}
function openDoc(
  vm: VM,
  fname: string,
  v: Value,
  e0: Expr,
  byName: boolean,
  fn: FuncDef,
  forceId = false,
): Opened | -1 {
  if (typeof v !== 'string' || byName || forceId) {
    const d = vm.xmlDocs.get(keyOf(v));
    return d ? { doc: d, save: null } : -1;
  }
  let doc: D.DocNode;
  try {
    doc = D.loadXml(v);
  } catch (err) {
    if (err instanceof XmlError) throw new EmueraError(`${fname}: failed to parse "${v}": ${err.message}`);
    throw err;
  }
  let save: Opened['save'] = null;
  if (e0.k === 'var') {
    const ref = refOf(e0, fn, vm);
    save = (fr) => {
      const { arr, off } = ref.locate(fr);
      arr[off] = D.outerXml(doc);
    };
  }
  return { doc, save };
}
function select(fname: string, doc: D.DocNode, path: string): D.DNode[] {
  try {
    return D.selectNodes(doc, path);
  } catch (err) {
    if (err instanceof D.XPathError) throw new EmueraError(`${fname}: invalid XPath "${path}": ${err.message}`);
    throw err;
  }
}
const guard = <T>(fname: string, f: () => T): T => {
  try {
    return f();
  } catch (err) {
    if (err instanceof D.DomError) throw new EmueraError(`${fname}: ${err.message}`);
    throw err;
  }
};

function xmlDefs(
  name: string,
  byName: boolean,
  body: (c: { vm: VM; fn: FuncDef; ex: Expr[]; a: ((fr: any) => Value)[]; fr: any; op: Opened }) => Value,
  opts: { replace?: boolean } = {},
) {
  defRaw(name, (vm, ex, fn) => {
    const a = ex.map((e) => (isEmptyArg(e) ? (undefined as any) : compile(e, fn, vm)));
    return (fr) => {
      const op = openDoc(vm, name, a[0](fr), ex[0], byName, fn, opts.replace && ex.length === 2);
      if (op === -1) return -1;
      return body({ vm, fn, ex, a, fr, op });
    };
  });
}
const argS = (c: { a: ((fr: any) => Value)[]; fr: any }, i: number): string => String(c.a[i](c.fr));
const argI = (c: { a: ((fr: any) => Value)[]; fr: any }, i: number, d = 0): number =>
  c.a[i] ? Number(c.a[i](c.fr)) : d;
const has = (c: { a: unknown[] }, i: number) => c.a.length > i && !!c.a[i];

for (const byName of [false, true]) {
  const sfx = byName ? '_BYNAME' : '';
  // XML_GET(doc, xpath [, outArray | 1(RESULTS) [, style]]): count of matches; style 0 Value, 1 InnerText, 2 InnerXml, 3 OuterXml, 4 Name
  xmlDefs('XML_GET' + sfx, byName, (c) => {
    const nodes = select('XML_GET', c.op.doc, argS(c, 1));
    const style = has(c, 3) ? argI(c, 3) : 0;
    const text = (n: D.DNode) =>
      style === 1
        ? D.innerText(n)
        : style === 2
          ? D.innerXml(n)
          : style === 3
            ? D.outerXml(n)
            : style === 4
              ? D.nodeName(n)
              : (D.nodeValue(n) ?? '');
    if (has(c, 2)) {
      let target: { arr: any; off: number } | null = null;
      const e2 = c.ex[2];
      if (e2.k === 'var') {
        const r = refOf(e2, c.fn, c.vm);
        if (r.meta.isStr) target = r.locate(c.fr);
      }
      if (!target && Number(c.a[2](c.fr)) !== 0) target = { arr: c.vm.global('RESULTS'), off: 0 };
      if (target) {
        const n = Math.min(nodes.length, target.arr.length - target.off);
        for (let i = 0; i < n; i++) target.arr[target.off + i] = text(nodes[i]);
      }
    }
    return nodes.length;
  });
  // XML_SET(doc, xpath, value [, allNodes [, style]]): style 0 Value, 1 InnerText, 2 InnerXml
  xmlDefs('XML_SET' + sfx, byName, (c) => {
    const nodes = select('XML_SET', c.op.doc, argS(c, 1));
    const all = has(c, 3) && argI(c, 3) !== 0;
    let style = has(c, 4) ? argI(c, 4) : 0;
    if (style > 2 || style < 0) style = 0;
    const val = argS(c, 2);
    const set = (n: D.DNode) =>
      guard('XML_SET', () =>
        style === 1 ? D.setInnerText(n, val) : style === 2 ? D.setInnerXml(n, val) : D.setValue(n, val),
      );
    if (nodes.length > 0) {
      if (nodes.length !== 1) {
        if (all) nodes.forEach(set);
      } else set(nodes[0]);
      c.op.save?.(c.fr);
    }
    return nodes.length;
  });
  // XML_ADDNODE(doc, xpath, xml [, method [, allNodes]]) and XML_ADDATTRIBUTE(doc, xpath, name [, value [, method [, allNodes]]]): method 0 append, 1 before, 2 after
  for (const attrOp of [false, true]) {
    xmlDefs((attrOp ? 'XML_ADDATTRIBUTE' : 'XML_ADDNODE') + sfx, byName, (c) => {
      const mi = attrOp ? 4 : 3,
        ai = attrOp ? 5 : 4,
        fname = attrOp ? 'XML_ADDATTRIBUTE' : 'XML_ADDNODE';
      let method = has(c, mi) ? argI(c, mi) : 0;
      if (method > 2 || method < 0) method = 0;
      const nodes = select(fname, c.op.doc, argS(c, 1));
      if (nodes.length === 0) return 0;
      const all = has(c, ai) && argI(c, ai) !== 0;
      let child: D.ElNode | null = null;
      if (!attrOp) {
        const xml = argS(c, 2);
        let src: D.DocNode;
        try {
          src = D.loadXml(xml);
        } catch (err) {
          if (err instanceof XmlError) throw new EmueraError(`${fname}: failed to parse "${xml}": ${err.message}`);
          throw err;
        }
        child = D.cloneShallowWithInner(src.kids[0] as D.ElNode, c.op.doc);
      }
      const mk = (): D.AttrNode => ({
        t: 'attr',
        name: argS(c, 2),
        value: has(c, 3) ? argS(c, 3) : '',
        owner: null,
        parent: null,
      });
      const insert = (n: D.DNode): boolean =>
        guard(fname, () => {
          if (!attrOp) {
            if (method === 0) {
              if (n.t !== 'doc' && n.t !== 'el') throw new D.DomError('This node cannot have children.');
              D.appendChild(n, child!);
              return true;
            }
            if (n.t === 'doc' || n.t === 'attr' || !n.parent) return false;
            D.insertAt(n, child!, method === 2);
            return true;
          }
          // attributes: a copy per node (the original would throw "already an attribute of another element" when one attribute is added to several)
          if (method > 0 && n.t !== 'attr') return false;
          if (method === 0) {
            if (n.t !== 'el') throw new D.DomError('Only an element can have attributes.');
            D.appendAttr(n, mk());
            return true;
          }
          if (!(n as D.AttrNode).owner) return false;
          D.insertAttr(n as D.AttrNode, mk(), method === 2);
          return true;
        });
      if (nodes.length !== 1) {
        if (all) nodes.forEach(insert);
      } else if (!insert(nodes[0]) && method > 0) return 0;
      c.op.save?.(c.fr);
      return nodes.length;
    });
  }
  // XML_REMOVENODE(doc, xpath [, allNodes]) / XML_REMOVEATTRIBUTE(doc, xpath [, allNodes])
  for (const attrOp of [false, true]) {
    xmlDefs((attrOp ? 'XML_REMOVEATTRIBUTE' : 'XML_REMOVENODE') + sfx, byName, (c) => {
      const fname = attrOp ? 'XML_REMOVEATTRIBUTE' : 'XML_REMOVENODE';
      const nodes = select(fname, c.op.doc, argS(c, 1));
      if (nodes.length === 0) return 0;
      const all = has(c, 2) && argI(c, 2) !== 0;
      const remove = (n: D.DNode): boolean =>
        attrOp ? (n.t === 'attr' ? D.removeAttr(n) : false) : n.t === 'el' || n.t === 'text' ? D.removeNode(n) : false;
      if (nodes.length !== 1) {
        if (all) nodes.forEach(remove);
      } else if (!remove(nodes[0])) return 0;
      c.op.save?.(c.fr);
      return nodes.length;
    });
  }
  // XML_REPLACE(id, xml) swaps the stored document; XML_REPLACE(doc, xpath, xml [, allNodes]) replaces matching nodes with the new element
  defRaw('XML_REPLACE' + sfx, (vm, ex, fn) => {
    const a = ex.map((e) => (isEmptyArg(e) ? (undefined as any) : compile(e, fn, vm)));
    return (fr) => {
      const fname = 'XML_REPLACE';
      const xml = String((ex.length > 2 ? a[2] : a[1])(fr));
      let nd: D.DocNode;
      try {
        nd = D.loadXml(xml);
      } catch (err) {
        if (err instanceof XmlError) throw new EmueraError(`${fname}: failed to parse "${xml}": ${err.message}`);
        throw err;
      }
      const v0 = a[0](fr);
      const op = openDoc(vm, fname, v0, ex[0], byName, fn, ex.length === 2);
      if (op === -1) return -1;
      if (ex.length === 2) {
        vm.xmlDocs.set(keyOf(v0), nd);
        return 1;
      }
      const nodes = select(fname, op.doc, String(a[1](fr)));
      if (nodes.length === 0) return 0;
      const child = D.cloneShallowWithInner(nd.kids[0] as D.ElNode, op.doc);
      const all = a[3] !== undefined && Number(a[3](fr)) !== 0;
      const rep = (n: D.DNode): boolean =>
        guard(fname, () => {
          if ((n.t !== 'el' && n.t !== 'text') || !n.parent) return false;
          D.replaceChild(child, n);
          return true;
        });
      if (nodes.length !== 1) {
        if (all) nodes.forEach(rep);
      } else if (!rep(nodes[0])) return 0;
      op.save?.(fr);
      return nodes.length;
    };
  });
}
// XML_DOCUMENT(id, xml): store a parsed document (0 when the id is taken); XML_RELEASE(id) / XML_EXIST(id); XML_TOSTR(id): the document as text
defRaw('XML_DOCUMENT', (vm, ex, fn) => {
  const id = compile(ex[0], fn, vm),
    xml = compile(ex[1], fn, vm);
  return (fr) => {
    const k = keyOf(id(fr)),
      text = String(xml(fr));
    if (vm.xmlDocs.has(k)) return 0;
    try {
      vm.xmlDocs.set(k, D.loadXml(text));
    } catch (err) {
      if (err instanceof XmlError) throw new EmueraError(`XML_DOCUMENT: failed to parse "${text}": ${err.message}`);
      throw err;
    }
    return 1;
  };
});
def('XML_RELEASE', (vm, a) => (vm.xmlDocs.delete(keyOf(a[0])) ? 1 : 0));
def('XML_EXIST', (vm, a) => (vm.xmlDocs.has(keyOf(a[0])) ? 1 : 0));
def('XML_TOSTR', (vm, a) => {
  const d = vm.xmlDocs.get(keyOf(a[0]));
  return d ? D.outerXml(d) : '';
});
