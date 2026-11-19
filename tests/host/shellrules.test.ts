import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { padShapes, dpadDefault, parseQuickVals, type Pt } from '../../src/mobile/rules.ts';

/** even-odd point in polygon, written here so the expectations do not lean on the code under test */
function inside(poly: Pt[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i],
      [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const close = (a: number, b: number, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);

describe('direction pad shapes', () => {
  const pd = 54,
    sh = padShapes(pd),
    mid = sh.middle[0]; // the cross is a square; its middle is the same on both axes

  test('the cross is 2 x 1.1 + 1.2 = 3.4 steps wide', () => {
    close(sh.size, 3.4 * pd);
    close(mid, sh.size / 2);
  });

  test('the up wedge is the arm plus a point at the center, shrunk about its middle by 1 - 2 x 3 / 54', () => {
    // unshrunk, in px: (59.4,0) (124.2,0) (124.2,59.4) (91.8,91.8) (59.4,59.4); their mean is (91.8, 42.12); the factor is 8/9
    const want: Pt[] = [
      [63, 4.68],
      [120.6, 4.68],
      [120.6, 57.48],
      [91.8, 86.28],
      [63, 57.48],
    ];
    sh.wedges.up.poly.forEach((p, i) => {
      close(p[0], want[i][0]);
      close(p[1], want[i][1]);
    });
  });

  test('the other wedges are the up wedge turned by quarter turns about the middle', () => {
    const turn = (p: Pt): Pt => [2 * mid - p[1], p[0]]; // 90 degrees clockwise about the middle
    const order = ['up', 'right', 'down', 'left'] as const;
    for (let i = 0; i < 3; i++) {
      sh.wedges[order[i]].poly.forEach((p, k) => {
        const t = turn(p);
        close(sh.wedges[order[i + 1]].poly[k][0], t[0]);
        close(sh.wedges[order[i + 1]].poly[k][1], t[1]);
      });
    }
  });

  test('the center diamond has half-diagonal 0.7 x 0.523 steps and sits on the middle', () => {
    const hd = pd * 0.7 * 0.523;
    const want: Pt[] = [
      [mid, mid - hd],
      [mid + hd, mid],
      [mid, mid + hd],
      [mid - hd, mid],
    ];
    sh.diamond.forEach((p, i) => {
      close(p[0], want[i][0]);
      close(p[1], want[i][1]);
    });
  });

  test('a touch outside the diamond lands on the wedge of its dominant direction, and no two wedges overlap', () => {
    const hd = pd * 0.7 * 0.523,
      half = (1.2 * pd) / 2; // half the arm thickness
    const wedgesAt = (x: number, y: number): string[] => {
      const hit: string[] = [];
      for (const d of ['up', 'right', 'down', 'left'] as const) if (inside(sh.wedges[d].poly, x, y)) hit.push(d);
      return hit; // the diamond lies on top of the wedges' points, so a touch inside it is the diamond's
    };
    let seen = 0;
    for (let x = 0; x <= sh.size; x += 1)
      for (let y = 0; y <= sh.size; y += 1) {
        const dx = x - mid,
          dy = y - mid,
          hit = wedgesAt(x, y);
        assert.ok(hit.length <= 1, `(${x},${y}) is on ${hit.join(' and ')}`);
        if (inside(sh.diamond, x, y)) continue;
        const onCross = Math.abs(dx) <= half || Math.abs(dy) <= half;
        if (!onCross && Math.abs(dx) > half + 2 && Math.abs(dy) > half + 2) assert.equal(hit.length, 0, `(${x},${y}) is in a corner`);
        // clear of the diamond, the diagonals, and the outer rim: the wedge is the one the touch leans toward
        const inner = Math.abs(dx) + Math.abs(dy) > hd + 2 && Math.abs(Math.abs(dx) - Math.abs(dy)) > 8; // shrinking moves a diagonal edge about 3.9 px off the true diagonal (5.5 px in |dx| - |dy|)
        const rim = Math.max(Math.abs(dx), Math.abs(dy)) < sh.size / 2 - 6 && Math.min(Math.abs(dx), Math.abs(dy)) < 25; // the shrunk arm is 2 x 28.8 px thick (32.4 x 8/9 each side)
        if (onCross && inner && rim) {
          const want = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
          assert.deepEqual(hit, [want], `(${x},${y})`);
          seen++;
        }
      }
    assert.ok(seen > 2000); // the check really covered the cross
  });

  test('the diagonal between two wedges is a gap, and the middle is the diamond', () => {
    const t = (n: number) => padShapes(pd).wedges.up.poly.concat(padShapes(pd).wedges.left.poly).length && n;
    const x = mid - t(25),
      y = mid - t(25); // on the diagonal, beyond the diamond
    for (const d of ['up', 'right', 'down', 'left'] as const) assert.equal(inside(sh.wedges[d].poly, x, y), false);
    assert.equal(inside(sh.diamond, x, y), false);
    assert.equal(inside(sh.diamond, mid, mid), true);
    for (const d of ['up', 'right', 'down', 'left'] as const) assert.equal(inside(sh.wedges[d].poly, mid + 0.01, mid + 0.01), false);
  });

  test('a bigger pad scales every point', () => {
    const a = padShapes(40),
      b = padShapes(80);
    close(b.size, a.size * 2);
    // the gap is a fixed 3 px, so only the unshrunk geometry doubles: the diamond does
    close(b.diamond[0][1] - b.middle[1], 2 * (a.diamond[0][1] - a.middle[1]));
  });
});

describe('shell settings rules', () => {
  test('the direction pad: a stored choice wins; with none, only an Emuera.NET game on touch turns it on', () => {
    assert.equal(dpadDefault('1', false, true), true);
    assert.equal(dpadDefault('0', true, false), false);
    assert.equal(dpadDefault(null, true, false), true);
    assert.equal(dpadDefault(null, true, true), false);
    assert.equal(dpadDefault(null, false, false), false);
    assert.equal(dpadDefault(null, false, true), false);
  });

  test('quick values: bad data gives none; strings only; at most 8; at most 40 characters each', () => {
    assert.deepEqual(parseQuickVals(null), []);
    assert.deepEqual(parseQuickVals('not json'), []);
    assert.deepEqual(parseQuickVals('{"a":1}'), []);
    assert.deepEqual(parseQuickVals('["7","",3,null,"x"]'), ['7', '', 'x']);
    assert.deepEqual(parseQuickVals(JSON.stringify(['a', 'b'.repeat(41), 'c'.repeat(40)])), ['a', 'c'.repeat(40)]);
    assert.equal(parseQuickVals(JSON.stringify(Array.from({ length: 12 }, (_, i) => String(i)))).length, 8);
  });
});
