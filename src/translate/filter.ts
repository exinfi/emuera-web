/**
 * Which finished screen lines are worth translating (translation tier, pure; no DOM).
 * The translator only ever reads a copy of what was displayed: nothing here is fed back to the game.
 */
import type { Seg } from '../host/protocol';

/**
 * Filter profiles: which script counts as "the original language" when deciding whether a line is worth sending to the model.
 * ja is the tuned one. ko and zh are the ja rules with the script swapped (the map, filler and length rules are shared; their own filler
 * word lists are not tuned yet, that needs real game text). generic has no single script: any line with two or more non-ASCII letters counts,
 * so a line that is already English is skipped.
 */
export type FilterProfile = 'ja' | 'ko' | 'zh' | 'generic';
export const FILTER_PROFILES: readonly FilterProfile[] = ['ja', 'ko', 'zh', 'generic'];
const SCRIPT: Record<FilterProfile, RegExp> = {
  ja: /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]/g,
  ko: /[ᄀ-ᇿ㄰-㆏가-힯]/g,
  zh: /[㐀-䶿一-鿿]/g,
  generic: /[^\x00-\x7f\s\p{P}\p{S}\p{N}]/gu,
};
/** the filter profile that goes with a model's source language code ("ja", "ko", "zh-Hans"...); anything else is generic */
export function profileForLanguage(from: string): FilterProfile {
  const l = String(from).toLowerCase().split(/[-_]/)[0];
  return l === 'ja' || l === 'ko' || l === 'zh' ? l : 'generic';
}
/** does this text contain any of the profile's original-language script (used for numbered-choice labels) */
export const hasSource = (text: string, p: FilterProfile = 'ja'): boolean => (text.match(SCRIPT[p])?.length ?? 0) > 0;
const KANJI = /[㐀-䶿一-鿿]/;
const LETTERS = /[\p{L}\p{N}]/gu;
/** map and drawing glyphs: box drawing, block elements, geometric shapes, misc symbols, arrows, 〓 ※ */
const GLYPH = /[\u2190-\u21ff\u2500-\u25ff\u2600-\u26ff\u203b\u3013]/g;

/** the plain text of a finished line (button and image segments contribute their text), or null for a line with a layout block */
export function lineText(segs: readonly Seg[]): string | null {
  let s = '';
  for (const g of segs) {
    if (g.div) return null;
    s += g.t ?? '';
  }
  return s;
}

/** numbered choices: "[3] 話す  [4] 戦う". The marker is kept as is; only the labels are translated. */
const MARK = /\[\s*[+-]?\d+\s*\]/g;
export interface MenuSplit {
  head: string;
  items: { mark: string; label: string }[];
}
export function splitMenu(text: string): MenuSplit | null {
  const ms = [...text.matchAll(MARK)];
  if (!ms.length) return null;
  const head = text.slice(0, ms[0].index);
  const items = ms.map((m, i) => ({
    mark: m[0],
    label: text.slice(m.index! + m[0].length, i + 1 < ms.length ? ms[i + 1].index : undefined),
  }));
  return { head, items };
}
/** why a line was skipped, or '' when it should be translated (exported for tests and debug counters) */
export function skipReason(text: string, profile: FilterProfile = 'ja'): string {
  const t = text.trim();
  if (!t) return 'blank';
  if (t.length > 600) return 'long';
  const flat = t.replace(/\s|\u3000/g, '');
  if (flat && (t.match(GLYPH)?.length ?? 0) / flat.length >= 0.4) return 'map'; // ■■■扉■■■ : a map row, not text
  const src = t.match(SCRIPT[profile])?.length ?? 0;
  if (src < (/\[\s*[+-]?\d+\s*\]/.test(t) ? 1 : 2)) return 'not-source'; // a one-character choice such as "[2] 魔" is still worth showing
  const core = (t.match(LETTERS) ?? []).join('');
  if (core.length < 2) return 'punct';
  const uniq = new Set(core).size;
  if (core.length >= 3 && uniq <= 2) return 'filler'; // "あああ", "んっんっ"
  if (core.length >= 6 && uniq <= 4 && !KANJI.test(core)) return 'filler';
  return '';
}

export const worthTranslating = (text: string, profile: FilterProfile = 'ja'): boolean =>
  skipReason(text, profile) === '';
