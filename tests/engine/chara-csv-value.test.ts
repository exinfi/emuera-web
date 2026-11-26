import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { csvInt64 } from '../../src/engine/runtime/charatemplates.ts';
import { run } from '../helpers.ts';

// Emuera ConstantData.tryToInt64 -> LexicalAnalyzer.ReadInt64: the value field of a chara CSV line takes hex/binary/exponent forms.
// Before: only plain decimal was accepted and everything else silently became 1 (eraFL 口上カラーコード 0xBF7357 -> 0x000001, near-black dialogue).
describe('chara CSV value field', () => {
  test('number forms', () => {
    assert.equal(csvInt64('0xBF7357'), 0xbf7357);
    assert.equal(csvInt64('0Xff'), 255);
    assert.equal(csvInt64('0b101'), 5);
    assert.equal(csvInt64('-12'), -12);
    assert.equal(csvInt64('3e2'), 300);
    assert.equal(csvInt64('12abc'), 12);
    assert.equal(csvInt64('abc'), undefined);
    assert.equal(csvInt64(''), undefined);
  });
  test('a hex CFLAG value loads as its number', async () => {
    const r = await run('@SYSTEM_TITLE\nADDCHARA 10\nPRINTFORML {CFLAG:0:41}\nQUIT\n', {
      csv: { 'CSV/CFLAG.CSV': '41,col\n', 'CSV/Chara10_T.csv': '番号,10\n名前,T\nCFLAG,col,0xBF7357\n' },
    });
    assert.ok(r.output.join('\n').includes(String(0xbf7357)));
  });
});
