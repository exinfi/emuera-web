/** Character templates from every chara*.csv under CSV (any depth), ported from ConstantData.loadCharacterDataFile / toCharacterTemplate. */
import { loadRenameDic, applyRename } from '../compiler/rename';
import type { Tables } from '../compiler/tables';
import { splitLines } from '../util/lines';
import type { VM } from './vm';

export interface CharaTemplate {
  no: number;
  csvNo: number;
  name?: string;
  callname?: string;
  nickname?: string;
  mastername?: string;
  maxbase: Map<number, number>;
  mark: Map<number, number>;
  exp: Map<number, number>;
  abl: Map<number, number>;
  talent: Map<number, number>;
  relation: Map<number, number>;
  cflag: Map<number, number>;
  equip: Map<number, number>;
  juel: Map<number, number>;
  cstr: Map<number, string>;
}

const SECTIONS: Record<string, { key: keyof CharaTemplate; table: string | null; str?: boolean }> = {
  MARK: { key: 'mark', table: 'MARK' },
  刻印: { key: 'mark', table: 'MARK' },
  EXP: { key: 'exp', table: 'EXP' },
  経験: { key: 'exp', table: 'EXP' },
  ABL: { key: 'abl', table: 'ABL' },
  能力: { key: 'abl', table: 'ABL' },
  BASE: { key: 'maxbase', table: 'BASE' },
  基礎: { key: 'maxbase', table: 'BASE' },
  TALENT: { key: 'talent', table: 'TALENT' },
  素質: { key: 'talent', table: 'TALENT' },
  RELATION: { key: 'relation', table: null },
  相性: { key: 'relation', table: null },
  CFLAG: { key: 'cflag', table: 'CFLAG' },
  フラグ: { key: 'cflag', table: 'CFLAG' },
  EQUIP: { key: 'equip', table: 'EQUIP' },
  装着物: { key: 'equip', table: 'EQUIP' },
  JUEL: { key: 'juel', table: 'PALAM' },
  珠: { key: 'juel', table: 'PALAM' },
  CSTR: { key: 'cstr', table: 'CSTR', str: true },
};

const intLoose = (s: string): number | undefined => {
  const t = s.trim();
  return /^[+-]?\d+$/.test(t) ? Number(t) : undefined;
};

/** Value field of a chara CSV line: Emuera's ConstantData.tryToInt64 -> LexicalAnalyzer.ReadInt64. Optional sign, must start with a digit, then 0x hex / 0b binary / decimal, an optional p/e exponent in the same base, and any trailing text is ignored. */
export const csvInt64 = (str: string): number | undefined => {
  if (!str) return undefined;
  let i = 0;
  let sign = 1;
  if (str[i] === '+') i++;
  else if (str[i] === '-') { sign = -1; i++; }
  if (!(str[i] >= '0' && str[i] <= '9')) return undefined;
  let base = 10;
  if (str[i] === '0' && /[xXbB]/.test(str[i + 1] ?? '')) {
    base = /[xX]/.test(str[i + 1]) ? 16 : 2;
    i += 2;
  }
  const digits = (): number => {
    let sgn = 1;
    if (str[i] === '+') i++;
    else if (str[i] === '-') { sgn = -1; i++; }
    let v = 0n;
    const B = BigInt(base);
    for (; i < str.length; i++) {
      const d = parseInt(str[i], 16);
      if (!/[0-9a-fA-F]/.test(str[i]) || d >= base) break;
      v = v * B + BigInt(d);
    }
    return Number(v) * sgn;
  };
  let sig = digits();
  const e = str[i];
  const expBase = e === 'p' || e === 'P' ? 2 : e === 'e' || e === 'E' ? 10 : 0;
  if (expBase) {
    i++;
    const ex = digits();
    if (ex !== 0) sig = Math.trunc(sig * Math.pow(expBase, ex));
  }
  return sig * sign;
};

/** Join `{ ... }` continuation blocks, drop comments. As in EraStreamReader every joined line is followed by Config.ReplaceContinuationBR (default " "), so a multi-line CSTR value starts with a space. */
function logicalLines(text: string): { line: string; no: number }[] {
  const raw = splitLines(text);
  const out: { line: string; no: number }[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].trim() === '{') {
      const start = i + 1;
      let b = '';
      for (i++; i < raw.length && raw[i].trim() !== '}'; i++) b += raw[i] + ' ';
      if (!b.trimStart().startsWith(';')) out.push({ line: b, no: start });
      continue;
    }
    out.push({ line: raw[i], no: i + 1 });
  }
  return out
    .map((l) => ({ line: l.line.replace(/;.*$/, '').replace(/^[ \t]+/, ''), no: l.no }))
    .filter((l) => l.line.trim() !== '');
}

