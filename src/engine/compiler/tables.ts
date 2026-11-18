/**
 * CSV name tables and array sizes. Pure: takes {path: text}.
 * Used at compile time for `ABL:TECH`-style name indices, GETNUM/VARSIZE constants in #DIM,
 * and later by the runtime variable store for array lengths.
 */
import builtins from '../../../reference/builtins.json';
import { splitLines } from '../util/lines';

/** variable name -> CSV file that names its elements */
const NAME_FILES: Record<string, string> = {
  ABL: 'ABL',
  EXP: 'EXP',
  TALENT: 'TALENT',
  PALAM: 'PALAM',
  TRAIN: 'TRAIN',
  MARK: 'MARK',
  ITEM: 'ITEM',
  BASE: 'BASE',
  SOURCE: 'SOURCE',
  EX: 'EX',
  STR: 'STRNAME',
  EQUIP: 'EQUIP',
  TEQUIP: 'TEQUIP',
  FLAG: 'FLAG',
  TFLAG: 'TFLAG',
  CFLAG: 'CFLAG',
  TCVAR: 'TCVAR',
  CSTR: 'CSTR',
  STAIN: 'STAIN',
  STRNAME: 'STRNAME',
  TSTR: 'TSTR',
  SAVESTR: 'SAVESTR',
  GLOBAL: 'GLOBAL',
  GLOBALS: 'GLOBALS',
  DAY: 'DAY',
  TIME: 'TIME',
  MONEY: 'MONEY',
};
/** variables whose element names come from another variable's CSV (Variable*Code families) */
const NAME_ALIAS: Record<string, string> = {
  ABLNAME: 'ABL',
  EXPNAME: 'EXP',
  TALENTNAME: 'TALENT',
  PALAMNAME: 'PALAM',
  TRAINNAME: 'TRAIN',
  MARKNAME: 'MARK',
  ITEMNAME: 'ITEM',
  BASENAME: 'BASE',
  SOURCENAME: 'SOURCE',
  EXNAME: 'EX',
  EQUIPNAME: 'EQUIP',
  TEQUIPNAME: 'TEQUIP',
  FLAGNAME: 'FLAG',
  TFLAGNAME: 'TFLAG',
  CFLAGNAME: 'CFLAG',
  TCVARNAME: 'TCVAR',
  CSTRNAME: 'CSTR',
  STAINNAME: 'STAIN',
  JUEL: 'PALAM',
  GOTJUEL: 'PALAM',
  UP: 'PALAM',
  DOWN: 'PALAM',
  PALAMLV: 'PALAM',
  PALAMCUP: 'PALAM',
  NOWEX: 'EX',
  MAXBASE: 'BASE',
  DOWNBASE: 'BASE',
  LOSEBASE: 'BASE',
  EXLV: 'EXP',
  CUP: 'PALAM',
  CDOWN: 'PALAM',
  EXPLV: 'EXP',
  ITEMSALES: 'ITEM',
  ITEMPRICE: 'ITEM',
  NOITEM: 'ITEM',
  BOUGHT: 'ITEM',
  PBAND: 'ITEM',
  TEQUIPNAME2: 'TEQUIP',
  SAVESTRNAME: 'SAVESTR',
  TSTRNAME: 'TSTR',
};
/** default lengths of name-bound arrays (setDefaultArrayLength) */
const DEFAULT_LEN: Record<string, number> = {
  ABL: 100,
  TALENT: 1000,
  EXP: 100,
  MARK: 100,
  TRAIN: 1000,
  PALAM: 200,
  ITEM: 1000,
  BASE: 100,
  SOURCE: 1000,
  EX: 100,
  EQUIP: 100,
  TEQUIP: 100,
  FLAG: 10000,
  TFLAG: 1000,
  CFLAG: 1000,
  TCVAR: 100,
  CSTR: 100,
  STAIN: 1000,
  STR: 20000,
  TSTR: 100,
  SAVESTR: 100,
  GLOBAL: 1000,
  GLOBALS: 100,
  DAY: 100,
  TIME: 100,
  MONEY: 100,
};

export interface NameTable {
  names: (string | undefined)[];
  byName: Map<string, number>;
  size: number;
}

