/** Nearest-button selection for taps. Built on the screen view's button rectangles (stage coordinates).
 *  A tap that lands on a button presses it; a tap near buttons presses the nearest one (a finger tends to land under its target,
 *  and sideways misses are more likely to be wrong than vertical ones, so those cost more). There is no "ambiguous: do nothing" guard:
 *  compact button rows made it unusable. */
import type { ScreenView, ButtonInfo, Rect } from '../host/web/screenview';

export interface Pick {
  button: ButtonInfo;
  rect: Rect;
  exact: boolean;
}
/** reach in screen px (converted to stage px by the current scale) */
const REACH_X = 30,
  REACH_Y = 24;

/** Button rectangles come from the browser's inline boxes, whose height is the font's content area: with a tall fallback font (CJK) stacked
 *  lines overlap. Rows are therefore cut down to one line height around their centre, so stacked buttons never share pixels. */
export const lineRect = (r: Rect, lineH: number): Rect => {
  const h = Math.min(r.h, lineH);
  return { x: r.x, w: r.w, h, y: r.y + (r.h - h) / 2 };
};

export function pickButton(
  view: ScreenView,
  x: number,
  y: number,
  scale: number,
  assist: boolean,
  lineH = Infinity,
): Pick | null {
  let best: (Pick & { score: number }) | null = null;
  for (const b of view.buttons()) {
    if (!b.visible) continue;
    for (const raw of b.rects) {
      const r = lineRect(raw, lineH);
      const dx = Math.max(r.x - x, 0, x - (r.x + r.w)),
        dy = Math.max(r.y - y, 0, y - (r.y + r.h));
      const exact = dx === 0 && dy === 0;
      if (!exact) {
        if (!assist) continue;
        if (dx * scale > REACH_X || dy * scale > REACH_Y) continue;
      }
      const below = y > r.y + r.h;
      const score = exact ? 0 : Math.hypot(dx * scale * 1.5, dy * scale * (below ? 0.8 : 1));
      if (!best || score < best.score || (score === best.score && r.y < best.rect.y))
        best = { button: b, rect: r, exact, score };
    }
  }
  return best;
}
