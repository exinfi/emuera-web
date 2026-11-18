/**
 * Translation zips: reading and checking their manifest (translation tier; no DOM, works in node for tests).
 * Two kinds, so the engine is dropped once and each language is a small separate zip:
 *   kind 'translation-engine'  the Bergamot engine files only (no models)
 *   kind 'translation-pack'    one or more models, with or without the engine (a pack that carries the engine too is self-contained,
 *                              like the original translation-ja-en.zip)
 */
import JSZip from 'jszip';

export interface EngineSpec {
  name: string;
  package?: string;
  build?: string;
  worker: string;
  glue: string;
  wasm: string;
}
export interface ModelSpec {
  from: string;
  to: string;
  variant?: string;
  model: string;
  shortlist: string;
  vocabs: string[];
}
export interface TlManifest {
  format: 1;
  kind: 'translation-pack' | 'translation-engine';
  name: string;
  engine?: EngineSpec;
  models?: ModelSpec[];
  sha256?: Record<string, string>;
  licenses?: string[];
}
export const MANIFEST = 'translation.json';

/** the id a model is chosen and remembered by: "ja>en", or "ja>en:variant" when the pack names a variant */
export const modelId = (m: Pick<ModelSpec, 'from' | 'to' | 'variant'>): string =>
  `${m.from}>${m.to}` + (m.variant ? ':' + m.variant : '');
export const modelsOf = (m: TlManifest): ModelSpec[] => m.models ?? [];

/**
 * A zip of Mozilla model files exactly as downloaded (decompressed), with no translation.json: found by file name, so users can build a
 * language pack by just zipping the three files. Names: model.<pair>.intgemm*.bin, lex.*.<pair>.s2t.bin, and vocab.<pair>.spm (shared) or
 * srcvocab.<pair>.spm + trgvocab.<pair>.spm. <pair> is two letters twice, e.g. jaen, koen, zhen. Returns null when it does not look like one.
 */
export function sniffMozilla(names: string[]): TlManifest | null {
  const find = (re: RegExp) => names.find((n) => re.test(n.split('/').pop()!));
  const model = find(/^model\.[a-z]{4}\.intgemm.*\.bin$/i);
  if (!model) return null;
  const pair = model.split('/').pop()!.slice(6, 10).toLowerCase();
  const lex = find(new RegExp(`^lex\\..*\\.${pair}\\.s2t.*\\.bin$`, 'i'));
  const shared = find(new RegExp(`^vocab\\.${pair}\\.spm$`, 'i'));
  const src = find(new RegExp(`^srcvocab\\.${pair}\\.spm$`, 'i')),
    trg = find(new RegExp(`^trgvocab\\.${pair}\\.spm$`, 'i'));
  const vocabs = shared ? [shared] : src && trg ? [src, trg] : null;
  if (!lex || !vocabs) return null;
  const from = pair.slice(0, 2),
    to = pair.slice(2);
  return {
    format: 1,
    kind: 'translation-pack',
    name: `Mozilla ${from}-${to} model`,
    models: [{ from, to, model, shortlist: lex, vocabs }],
  };
}

/** is this zip a translation zip of either kind, or a plain zip of Mozilla model files (cheap: reads the zip directory only) */
export async function isTranslationZip(data: Blob | Uint8Array): Promise<boolean> {
  try {
    const z = await JSZip.loadAsync(data);
    return !!z.file(MANIFEST) || !!sniffMozilla(Object.keys(z.files));
  } catch {
    return false;
  }
}

/** read and validate the manifest; throws with a plain message when the zip is not a usable translation zip */
export async function readManifest(data: Blob | Uint8Array): Promise<TlManifest> {
  const z = await JSZip.loadAsync(data);
  const f = z.file(MANIFEST);
  let m: TlManifest | null = null;
  if (f) {
    try {
      m = JSON.parse(await f.async('string'));
    } catch {
      throw new Error(`${MANIFEST} is not valid JSON`);
    }
  } else m = sniffMozilla(Object.keys(z.files));
  if (!m)
    throw new Error(
      `no ${MANIFEST} in this zip, and it does not hold a complete set of Mozilla model files (model, lex, vocab), so it is not a translation pack`,
    );
  if (m.format !== 1 || (m.kind !== 'translation-pack' && m.kind !== 'translation-engine'))
    throw new Error(`${MANIFEST}: unsupported format (need format 1, translation-pack or translation-engine)`);
  const need: string[] = [];
  if (m.kind === 'translation-engine' && !m.engine)
    throw new Error(`${MANIFEST}: an engine zip must describe its engine files`);
  if (m.engine) need.push(m.engine.worker, m.engine.glue, m.engine.wasm);
  if (m.kind === 'translation-pack') {
    if (!Array.isArray(m.models) || !m.models.length) throw new Error(`${MANIFEST}: no models listed`);
    for (const x of m.models) {
      need.push(x.model, x.shortlist, ...(x.vocabs ?? []));
      if (!x.from || !x.to) throw new Error(`${MANIFEST}: a model has no from/to language`);
    }
  }
  for (const p of need)
    if (!p || !z.file(p)) throw new Error(`${MANIFEST} lists "${p}" but the zip does not contain it`);
  return m;
}
