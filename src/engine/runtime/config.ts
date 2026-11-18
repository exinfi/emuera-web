/** Runtime config from CSV/_default.config + _fixed.config ("key:value" per line; _fixed wins). */
import { CONFIG_ITEMS } from './configitems';
import { splitLines } from '../util/lines';

export interface RuntimeConfig {
  raw: Map<string, string>;
  /** _Replace.csv rows */
  replace: Map<string, string[]>;
  windowWidth: number;
  windowHeight: number;
  fontName: string;
  fontSize: number;
  lineHeight: number;
  printCPerLine: number;
  printCLength: number;
  textColor: number;
  backColor: number;
  focusColor: number;
  /** 履歴ログの行数: how many display lines the console keeps (default 5000, never below 500) */
  maxLog: number;
  /** _Replace.csv / config values that drive the system flow */
  comAbleDefault: number;
  maxShopItem: number;
  saveDataNos: number;
  autoSave: boolean;
  stainDefault: number[];
  titleMenu0: string;
  titleMenu1: string;
  drawLine: string;
  barChar1: string;
  barChar2: string;
  moneyLabel: string;
  moneyFirst: boolean;
  relationDef: number;
  compatiSPChara: boolean;
  /** CSV/VarExt*.csv (ConstantData.loadGlobalVarExSetting): MAP / XML / DataTable names that belong to the save, the global save or neither (static) */
  varExt: VarExt;
  expLvDef: number[];
  palamLvDef: number[];
  pbandDef: number;
  timeupLabel: string;
  loadLabel: string;
}
const rgb = (s: string | undefined, d: number) => {
  const m = (s ?? '').split(',').map((x) => Number(x.trim()));
  return m.length === 3 && m.every((x) => Number.isFinite(x)) ? (m[0] << 16) | (m[1] << 8) | m[2] : d;
};
export type VarExtGroup = 'save' | 'global' | 'static';
export interface VarExt {
  maps: Record<VarExtGroup, Set<string>>;
  xmls: Record<VarExtGroup, Set<string>>;
  dts: Record<VarExtGroup, Set<string>>;
}
const VAREXT_KEYS: Record<string, [keyof VarExt, VarExtGroup]> = {
  GLOBAL_MAPS: ['maps', 'global'],
  SAVE_MAPS: ['maps', 'save'],
  STATIC_MAPS: ['maps', 'static'],
  GLOBAL_XMLS: ['xmls', 'global'],
  SAVE_XMLS: ['xmls', 'save'],
  STATIC_XMLS: ['xmls', 'static'],
  GLOBAL_DTS: ['dts', 'global'],
  SAVE_DTS: ['dts', 'save'],
  STATIC_DTS: ['dts', 'static'],
};
export function loadVarExt(csv: Record<string, string>): VarExt {
  const g = () => ({ save: new Set<string>(), global: new Set<string>(), static: new Set<string>() });
  const v: VarExt = { maps: g(), xmls: g(), dts: g() };
  for (const [p, text] of Object.entries(csv)) {
    if (!/(^|[\\/])varext[^\\/]*\.csv$/i.test(p)) continue;
    for (const line of splitLines(text)) {
      if (!line.trim() || line.startsWith(';')) continue;
      const t = line.split(',');
      const k = VAREXT_KEYS[t[0].trim().toUpperCase()];
      if (k && t.length >= 2) for (const n of t.slice(1)) v[k[0]][k[1]].add(n.trim());
    }
  }
  return v;
}
/**
 * GETCONFIG / GETCONFIGS (ConfigData.GetConfigValueInERB): the item is found by its Japanese name, English name or code name; a value the game's
 * config files do not set is the built-in default. Returns undefined for an unknown item name.
 */