export class Tables {
  private tables = new Map<string, NameTable>();
  private sizeOverride = new Map<string, number[]>();
  private flagsByVar = new Map<string, string[]>();
  /** GameBase.csv: GAMEBASE_* variable values */
  gameBase = new Map<string, string>();
  /** ITEM.csv price column (ConstantData.ItemPrice): the initial ITEMPRICE */
  itemPrice: number[] = [];
  /** STR.csv: the initial contents of STR */
  strInit: string[] = [];
  /**
   * PuchiEmuera only (profile 'puchi', see loadTranslation): CSV/<Name>_TR.csv files map a CSV element name to a replacement. null for every other game.
   * Key: the table name as PuchiEmuera's Translation.fileArray spells it (Abl, Talent, Train, Palam ...), value: original name -> replacement.
   */
  trNames: Map<string, Map<string, string>> | null = null;
  /** `Param` instead of `Palam` when the game has CSV/PARAM.CSV (ConstantData.canLoadParam) */
  private trParam = false;
  /** names for user-defined (ERH) variables: key `VAR@dim` (dim 0-based), from CSV/VAR.csv and *.ERD */
  private userNames = new Map<string, NameTable>();
  constructor(csv: Record<string, string> = {}) {
    for (const v of builtins.variables as { name: string; flags: string[] }[]) this.flagsByVar.set(v.name, v.flags);
    const files = new Map<string, string>();
    for (const [p, t] of Object.entries(csv)) {
      const m = /(?:^|\/)([^/]+)\.csv$/i.exec(p);
      // only top-level CSV dir files carry names (character csv live in subfolders)
      if (m && /(^|\/)csv\/[^/]+$/i.test(p)) files.set(m[1].toUpperCase(), t);
    }
    for (const [v, f] of Object.entries(NAME_FILES)) {
      const text = files.get(f);
      const names: (string | undefined)[] = [];
      const byName = new Map<string, number>();
      let max = -1;
      if (text) {
        for (const raw of splitLines(text)) {
          const line = raw.replace(/;.*$/, '').trim();
          if (!line) continue;
          const parts = line.split(',');
          if (parts.length < 2) continue;
          const idx = Number(parts[0].trim());
          const name = parts[1].trim();
          if (!Number.isInteger(idx) || idx < 0 || !name) continue;
          names[idx] = name;
          if (!byName.has(name)) byName.set(name, idx);
          if (idx > max) max = idx;
        }
      }
      this.tables.set(v, { names, byName, size: Math.max(DEFAULT_LEN[v] ?? 1000, max + 1) });
    }
    const itemText = files.get('ITEM');
    if (itemText)
      for (const raw of splitLines(itemText)) {
        const parts = raw.replace(/;.*$/, '').trim().split(',');
        const idx = Number(parts[0]),
          price = Number(parts[2]);
        if (Number.isInteger(idx) && idx >= 0 && parts.length >= 3 && Number.isFinite(price))
          this.itemPrice[idx] = price;
      }
    const strText = files.get('STR');
    if (strText)
      for (const raw of splitLines(strText)) {
        const line = raw.replace(/;.*$/, '').trim();
        const i = line.indexOf(',');
        const idx = Number(line.slice(0, i));
        if (i > 0 && Number.isInteger(idx) && idx >= 0) this.strInit[idx] = line.slice(i + 1).trim();
      }
    // ERD: ERB/**/VAR.ERD or VAR@N.ERD (N is 1-based dimension); CSV/VAR.csv names dimension 1
    for (const [p, text] of Object.entries(csv)) {
      const m = /(?:^|\/)([^/@]+)(?:@(\d+))?\.erd$/i.exec(p);
      if (m) this.addUserNames(m[1], m[2] ? Number(m[2]) - 1 : 0, text);
    }
    for (const [name, text] of files)
      if (!(name in NAME_FILES) && !Object.values(NAME_FILES).includes(name)) this.addUserNames(name, 0, text);
    const GB: Record<string, string> = {
      コード: 'GAMECODE',
      バージョン: 'VERSION',
      タイトル: 'TITLE',
      製作年: 'YEAR',
      作者: 'AUTHOR',
      バージョン違い認める: 'ALLOWVERSION',
      追加情報: 'INFO',
      最初からいるキャラ: 'DEFAULTCHARA',
      アイテムなし: 'NOITEM',
      URL: 'URL',
      バージョン名: 'VERSIONNAME',
    };
    const gb = files.get('GAMEBASE');
    if (gb) {
      for (const raw of splitLines(gb)) {
        const line = raw.replace(/;.*$/, '');
        const i = line.indexOf(',');
        if (i < 0) continue;
        const k = GB[line.slice(0, i).trim()];
        if (k) this.gameBase.set(k, line.slice(i + 1).trim());
      }
    }
    const vs = files.get('VARIABLESIZE');
    if (vs) {
      for (const raw of splitLines(vs)) {
        const line = raw.replace(/;.*$/, '').trim();
        if (!line) continue;
        const [n, ...rest] = line.split(',');
        const dims = rest.map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));
        if (n && dims.length) this.sizeOverride.set(n.trim().toUpperCase(), dims);
      }
      // ConstantData._decideActualArraySize_sub: a variable and its NAME array share one length. Both given: the larger; one given: the other follows
      // (ShinEraTenseiP sets `TEQUIP,200` only and reads TEQUIPNAME:132).
      for (const main of [
        'ABL',
        'TALENT',
        'EXP',
        'MARK',
        'BASE',
        'SOURCE',
        'EX',
        'EQUIP',
        'TEQUIP',
        'FLAG',
        'TFLAG',
        'CFLAG',
        'TCVAR',
        'CSTR',
        'STAIN',
        'STR',
        'TSTR',
        'SAVESTR',
        'GLOBAL',
        'GLOBALS',
      ]) {
        const name = main + 'NAME',
          a = this.sizeOverride.get(main),
          b = this.sizeOverride.get(name);
        if (a && b) {
          const m = Math.max(a[0], b[0]);
          a[0] = m;
          b[0] = m;
        } else if (b) this.sizeOverride.set(main, [b[0]]);
        else if (a) this.sizeOverride.set(name, [a[0]]);
      }
      // ITEMNAME and ITEMPRICE share one length (ConstantData: both cases set VariableIntArrayLength[ITEMPRICE] and MaxDataList[item]).
      // ShinEraTenseiP sets only `ITEMPRICE,20000` and reads ITEMNAME up to 7500.
      {
        const n = this.sizeOverride.get('ITEMNAME'),
          p = this.sizeOverride.get('ITEMPRICE');
        const m = Math.max(n?.[0] ?? 0, p?.[0] ?? 0);
        if (m > 0) {
          this.sizeOverride.set('ITEMNAME', [m]);
          this.sizeOverride.set('ITEMPRICE', [m]);
        }
      }
      // name-bound variables take their size from VariableSize.csv when present
      for (const [v, t] of this.tables) {
        const o = this.sizeOverride.get(v);
        if (o && o[0] > 0) t.size = o[0];
      }
    }
  }

  private addUserNames(varName: string, dim: number, text: string) {
    const names: (string | undefined)[] = [];
    const byName = new Map<string, number>();
    let max = -1;
    for (const raw of splitLines(text)) {
      const line = raw.replace(/;.*$/, '').trim();
      if (!line) continue;
      const parts = line.split(',');
      if (parts.length < 2) continue;
      const idx = Number(parts[0].trim()),
        name = parts[1].trim();
      if (!Number.isInteger(idx) || idx < 0 || !name) continue;
      names[idx] = name;
      if (!byName.has(name)) byName.set(name, idx);
      if (idx > max) max = idx;
    }
    const k = `${varName.toUpperCase()}@${dim}`;
    const prev = this.userNames.get(k);
    if (prev) {
      for (const [n, i] of byName) if (!prev.byName.has(n)) prev.byName.set(n, i);
    } else this.userNames.set(k, { names, byName, size: max + 1 });
  }

  /** ERD/CSV name table of a user-defined variable's dimension (0-based) */
  userTable(varName: string, dim: number): NameTable | undefined {
    return this.userNames.get(`${varName.toUpperCase()}@${dim}`);
  }

  /** name table that applies to elements of builtin variable `varName` */
  /**
   * PuchiEmuera's Translation class: for each name in `fileArray` the file CSV/<name>_TR.csv, if present, is a list of
   * `original,replacement` lines (`;` starts a comment or ends a line, empty lines are skipped, exactly one comma per line, a repeated original is an error). Reading any element of a *NAME array
   * (ABLNAME, TRAINNAME, ITEMNAME ...) then returns the replacement when the exact original is in that file's table; name lookups by string (GETNUM, NAMETOID...) still use the originals.
   * Files that are not in `fileArray` (the game's Juel_TR.csv) are ignored, as in the original. The original throws on a malformed line; this returns it as a note and skips the line.
   * Only called for the 'puchi' profile: no other game's behavior changes.
   */
  loadTranslation(csv: Record<string, string>): string[] {
    const notes: string[] = [];
    const FILE_ARRAY = [
      'Abl',
      'Talent',
      'Exp',
      'Mark',
      'Palam',
      'Param',
      'Item',
      'Train',
      'Base',
      'Source',
      'Ex',
      'EQUIP',
      'TEQUIP',
      'Flag',
      'TFLAG',
      'Cflag',
      'Tcvar',
      'CSTR',
      'Stain',
      'Cdflag1',
      'Cdflag2',
      'Str',
      'TSTR',
      'SaveStr',
      'GLOBAL',
      'GLOBALS',
      'ALL',
    ];
    const found = new Map<string, string>();
    for (const [pth, t] of Object.entries(csv)) {
      const m = /(?:^|\/)csv\/([^/]+)\.csv$/i.exec(pth.replace(/\\/g, '/'));
      if (m) found.set(m[1].toUpperCase(), t);
    }
    this.trParam = found.has('PARAM');
    const out = new Map<string, Map<string, string>>();
    for (const f of FILE_ARRAY) {
      const text = found.get(f.toUpperCase() + '_TR');
      if (text === undefined) continue;
      const d = new Map<string, string>();
      for (const raw of splitLines(text.replace(/^\uFEFF/, ''))) {
        let line = raw.trim();
        if (!line || line[0] === ';') continue;
        const sc = line.indexOf(';');
        if (sc >= 0) line = line.slice(0, sc);
        const parts = line.split(',');
        if (parts.length !== 2) {
          notes.push(
            `${f}_TR.csv: a line needs exactly one "," between the original and the replacement, skipped: ${parts[0]}`,
          );
          continue;
        }
        const k = parts[0].trim();
        if (d.has(k)) {
          notes.push(`${f}_TR.csv: ${k} appears twice, the first is kept`);
          continue;
        }
        d.set(k, parts[1].trim());
      }
      out.set(f, d);
    }
    this.trNames = out;
    return notes;
  }
  /** the _TR.csv table name for a *NAME variable (ABLNAME -> Abl, PALAMNAME -> Palam or Param), undefined when there is none */
  trTableOf(varName: string): string | undefined {
    const k = varName.toUpperCase();
    if (!this.trNames || !k.endsWith('NAME')) return undefined;
    const base = k.slice(0, -4);
    if (base === 'PALAM' || base === 'PARAM') return this.trParam ? 'Param' : 'Palam';
    for (const f of this.trNames.keys()) if (f.toUpperCase() === base) return f;
    return undefined;
  }
  /** `original` or its _TR.csv replacement (Translation.translate); `table` is a name from trTableOf */
  trName(table: string | undefined, original: string | undefined): string | undefined {
    if (!table || original === undefined || !this.trNames) return original;
    return this.trNames.get(table)?.get(original) ?? original;
  }

  tableFor(varName: string): NameTable | undefined {
    const k = varName.toUpperCase();
    return this.tables.get(NAME_FILES[k] ? k : (NAME_ALIAS[k] ?? ''));
  }

  nameToIndex(varName: string, name: string): number | undefined {
    return this.tableFor(varName)?.byName.get(name);
  }

  /** length of dimension `dim` (0-based) of a builtin array, or undefined if unknown */
  varSize(varName: string, dim = 0): number | undefined {
    const k = varName.toUpperCase();
    const flags = this.flagsByVar.get(k);
    if (!flags) return undefined;
    // ABLNAME, TRAINNAME ...: ConstantData.names[] are allocated MaxDataList long, i.e. as long as the variable they name (TRAIN 1000, not the 100 of a plain string array)
    const t = this.tables.get(k) ?? (k.endsWith('NAME') && k in NAME_ALIAS ? this.tableFor(k) : undefined);
    const ov = this.sizeOverride.get(k);
    if (ov && ov[dim] !== undefined && ov[dim] > 0) return ov[dim];
    if (t && dim === 0) return t.size;
    const chara = flags.includes('CHARACTER_DATA');
    const isStr = flags.includes('STRING');
    if (flags.includes('ARRAY_3D')) return 100;
    if (flags.includes('ARRAY_2D')) return chara ? 1 : 100;
    if (flags.includes('ARRAY_1D')) {
      if (k === 'JUEL' || k === 'GOTJUEL') return 200;
      if (k === 'RANDDATA') return 625;
      if (chara) return k === 'TALENT' || k === 'CFLAG' ? 1000 : 100;
      return isStr ? 100 : 1000;
    }
    return dim === 0 ? 1 : undefined;
  }
}
