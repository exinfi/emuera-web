/**
 * Sort comparison of the original: Emuera sets CurrentCulture to the invariant culture, and ARRAYSORT / ARRAYMSORT /
 * ARRAYMSORTEX / SORTCHARA compare strings with string.CompareTo, i.e. culture-aware root collation, not ordinal and not Japanese.
 * ('und' is the root collation; 'ja' orders kanji differently.) Integers compare numerically.
 */
import type { Value } from './value';

const root = new Intl.Collator('und');
export const compareValues = (a: Value, b: Value): number =>
  typeof a === 'string' && typeof b === 'string' ? root.compare(a, b) : a < b ? -1 : a > b ? 1 : 0;