export function configValue(cfg: RuntimeConfig, name: string): string | number | undefined {
  const key = name.toUpperCase();
  const it = CONFIG_ITEMS.find(
    (i) => i[3].toUpperCase() === key || i[4].toUpperCase() === key || i[2].toUpperCase() === key,
  );
  if (!it) return undefined;
  const [arr, kind, , ja, en, def] = it;
  const given = arr === 'replace' ? cfg.replace.get(ja)?.join(',') : (cfg.raw.get(ja) ?? cfg.raw.get(en));
  const isYes = (v: string) => /^(yes|true|1)$/i.test(v.trim());
  if (kind === 'bool') return (given === undefined ? def === true : isYes(given)) ? 1 : 0;
  if (kind === 'int') {
    const n = given === undefined ? NaN : Number(given);
    return Number.isFinite(n) ? n : (def as number);
  }
  if (kind === 'color') {
    if (given !== undefined) {
      const m = given.split(',').map((x) => Number(x.trim()));
      if (m.length === 3 && m.every(Number.isFinite)) return (m[0] * 256 + m[1]) * 256 + m[2];
    }
    return def as number;
  }
  if (kind === 'str') return given ?? (def as string);
  if (kind === 'char') return (given ?? (def as string)).slice(0, 1);
  if (kind === 'enum') return (given ?? (def as string)).toUpperCase();
  const l = given !== undefined ? given.split(/[,/]/).map((x) => x.trim()) : (def as (string | number)[]); // list items: value text as the original prints it
  return l.join(',');
}
export function loadConfig(csv: Record<string, string>): RuntimeConfig {
  const raw = new Map<string, string>();
  const pick = (suffix: string) => Object.keys(csv).find((p) => p.toLowerCase().endsWith(suffix));
  // PATCH: EM+EE ConfigData.LoadConfig reads CSV/_default.config, then `emuera.config` (the user config next to the exe), then CSV/_fixed.config, each
  // overriding the one before. This used to skip the middle one, so a game that ships its own emuera.config (eraRanceK: 1366 px wide, 14 px font, the title
  // logo is 67 full-width cells = 938 px and wraps in the _default.config 900 px / 16 px window) ran with the wrong size.
  for (const f of ['_default.config', 'emuera.config', '_fixed.config']) {
    const p = f === 'emuera.config' ? Object.keys(csv).find((k) => /^emuera\.config$/i.test(k)) : pick(f);
    if (!p) continue;
    for (const line of splitLines(csv[p])) {
      const i = line.indexOf(':');
      if (i > 0 && !line.startsWith(';')) raw.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
    }
  }
  const num = (k: string, d: number) => {
    const n = Number(raw.get(k));
    return Number.isFinite(n) && raw.has(k) ? n : d;
  };
  // CSV/_Replace.csv: "key,value[,value...]" lines (names as in the C# ConfigData replace list)
  const rep = new Map<string, string[]>();
  const rp = pick('_replace.csv');
  if (rp)
    for (const line of splitLines(csv[rp])) {
      if (!line.trim() || line.startsWith(';')) continue;
      const i = line.indexOf(',');
      if (i <= 0) continue;
      rep.set(
        line.slice(0, i).trim(),
        line
          .slice(i + 1)
          .split(',')
          .map((x) => x.trim()),
      );
    }
  const repNum = (k: string, d: number) => {
    const v = Number(rep.get(k)?.[0]);
    return rep.has(k) && Number.isFinite(v) ? v : d;
  };
  const repList = (k: string, d: number[]) => {
    const l = rep
      .get(k)
      ?.join('/')
      .split('/')
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isFinite(n));
    return l && l.length ? l : d;
  };
  const rawBool = (k: string, d: boolean) => {
    const v = raw.get(k)?.toLowerCase();
    return v === undefined ? d : v === 'yes' || v === 'true' || v === '1';
  };
  return {
    raw,
    replace: rep,
    varExt: loadVarExt(csv),
    comAbleDefault: repNum('COM_ABLE初期値', 1),
    maxShopItem: repNum('販売アイテム数', 100),
    saveDataNos: num('表示するセーブデータ数', 20),
    autoSave: rawBool('オートセーブを行なう', true),
    compatiSPChara: rawBool('SPキャラを使用する', false),
    stainDefault: rep
      .get('汚れの初期値')
      ?.join('/')
      .split('/')
      .map(Number)
      .filter((n) => Number.isFinite(n)) ?? [0, 0, 2, 1, 8],
    titleMenu0: rep.get('システムメニュー0')?.join(',') ?? '最初からはじめる',
    titleMenu1: rep.get('システムメニュー1')?.join(',') ?? 'ロードしてはじめる',
    drawLine: rep.get('DRAWLINE文字')?.join(',') ?? '-',
    barChar1: (rep.get('BAR文字1')?.[0] ?? '*')[0] ?? '*',
    barChar2: (rep.get('BAR文字2')?.[0] ?? '.')[0] ?? '.',
    moneyLabel: rep.get('お金の単位')?.[0] ?? '$',
    moneyFirst: (rep.get('単位の位置')?.[0] ?? '前') !== '後',
    relationDef: repNum('RELATIONの初期値', 0),
    expLvDef: repList('EXPLVの初期値', [0, 1, 4, 20, 50, 200]),
    palamLvDef: repList('PALAMLVの初期値', [0, 100, 500, 3000, 10000, 30000, 60000, 100000, 150000, 250000]),
    pbandDef: repNum('PBANDの初期値', 4),
    timeupLabel: rep.get('時間切れ表示')?.join(',') ?? '時間切れ',
    loadLabel: rep.get('起動時簡略表示')?.join(',') ?? 'Now Loading...',
    windowWidth: num('ウィンドウ幅', 760),
    windowHeight: num('ウィンドウ高さ', 480),
    fontName: raw.get('フォント名') ?? 'MS Gothic',
    fontSize: num('フォントサイズ', 18),
    lineHeight: num('一行の高さ', 19),
    printCPerLine: num('PRINTCを並べる数', 3),
    printCLength: num('PRINTCの文字数', 25),
    maxLog: Math.max(500, num('履歴ログの行数', 5000)),
    textColor: rgb(raw.get('文字色'), 0xc0c0c0),
    backColor: rgb(raw.get('背景色'), 0),
    focusColor: rgb(raw.get('選択中文字色'), 0xffff00),
  };
}

/**
 * The history log length actually kept: the game's `履歴ログの行数` (already floored at 500 by loadConfig), lowered to the host's cap when the game asks for more.
 * A deliberate deviation: eraMegaten asks for 50000 lines, which a browser (a phone above all) cannot redraw on every step. `capped` is true only when the cap lowered the limit.
 */
export function applyLogCap(game: number, cap?: number): { used: number; capped: boolean } {
  if (!cap || !(cap > 0)) return { used: game, capped: false };
  const c = Math.max(500, Math.floor(cap));
  return c < game ? { used: c, capped: true } : { used: game, capped: false };
}
