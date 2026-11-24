/** Pure rules of the page shell (no DOM), kept apart so they can be tested. */
import { gameCode } from '../engine/patches/registry';

/** the direction pad's shape, in units of one pad step (`padCfg.s` px): arm length and thickness, the gap between wedges in px, the center diamond's size as a share of a step */
export const PAD_LEN = 1.1,
  PAD_THK = 1.2,
  PAD_GAP = 3,
  PAD_CENTER = 0.7;
export type Pt = [number, number];
export type PadDir = 'up' | 'right' | 'down' | 'left';
export interface PadShapes {
  /** side of the square the cross is drawn in, px */
  size: number;
  /** each direction: its wedge polygon (px, already shrunk to leave the gap), the box of its arm (x0, y0, x1, y1; the tip at the center left out) and where its arrow sits */
  wedges: Record<PadDir, { poly: Pt[]; arm: [number, number, number, number]; glyph: Pt }>;
  /** the center diamond (px) and its middle point */
  diamond: Pt[];
  middle: Pt;
}

/** The pad is one cross: four arms and the middle square split along its diagonals into four wedges whose points meet at the center, a small diamond on top of the join. */
export function padShapes(pd: number): PadShapes {
  const L = PAD_LEN,
    t = PAD_THK,
    N = 2 * L + t,
    x0 = L,
    x1 = L + t,
    C = L + t / 2;
  const raw: Record<PadDir, Pt[]> = {
    up: [
      [x0, 0],
      [x1, 0],
      [x1, x0],
      [C, C],
      [x0, x0],
    ],
    right: [
      [N, x0],
      [N, x1],
      [x1, x1],
      [C, C],
      [x1, x0],
    ],
    down: [
      [x1, N],
      [x0, N],
      [x0, x1],
      [C, C],
      [x1, x1],
    ],
    left: [
      [0, x1],
      [0, x0],
      [x0, x0],
      [C, C],
      [x0, x1],
    ],
  };
  const glyphs: Record<PadDir, Pt> = {
    up: [C, L * 0.46],
    down: [C, N - L * 0.46],
    left: [L * 0.46, C],
    right: [N - L * 0.46, C],
  };
  const k = 1 - (PAD_GAP * 2) / pd; // each wedge shrinks a little about its middle, which leaves the gap between them
  const wedges = {} as PadShapes['wedges'];
  for (const d of ['up', 'right', 'down', 'left'] as PadDir[]) {
    const q0: Pt[] = raw[d].map((p) => [p[0] * pd, p[1] * pd]);
    const cx = q0.reduce((a, p) => a + p[0], 0) / q0.length,
      cy = q0.reduce((a, p) => a + p[1], 0) / q0.length;
    const poly: Pt[] = q0.map((p) => [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k]);
    const arm = poly.filter((_, i) => i !== 3);
    wedges[d] = {
      poly,
      arm: [
        Math.min(...arm.map((p) => p[0])),
        Math.min(...arm.map((p) => p[1])),
        Math.max(...arm.map((p) => p[0])),
        Math.max(...arm.map((p) => p[1])),
      ],
      glyph: [glyphs[d][0] * pd, glyphs[d][1] * pd],
    };
  }
  const hd = pd * PAD_CENTER * 0.523,
    cc = C * pd;
  return {
    size: N * pd,
    wedges,
    diamond: [
      [cc, cc - hd],
      [cc + hd, cc],
      [cc, cc + hd],
      [cc - hd, cc],
    ],
    middle: [cc, cc],
  };
}

/**
 * GameBase.csv codes of the games whose exploration is a 2D map moved with 8/4/6/2, so the direction pad starts on for them on a touch device.
 * 666 is the code of ShinEraTenseiP (formerly eraMegaten). Add a code here to give another game the same start.
 */
export const PAD_GAME_CODES: readonly string[] = ['666'];

/** whether the game (its CSV files by path) has one of the given GameBase.csv codes; a missing file or code is no match */
export const needsPad = (csv: Record<string, string>, codes: readonly string[] = PAD_GAME_CODES): boolean => {
  const c = gameCode(csv);
  return c !== '' && codes.includes(c);
};

/** whether the direction pad is on: the player's stored choice ('1' or '0') wins; with none, only a game that needs the pad, on a touch device, turns it on by itself */
export const dpadDefault = (stored: string | null, padGame: boolean, desktop: boolean): boolean =>
  stored === null ? padGame && !desktop : stored === '1';

/** the quick access buttons' stored values: a JSON array of strings, at most `max`, each at most `maxLen` characters; anything else is dropped */
export function parseQuickVals(raw: string | null, max = 8, maxLen = 40): string[] {
  try {
    const a: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(a)
      ? a.filter((x): x is string => typeof x === 'string' && x.length <= maxLen).slice(0, max)
      : [];
  } catch {
    return [];
  }
}
