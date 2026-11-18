/**
 * The local translation provider: the Bergamot engine (WebAssembly) in its own Web Worker, started from the files of the translation pack.
 * The pack's files are used exactly as shipped. The worker is a tiny bootstrap that points the engine's two relative file lookups at
 * blob URLs; `terminate()` on stop returns all of the engine's memory.
 */
import JSZip from 'jszip';
import type { EngineSpec, ModelSpec } from './pack';
import { assertKnownEngine } from './known';
import type { Provider } from './types';

const BOOT = (map: Record<string, string>) => `
const MAP=${JSON.stringify(map)};
const base=(u)=>String(u).split('/').pop();
const f=self.fetch.bind(self), imp=self.importScripts.bind(self);
self.fetch=(u,o)=>MAP[base(u)]?f(MAP[base(u)],o):f(u,o);
self.importScripts=(...a)=>imp(...a.map((x)=>MAP[base(x)]||x));
try{Object.defineProperty(self,'location',{value:new URL('http://translation.invalid/engine/'),configurable:true});}catch(e){}
imp(MAP['translator-worker.js']);
`;

export class BergamotProvider implements Provider {
  readonly name = 'bergamot';
  private w: Worker | null = null;
  private urls: string[] = [];
  private id = 0;
  private pend = new Map<number, { ok: (v: any) => void; no: (e: Error) => void }>();
  private starting: Promise<void> | null = null;
  private pair: { from: string; to: string } | null = null;
  /**
   * The engine files and the model files may come from different zips (an engine zip and a language zip) or from one (a combined pack:
   * pass the same getter, the zip is then read once). Zips are read one at a time and each is released once its files are extracted.
   */
  constructor(
    private src: {
      engine: { blob: () => Promise<Blob>; spec: EngineSpec };
      model: { blob: () => Promise<Blob>; spec: ModelSpec };
    },
    private makeWorker: (src: string) => Worker = (s) =>
      new Worker(URL.createObjectURL(new Blob([s], { type: 'text/javascript' }))),
  ) {}

  private call(name: string, args: unknown[] = [], transfer: Transferable[] = []): Promise<any> {
    return new Promise((ok, no) => {
      const id = ++this.id;
      this.pend.set(id, { ok, no });
      this.w!.postMessage({ id, name, args }, transfer);
    });
  }

  start(): Promise<void> {
    if (this.w) return this.starting ?? Promise.resolve();
    this.starting = (async () => {
      const { engine, model: mdl } = this.src,
        model = mdl.spec;
      const same = engine.blob === mdl.blob;
      const blobUrl = async (z: JSZip, path: string, type: string) => {
        const u = URL.createObjectURL(new Blob([await z.file(path)!.async('arraybuffer')], { type }));
        this.urls.push(u);
        return u;
      };
      let mz = same ? await JSZip.loadAsync(await mdl.blob()) : null;
      const ez = mz ?? (await JSZip.loadAsync(await engine.blob()));
      await assertKnownEngine(ez, engine.spec); // the files that run as code must be the known ones, even from a zip stored earlier
      const map: Record<string, string> = {
        'translator-worker.js': await blobUrl(ez, engine.spec.worker, 'text/javascript'),
        'bergamot-translator-worker.js': await blobUrl(ez, engine.spec.glue, 'text/javascript'),
        'bergamot-translator-worker.wasm': await blobUrl(ez, engine.spec.wasm, 'application/wasm'),
      };
      if (!mz) mz = await JSZip.loadAsync(await mdl.blob());
      const z = mz;
      const src = URL.createObjectURL(new Blob([BOOT(map)], { type: 'text/javascript' }));
      this.urls.push(src);
      const w = (this.w = new Worker(src));
      w.onmessage = (e: MessageEvent) => {
        const { id, result, error } = e.data ?? {};
        const p = this.pend.get(id);
        if (!p) return;
        this.pend.delete(id);
        error ? p.no(new Error(error.message || error.name || 'engine error')) : p.ok(result);
      };
      w.onerror = (e) => {
        const err = new Error('engine worker error: ' + (e.message || 'failed to start'));
        for (const p of this.pend.values()) p.no(err);
        this.pend.clear();
      };
      await this.call('initialize', [{ useNativeIntGemm: false, cacheSize: 0 }]);
      const buf = async (p: string) => await z.file(p)!.async('arraybuffer');
      const [mb, lb, ...vb] = await Promise.all([buf(model.model), buf(model.shortlist), ...model.vocabs.map(buf)]);
      this.pair = { from: model.from, to: model.to };
      // the vocabulary is shared by source and target: the same buffer twice is de-duplicated by the engine wrapper
      const vocabs = vb.length === 1 ? [vb[0], vb[0]] : vb;
      await this.call('loadTranslationModel', [this.pair, { model: mb, shortlist: lb, vocabs }], [mb, lb, ...vb]);
    })().catch((e) => {
      this.stop();
      throw e;
    });
    return this.starting;
  }

  async translate(texts: string[]): Promise<string[]> {
    await this.start();
    const r = await this.call('translate', [
      { models: [this.pair], texts: texts.map((text) => ({ text, html: false })) },
    ]);
    return (r as { target: { text: string } }[]).map((x) => x.target.text);
  }

  stop() {
    this.w?.terminate();
    this.w = null;
    this.starting = null;
    this.pair = null;
    for (const p of this.pend.values()) p.no(new Error('translation engine stopped'));
    this.pend.clear();
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
  }
}
