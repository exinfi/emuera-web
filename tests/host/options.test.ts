import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_OPTIONS, OPTION_DEFS } from '../../src/host/protocol.ts';

const def = (key: string) => OPTION_DEFS.find((d) => d.key === key);

describe('launcher options', () => {
  test('every option has its own id and its own key, and the defaults object holds each one', () => {
    assert.equal(new Set(OPTION_DEFS.map((d) => d.id)).size, OPTION_DEFS.length);
    assert.equal(new Set(OPTION_DEFS.map((d) => d.key)).size, OPTION_DEFS.length);
    for (const d of OPTION_DEFS) assert.equal((DEFAULT_OPTIONS as unknown as Record<string, boolean>)[d.key], d.default);
  });

  test('images are read on demand unless the player unticks it, and the box is shown', () => {
    assert.equal(def('ximages')?.default, true);
    assert.notEqual(def('ximages')?.hidden, true);
  });

  test('decoding every image up front is off by default and has no checkbox, but the key still exists for a host to send', () => {
    assert.equal(def('eager')?.default, false);
    assert.equal(def('eager')?.hidden, true);
    assert.equal(DEFAULT_OPTIONS.eager, false);
  });
});