export class CharaTemplates {
  list: CharaTemplate[] = [];
  private noMap = new Map<number, CharaTemplate>();
  private csvMap = new Map<number, CharaTemplate>();
  warnings: string[] = [];
  constructor(
    files: Record<string, string>,
    private tables: Tables,
    public relationDef = 0,
  ) {
    const paths = Object.keys(files)
      .filter((p) => /(^|\/)chara[^/]*\.csv$/i.test(p) && /(^|\/)csv\//i.test(p))
      .sort();
    // Emuera.NET setting.json "UseRenameInCharaCSV": `[[name]]` in character CSVs is replaced from _Rename.csv (EraStreamReader(useRename) in loadCharacterDataFile)
    const sj = Object.keys(files).find((k) => /(^|\/)setting\.json$/i.test(k));
    let rn: Map<string, string> | undefined;
    try {
      if (sj && JSON.parse(files[sj].replace(/^\uFEFF/, '')).UseRenameInCharaCSV === true) rn = loadRenameDic(files);
    } catch {
      /* unreadable setting.json: no rename */
    }
    for (const p of paths) this.load(p, rn?.size ? applyRename(files[p], rn) : files[p]);
    this.list.sort((a, b) => a.no - b.no);
    for (const t of this.list) {
      if (!this.noMap.has(t.no)) this.noMap.set(t.no, t);
      if (!this.csvMap.has(t.csvNo)) this.csvMap.set(t.csvNo, t);
    }
  }
  private warn(p: string, n: number, m: string) {
    if (this.warnings.length < 200) this.warnings.push(`${p}:${n} ${m}`);
  }

  private load(path: string, text: string) {
    let t: CharaTemplate | null = null;
    for (const { line, no } of logicalLines(text)) {
      const tok = line.split(',');
      if (tok.length < 2 || tok[0] === '') continue;
      const head = tok[0].toUpperCase();
      if (head === 'NO' || tok[0] === '番号') {
        if (t) {
          this.warn(path, no, 'chara number defined twice');
          continue;
        }
        const n = intLoose(tok[1].trimEnd());
        if (n === undefined) {
          this.warn(path, no, `cannot convert '${tok[1]}'`);
          continue;
        }
        const base = path.replace(/^.*\//, '');
        const m = /chara(\d*)/i.exec(base);
        t = {
          no: n,
          csvNo: m && m[1] ? Number(m[1]) : 0,
          maxbase: new Map(),
          mark: new Map(),
          exp: new Map(),
          abl: new Map(),
          talent: new Map(),
          relation: new Map(),
          cflag: new Map(),
          equip: new Map(),
          juel: new Map(),
          cstr: new Map(),
        };
        this.list.push(t);
        continue;
      }
      if (!t) {
        this.warn(path, no, 'data before chara number');
        continue;
      }
      switch (head) {
        case 'NAME':
        case '名前':
          t.name = tok[1];
          continue;
        case 'CALLNAME':
        case '呼び名':
          t.callname = tok[1];
          continue;
        case 'NICKNAME':
        case 'あだ名':
          t.nickname = tok[1];
          continue;
        case 'MASTERNAME':
        case '主人の呼び方':
          t.mastername = tok[1];
          continue;
        case 'ISASSI':
        case '助手':
          continue;
      }
      const sec = SECTIONS[head] ?? SECTIONS[tok[0]];
      if (!sec) {
        this.warn(path, no, `cannot interpret '${tok[0]}'`);
        continue;
      }
      let idx = intLoose(tok[1].trimEnd());
      if (idx === undefined && sec.table) idx = this.tables.tableFor(sec.table)?.byName.get(tok[1]);
      if (idx === undefined) {
        this.warn(path, no, `undefined key '${tok[1]}' in ${sec.key}`);
        continue;
      }
      if (sec.str) (t.cstr as Map<number, string>).set(idx, tok[2] ?? '');
      else {
        const v = tok.length < 3 ? undefined : csvInt64(tok[2]);
        (t[sec.key] as Map<number, number>).set(idx, v ?? 1);
      }
    }
  }

  byNo(no: number): CharaTemplate | undefined {
    return this.noMap.get(no);
  }
  byCsvNo(no: number): CharaTemplate | undefined {
    return this.csvMap.get(no);
  }
}

/** Fill the newly pushed character `index` from a template (CharacterData ctor). */
export function applyTemplate(vm: VM, index: number, t: CharaTemplate | undefined) {
  const st = vm.store;
  const arr = (name: string) => st.charaArr(index, st.meta(name)!);
  const put = (name: string, m: Map<number, number | string>) => {
    const a = arr(name);
    for (const [k, v] of m) if (k < a.length) a[k] = v;
  };
  const rel = arr('RELATION');
  rel.fill(vm.templates?.relationDef ?? 0);
  if (!t) return;
  arr('NO')[0] = t.no;
  arr('NAME')[0] = t.name ?? '';
  arr('CALLNAME')[0] = t.callname ?? '';
  arr('NICKNAME')[0] = t.nickname ?? '';
  arr('MASTERNAME')[0] = t.mastername ?? '';
  put('MAXBASE', t.maxbase);
  put('BASE', t.maxbase);
  put('MARK', t.mark);
  put('EXP', t.exp);
  put('ABL', t.abl);
  put('TALENT', t.talent);
  put('RELATION', t.relation);
  put('CFLAG', t.cflag);
  put('EQUIP', t.equip);
  put('JUEL', t.juel);
  put('CSTR', t.cstr);
}
