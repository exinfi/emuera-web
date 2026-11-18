import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { Client, type PointerDown } from '../../src/host/client.ts';
import type { ToPage, ToWorker } from '../../src/host/protocol.ts';

/** A client wired to a stub worker: everything the shell would send comes back in `sent`. */
function rig() {
  const sent: ToWorker[] = [];
  let onmessage: ((e: { data: ToPage }) => void) | null = null;
  const worker: any = {
    postMessage: (m: ToWorker) => sent.push(m),
    terminate: () => {},
    set onmessage(f: any) {
      onmessage = f;
    },
  };
  const hooks: any = {
    screen: () => {},
    sound: () => {},
    title: () => {},
    textbox: () => {},
    status: () => {},
    busy: () => {},
    persist: () => {},
    persistFile: () => {},
    restart: () => {},
    errreport: () => {},
    fatal: () => {},
    logexport: () => {},
    inputLog: () => {},
  };
  const c = new Client(hooks);
  c.reset(() => worker);
  const screen = (kind: string) =>
    onmessage!({
      data: {
        type: 'screen',
        lines: [],
        island: [],
        bgs: [],
        kind,
        notes: [],
        imgStats: { n: 0, of: 0, mb: 0 },
        sprites: {},
        tooltip: { custom: false, delay: 500, duration: 0, format: 0, img: false },
        layers: [],
        buttons: [],
        sizes: {},
        missing: [],
        cfg: { w: 760, h: 480, fontSize: 16, lineHeight: 19, font: 'x', fg: 0, bg: 0 },
      } as any,
    });
  const down = (o: Partial<PointerDown> = {}): boolean =>
    c.pointerDown({ button: 0, x: 10, y: -5, inside: true, onChrome: false, onControl: false, ...o });
  const inputs = () => sent.filter((m) => m.type === 'input').map((m) => (m as any).value);
  return { c, sent, screen, down, inputs };
}

describe('input rules every shell relies on', () => {
  test('a number prompt takes typed input once, and a click does not answer it', () => {
    const r = rig();
    r.screen('int');
    assert.equal(r.c.submit('5'), true);
    assert.deepEqual(r.inputs(), ['5']);
    r.screen('int');
    r.down();
    assert.deepEqual(r.inputs(), ['5']);
  });

  test('a left click at a wait continues it; a click on the controls does not', () => {
    const r = rig();
    r.screen('wait');
    r.down();
    assert.deepEqual(r.inputs(), ['']);
    const r2 = rig();
    r2.screen('wait');
    r2.down({ onControl: true });
    assert.deepEqual(r2.inputs(), []);
  });

  test('a button handles its own click, so the wait is not also continued', () => {
    const r = rig();
    r.screen('anykey');
    r.down({ pressButton: () => {} });
    assert.deepEqual(r.inputs(), []);
  });
});

describe('INPUTMOUSEKEY clicks', () => {
  test('a stage click becomes a mouse event; a click on the page chrome does not', () => {
    const r = rig();
    r.screen('mousekey');
    assert.equal(r.down({ button: 2, x: 100, y: -40 }), true);
    assert.deepEqual(r.sent.at(-1), { type: 'mousekey', ev: [1, 0x200000, 100, -40, 0, 0] });
    const n = r.sent.length;
    r.screen('mousekey');
    r.down({ onChrome: true });
    assert.equal(r.sent.length, n);
  });

  test('the button value under the press is posted before the click (a touch shell has no hover)', () => {
    const r = rig();
    r.screen('mousekey');
    r.down({ button: 0, x: 20, y: -10, pointing: '0' });
    assert.deepEqual(r.sent.slice(-2), [
      { type: 'pointing', value: '0' },
      { type: 'mousekey', ev: [1, 0x100000, 20, -10, 0, 0] },
    ]);
    r.screen('mousekey');
    r.down({ button: 0, x: 5, y: -5, pointing: '' });
    assert.deepEqual(r.sent.slice(-2), [
      { type: 'pointing', value: '' },
      { type: 'mousekey', ev: [1, 0x100000, 5, -5, 0, 0] },
    ]);
  });

  test('without a pointing value nothing extra is sent: the last hover value stands', () => {
    const r = rig();
    r.screen('mousekey');
    r.down({ button: 0, x: 7, y: -7 });
    assert.deepEqual(r.sent.slice(-1), [{ type: 'mousekey', ev: [1, 0x100000, 7, -7, 0, 0] }]);
  });

  test('the wheel over the stage becomes an event only while a mouse prompt is open', () => {
    const r = rig();
    assert.equal(r.c.wheel(-1, 1, -1, true), false);
    r.screen('mousekey');
    assert.equal(r.c.wheel(-1, 1, -1, true), true);
    assert.deepEqual(r.sent.at(-1), { type: 'mousekey', ev: [2, 120, 1, -1, 0, 0] });
  });
});
