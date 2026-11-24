import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { out, run } from '../helpers.ts';

// Source: EM+EE DataTableToXmlMethod / DataTableFromXmlMethod and XmlAddNodeMethod, XmlReplaceMethod, XmlRemoveNodeMethod (Creator.Method.cs).
// The .NET schema writer puts the primary key in an xs:unique constraint and sets no auto-increment on the id column.
const game = (body: string[]) => ['@SYSTEM_TITLE', ...body, 'QUIT'];
const P = async (body: string[]) => await run(game(body));

describe('DT_TOXML schema (.NET layout)', () => {
  test('no auto-increment, primary-key constraint, and it reloads', async () => {
    const r = await out(
      game([
        'DT_CREATE "T"',
        'DT_COLUMN_ADD "T", "n", "int32"',
        'DT_ROW_ADD "T", "n", 4',
        'DT_ROW_ADD "T", "n", 9',
        'LOCAL:0 = DT_ROW_ADD("T", "n", 11)',
        'STR:0 \'= DT_TOXML("T")',
        "STR:1 '= RESULTS:1",
        'PRINTFORML {STRCOUNT(STR:1, "AutoIncrement")} {STRCOUNT(STR:1, "msdata:PrimaryKey")}',
        'DT_RELEASE "T"',
        'PRINTFORML {DT_FROMXML("T", STR:1, STR:0)} {DT_ROW_LENGTH("T")} {DT_ROW_REMOVE("T", LOCAL:0)} {DT_ROW_LENGTH("T")}',
      ]),
    );
    assert.deepEqual(r, ['0 1', '1 3 1 2']);
  });
});

describe('XML probes', () => {
  test('XML_ADDNODE before/after the root element', async () => {
    const r = await P([
      'XML_DOCUMENT 1, "<a><b/></a>"',
      'PRINTFORML {XML_ADDNODE(1, "/a", "<c/>", 1)} {XML_ADDNODE(1, "/a/b", "<c/>", 2)}',
      'PRINTSL XML_TOSTR(1)',
    ]);
    assert.match(r.errors.join('|'), /already has a 'DocumentElement'/); // .NET throws; so do we
  });
  test('REPLACE / REMOVENODE with no match', async () => {
    const r = await P([
      'XML_DOCUMENT 1, "<a><b x=\'1\'/></a>"',
      'PRINTFORML {XML_REPLACE(1, "/a/zz", "<q/>")} {XML_REMOVENODE(1, "/a/zz")} {XML_REMOVEATTRIBUTE(1, "/a/b/@y")} {XML_ADDNODE(1, "/a/zz", "<q/>")}',
      'PRINTFORML {XML_REPLACE(9, "<q/>")} {XML_REMOVENODE(9, "/a")} {XML_SET(9, "/a", "v")}',
    ]);
    assert.deepEqual(
      r.output.map((l) => l.trim()),
      ['0 0 0 0', '-1 -1 -1'],
    );
  });
  test('attribute insertion', async () => {
    const r = await P([
      'XML_DOCUMENT 1, "<a><b x=\'1\'/></a>"',
      'PRINTFORML {XML_ADDATTRIBUTE(1, "/a/b", "y", "2")} {XML_ADDATTRIBUTE(1, "/a/b/@x", "z", "3", 1)} {XML_ADDATTRIBUTE(1, "/a/b", "w", "3", 1)} {XML_ADDATTRIBUTE(1, "/a/b", "y", "9")}',
      'PRINTSL XML_TOSTR(1)',
    ]);
    assert.deepEqual(
      r.output.map((l) => l.trim()),
      ['1 1 0 1', '<a><b z="3" x="1" y="9" /></a>'],
    );
  });
});
