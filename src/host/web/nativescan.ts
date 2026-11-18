/**
 * Recognise Emuera's own save files (host-web tier, no engine code): the signature and header are read without a game loaded,
 * so a shell can tell the player what a dropped file is before anything is converted. Layout: see docs / claude/native-save-spec.md.
 */
export interface NativeInfo {
  /** file name inside the drop (zip entry path or file name) */
  name: string;
  /** our slot key this file maps to (save7, global), or null when the name is not a slot name */
  key: string | null;
  kind: 'slot' | 'global' | 'other';
  /** format version in the header (1808 is what the converter was written for) */
  fmt: number;
  zipped: boolean;
  gameCode: string;
  gameVersion: number;
  /** the header text the load screen shows */
  info: string;
  /** number of characters in a normal save (null when unknown) */
  characters: number | null;
  size: number;
}
const SIG = [0x89, 0x45, 0x52, 0x41]; // "\x89ERA", then \r\n\x1a\n (plain) or ZIP\n (gzip body)
const TAIL_PLAIN = [0x0d, 0x0a, 0x1a, 0x0a],
  TAIL_ZIP = [0x5a, 0x49, 0x50, 0x0a];
const has = (b: Uint8Array, at: number, v: number[]) => v.every((x, i) => b[at + i] === x);

/** true when the bytes start with an Emuera save signature (plain or zipped) */
export const isNativeSave = (b: Uint8Array) =>
  b.length >= 16 && has(b, 0, SIG) && (has(b, 4, TAIL_PLAIN) || has(b, 4, TAIL_ZIP));

export const slotKeyOfFile = (name: string): string | null => {
  const base = name.replace(/^.*[\\/]/, '').toLowerCase();
  if (base === 'global.sav') return 'global';
  const m = /^save(\d+)\.sav$/.exec(base);
  return m ? 'save' + Number(m[1]) : null;
};

async function gunzipHead(b: Uint8Array): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(
      await new Response(new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(),
    );
  } catch {
    return null;
  }
}

/** read the header of a file; null when it is not an Emuera save */
export async function scanNative(name: string, bytes: Uint8Array): Promise<NativeInfo | null> {
  if (!isNativeSave(bytes)) return null;
  const zipped = has(bytes, 4, TAIL_ZIP);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fmt = dv.getUint32(8, true),
    count = dv.getUint32(12, true);
  const start = 16 + count * 4;
  if (count > 1 << 20 || start >= bytes.length) return null;
  const body = zipped ? await gunzipHead(bytes.subarray(start)) : bytes.subarray(start);
  if (!body || body.length < 18) return null;
  const bd = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const type = body[0];
  let p = 1;
  const code = bd.getBigInt64(p, true);
  p += 8;
  const gv = bd.getBigInt64(p, true);
  p += 8;
  let len = 0,
    sh = 0,
    x: number;
  do {
    if (p >= body.length) return null;
    x = body[p++];
    len |= (x & 0x7f) << sh;
    sh += 7;
  } while (x & 0x80);
  if (p + len > body.length) return null;
  let info = '';
  for (let i = 0; i < len; i += 2) info += String.fromCharCode(bd.getUint16(p + i, true));
  p += len;
  const characters = type === 0 && p + 8 <= body.length ? Number(bd.getBigInt64(p, true)) : null;
  return {
    name,
    key: slotKeyOfFile(name),
    kind: type === 0 ? 'slot' : type === 1 ? 'global' : 'other',
    fmt,
    zipped,
    gameCode: String(code),
    gameVersion: Number(gv),
    info,
    characters,
    size: bytes.length,
  };
}

/** a short line for one file, for the confirmation the shell shows */
export const describeNative = (i: NativeInfo): string =>
  `${i.name}: ${i.kind === 'global' ? 'global data' : i.kind === 'slot' ? `save${i.characters !== null ? `, ${i.characters} character(s)` : ''}${i.info ? `, "${i.info}"` : ''}` : 'a variable file (not a game save)'}` +
  `, game code ${i.gameCode} v${i.gameVersion}, format ${i.fmt}${i.zipped ? ' (compressed)' : ''}`;
