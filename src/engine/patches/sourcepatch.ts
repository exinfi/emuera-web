/**
 * Source patches: a fix applied to one function's text in one ERB file before it is parsed, only when that function is byte-for-byte the one the patch was written
 * against (hash of the function text) and the line to replace occurs in it exactly once. Anything else (another game version, an edited function) leaves the file untouched.
 * The shell learns from the engine which patches were applied (`patches` message), the same as for fingerprinted native patches.
 */
export interface SourcePatch {
  id: string;
  /** lower-case, '/'-separated tail of the ERB path (as the loader names it, game root stripped) */
  file: string;
  /** label of the function (the `@NAME` line) */
  func: string;
  /** textHash of the function's text, from its `@` line up to (not including) the next line starting with `@` */
  hash: string;
  /** the exact text of the line (without its line break) and its replacement */
  from: string;
  to: string;
  /** further line replacements in the same function (same rules: each `from` must occur exactly once in the function as it was hashed) */
  more?: { from: string; to: string }[];
}

/** cyrb53 over UTF-16 code units, hex, with the length appended (a signature, not a security hash) */
export function textHash(s: string): string {
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16) + ':' + s.length;
}

const norm = (p: string) => p.replace(/\\/g, '/').normalize('NFC').toLowerCase();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** the function's text and where it sits in `text` (undefined unless exactly one `@func` line exists) */
export function findFunction(text: string, func: string): { start: number; end: number } | undefined {
  const re = new RegExp(`^@${esc(func)}(?=[\\s,(;]|$)`, 'gm');
  const m1 = re.exec(text);
  if (!m1 || re.exec(text)) return undefined;
  const next = /^@/gm;
  next.lastIndex = m1.index + 1;
  const m2 = next.exec(text);
  return { start: m1.index, end: m2 ? m2.index : text.length };
}

/** the patched text, or null when the patch does not apply to this file/function */
export function applySourcePatch(p: SourcePatch, path: string, text: string): string | null {
  if (!norm(path).endsWith(p.file)) return null;
  const f = findFunction(text, p.func);
  if (!f) return null;
  const body = text.slice(f.start, f.end);
  if (textHash(body.replace(/\r\n?/g, '\n')) !== p.hash) return null;
  let out = body;
  for (const e of [{ from: p.from, to: p.to }, ...(p.more ?? [])]) {
    const at = body.indexOf(e.from);
    if (at < 0 || body.indexOf(e.from, at + 1) >= 0) return null;
    out = out.replace(e.from, () => e.to); // function replacer: `to` is literal text ($ is not special)
  }
  return text.slice(0, f.start) + out + text.slice(f.end);
}

/**
 * ShinEraTenseiP 0.5.9 + /egg/ development (GameBase.csv code 666, version 000509309154): @BATTLE_WIN in ERB/RPG/戦闘/BATTLE.ERB.
 * The result screen's EXP bar animation adds `(EXP - prev * 191) / (next - prev) - start`; the closing parenthesis is misplaced (the commented-out older line and the
 * line that sets the bar's start value both have `(EXP - prev) * 191 / ...`), so the sum is negative, is clamped to 0 on the next line and the bar never grows with the gain.
 */
export const SOURCE_PATCHES: readonly SourcePatch[] = [
  {
    id: 'tensei-exp-bar',
    file: 'rpg/戦闘/battle.erb',
    func: 'BATTLE_WIN',
    hash: 'ce548a6953094:28058',
    from: '\t\t加算値:(LOCAL) += (BASE:L_FRIEND:ＥＸＰ - GET_NEXT_EXP(L_FRIEND, レベル-1) * 191) / (GET_NEXT_EXP(L_FRIEND, レベル) - GET_NEXT_EXP(L_FRIEND, レベル-1)) - LOCAL:2',
    to: '\t\t加算値:(LOCAL) += (BASE:L_FRIEND:ＥＸＰ - GET_NEXT_EXP(L_FRIEND, レベル-1)) * 191 / (GET_NEXT_EXP(L_FRIEND, レベル) - GET_NEXT_EXP(L_FRIEND, レベル-1)) - LOCAL:2',
  },
  {
    id: 'tensei-name-matches',
    file: 'rpg/ダンジョンアタック/auto_recover.erb',
    func: 'AUTO_RECOVER_MAGIC_HP',
    hash: '1c694c7708199f:3725',
    from: '\t\t\t\tCASE "ディア", "ディアラマ"',
    to: '\t\t\t\tCASE "ディア", "ディアラマ", "Dia", "Diarama"',
    more: [
      { from: '\t\t\t\tCASE "ディアラハン"', to: '\t\t\t\tCASE "ディアラハン", "Diarahan"' },
      {
        from: '\t\t\t\tCASE "メ・ディア", "メ・ディアラマ"',
        to: '\t\t\t\tCASE "メ・ディア", "メ・ディアラマ", "Media", "Mediarama"',
      },
      { from: '\t\t\t\tCASE "メ・ディアラハン"', to: '\t\t\t\tCASE "メ・ディアラハン", "Mediarahan"' },
    ],
  },
];
export const sourcePatchesFor = (ids: readonly string[]): SourcePatch[] =>
  SOURCE_PATCHES.filter((p) => ids.includes(p.id));
