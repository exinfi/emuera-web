/**
 * Output guards for the small translation model (translation tier, pure).
 * The model has no instructions and almost no context; it loops on moans and sound effects ("No, no, no, ..."). These checks collapse
 * loops and cap runaway length, and flag the result so the panel can show it as unreliable.
 */
export interface Guarded {
  text: string;
  flagged: boolean;
}

/** target languages written without spaces between words: collapsing and joining work on characters, not words */
export const isCjkTarget = (to: string): boolean => /^(ja|ko|zh)/i.test(to);

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** collapse any block of 1 to 3 words repeated 4 or more times in a row down to two repeats and an ellipsis */
function collapseRuns(words: string[]): { words: string[]; changed: boolean } {
  let changed = false;
  for (let n = 1; n <= 3; n++) {
    let i = 0;
    while (i + n * 2 <= words.length) {
      let reps = 1;
      while (
        i + (reps + 1) * n <= words.length &&
        words.slice(i, i + n).every((w, k) => norm(w) === norm(words[i + reps * n + k]) && norm(w) !== '')
      )
        reps++;
      if (reps >= 4) {
        words = [...words.slice(0, i + n * 2), '…', ...words.slice(i + reps * n)];
        changed = true;
        i += n * 2 + 1;
      } else i++;
    }
  }
  return { words, changed };
}

/**
 * `to` is the target language code. For an English (or other spaced) target the unit is the word; for a ja/ko/zh target it is the character
 * (so "ああああ"-style loops are caught), and a cut never looks for a space.
 */
export function guardOutput(src: string, out: string, to = 'en'): Guarded {
  const cjk = isCjkTarget(to);
  let text = out.trim();
  let flagged = false;
  if (!text) return { text: '', flagged: true };
  const r = collapseRuns(cjk ? [...text] : text.split(/\s+/));
  if (r.changed) {
    text = r.words.join(cjk ? '' : ' ');
    flagged = true;
  }
  const cap = cjk ? src.length * 3 + 30 : src.length * 4 + 60;
  if (text.length > cap) {
    const cut = text.slice(0, cap);
    text = (cjk ? cut : cut.slice(0, Math.max(cut.lastIndexOf(' '), 20))).trimEnd() + '…';
    flagged = true;
  }
  return { text, flagged };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Retry by clauses. The model loops on long lines made of stutters and moans ("んっ、は、ぁう！も、もう、急にされるとびっくりしちゃ、あ、ううっ！"
// came back as "No, no, no, ..." with none of the content). When the output of a whole line is flagged, the line is split into clause
// groups and each group is translated on its own; the pieces are joined back. Collapsing the loop cannot recover content the model never wrote.

const OPEN_Q = /^[「『（(]+/,
  CLOSE_Q = /[」』）)]+$/;
const KANJI = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const LETTERS = /[\p{L}\p{N}]/gu;
const TERMINAL = /[。！？!?]/;
/** a clause that is only a sound or stutter: at most 3 letters and no kanji */
const isFiller = (t: string) => {
  const core = (t.match(LETTERS) ?? []).join('');
  return core.length <= 3 && !KANJI.test(core);
};

export interface Split {
  groups: string[];
  quoted: boolean;
}

/**
 * Split a line into clause groups: runs of sound/stutter clauses are kept together and a run is attached to the content clause after it
 * (so "も、もう、急にされると…" stays one group), except that a run ending in sentence punctuation closes its own group.
 * Returns null when there is nothing to split (fewer than 2 groups).
 */
export function splitClauses(src: string): Split | null {
  let t = src.trim();
  const quoted = OPEN_Q.test(t) && CLOSE_Q.test(t);
  if (quoted) t = t.replace(OPEN_Q, '').replace(CLOSE_Q, '');
  const toks = t.match(/[^、。！？!?…,，]+[、。！？!?…,，]*|[、。！？!?…,，]+/g) ?? [];
  const groups: string[] = [];
  let run = '',
    runClosed = false;
  const flush = () => {
    if (run) groups.push(run);
    run = '';
    runClosed = false;
  };
  for (const tok of toks) {
    if (isFiller(tok)) {
      if (runClosed) flush();
      run += tok;
      if (TERMINAL.test(tok[tok.length - 1] ?? '')) runClosed = true; // a terminal after sounds closes the group
    } else {
      run += tok;
      flush();
    }
  }
  flush();
  return groups.length >= 2 ? { groups, quoted } : null;
}

/** join the translated groups; the line's own quotes are put back once around the whole */
export function joinGroups(outs: string[], quoted: boolean, to = 'en'): string {
  const clean = outs
    .map((o) =>
      o
        .trim()
        .replace(/^[“"‘'「]+/, '')
        .replace(/[”"’'」]+$/, '')
        .trim(),
    )
    .filter(Boolean);
  const j = clean.join(isCjkTarget(to) ? '' : ' ');
  return quoted ? '“' + j + '”' : j;
}
