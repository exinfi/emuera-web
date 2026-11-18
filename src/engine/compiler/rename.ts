/**
 * _Rename.csv (ParserMediator.LoadEraExRenameFile): "value , name" lines; the ERB/ERH text `[[name]]` is replaced by `value` line by line before anything else reads the line
 * (EraStreamReader.ReadEnabledLine). Only active when the config enables "_Rename.csvを利用する". Keys that are not in the file stay as they are
 * (the lexer then reports "cannot rename [[...]]").
 */
import { loadConfig } from '../runtime/config';
import { splitLines } from '../util/lines';

export function loadRenameDic(csv: Record<string, string>): Map<string, string> | undefined {
  const cfg = loadConfig(csv);
  const on = (k: string) => {
    const v = cfg.raw.get(k)?.trim().toLowerCase();
    return v === 'yes' || v === 'true' || v === '1';
  };
  if (!on('_Rename.csvを利用する') && !on('Use _Rename.csv file')) return undefined;
  const p = Object.keys(csv).find((k) => /(^|\/)_rename\.csv$/i.test(k));
  if (!p) return undefined;
  const dic = new Map<string, string>();
  for (const line of splitLines(csv[p])) {
    if (line.startsWith(';')) continue;
    const tokens = line.split(/(?<!\\),/);
    if (tokens.length === 2) dic.set(`[[${tokens[1].trim()}]]`, tokens[0].trim());
  }
  return dic;
}

/** replace every `[[...]]` that the dictionary knows (one pass over the text; `.` does not cross a line end, like the per-line regex of the original) */
export function applyRename(text: string, dic: Map<string, string>): string {
  if (!dic.size || !text.includes('[[')) return text;
  return text.replace(/\[\[.*?\]\]/g, (m) => dic.get(m) ?? m);
}
