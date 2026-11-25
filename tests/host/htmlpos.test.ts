import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { posToPx } from '../../src/play/htmlpos.ts';

// Emuera: <button|nonbutton pos=N> puts the part at N * Config.FontSize / 100 pixels (ConsoleButtonString.LockPointX)
describe('html tag pos attribute', () => {
  test('a half-width cell is pos 50, so 16 cells at a 14 px font start 112 px in', () => {
    assert.equal(posToPx(16 * 50, 14), 112);
  });
  test('pos 100 is one font height', () => {
    assert.equal(posToPx(100, 16), 16);
    assert.equal(posToPx(100, 20), 20);
  });
  test('zero and negative positions scale the same way', () => {
    assert.equal(posToPx(0, 16), 0);
    assert.equal(posToPx(-50, 16), -8);
  });
  test('the fraction is kept for the sub-pixel carry', () => {
    assert.equal(posToPx(150, 15), 22.5);
  });
});
