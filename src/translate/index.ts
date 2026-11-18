/**
 * Translation controller (translation tier). Optional and sandboxed: with the feature off nothing here runs, nothing is stored or loaded,
 * and no worker exists. When on, it is a read-only consumer of the finished lines the page already receives; it never writes into the game.
 * The shell calls `onScreen` with each screen, `setIdle` when the interpreter starts or stops waiting for input, and `newGame` on a game load.
 */
import type { ScreenMsg } from '../host/protocol';
import { FILTER_PROFILES, lineText, profileForLanguage, skipReason, type FilterProfile } from './filter';
import { identifyPack } from './known';
import { isTranslationZip, modelId, modelsOf, readManifest, type EngineSpec, type ModelSpec } from './pack';
import { createPanel, type Panel } from './panel';
import { TranslationQueue } from './queue';
import * as Store from './store';
import { BergamotProvider } from './bergamot';
import type { Memory, Provider } from './types';

type Mem = Memory & { size(): number; clear(): Promise<void>; flush(): Promise<void> };
/** where a provider reads its files from: the engine and the model may be in different zips */
export interface ProviderSrc {
  engine: { blob: () => Promise<Blob>; spec: EngineSpec };
  model: { blob: () => Promise<Blob>; spec: ModelSpec };
}
/** one selectable model: which zip holds it, which zip supplies the engine (null: no engine installed yet) */
export interface ModelChoice {
  id: string;
  from: string;
  to: string;
  label: string;
  spec: ModelSpec;
  pack: Store.PackRecord;
  engine: { pack: Store.PackRecord; spec: EngineSpec } | null;
}

/** the models offered by the installed zips; a later zip wins when two offer the same id; the engine comes from the model's own zip, else the engine zip, else any zip that carries one */
export function resolveModels(records: Store.PackRecord[]): ModelChoice[] {
  const eng =
    [...records].reverse().find((r) => r.key === 'engine') ?? [...records].reverse().find((r) => r.manifest.engine);
  const byId = new Map<string, ModelChoice>();
  for (const r of records)
    for (const spec of modelsOf(r.manifest)) {
      const own = r.manifest.engine ? { pack: r, spec: r.manifest.engine } : null;
      const shared = eng?.manifest.engine ? { pack: eng, spec: eng.manifest.engine } : null;
      byId.set(modelId(spec), {
        id: modelId(spec),
        from: spec.from,
        to: spec.to,
        label: `${spec.from} → ${spec.to}${spec.variant ? ` (${spec.variant})` : ''}`,
        spec,
        pack: r,
        engine: own ?? shared,
      });
    }
  return [...byId.values()].sort((x, y) => x.id.localeCompare(y.id));
}

export interface TlHost {
  /** engine-notes style debug line */
  say(msg: string): void;
  /** localStorage-like flag store, wrapped by the shell */
  flag(key: string, v?: string): string | null;
  /** factories for tests; defaults are the real storage, panel and engine */
  makePanel?: () => Panel;
  makeProvider?: (src: ProviderSrc) => Provider;
  getPacks?: () => Promise<Store.PackRecord[]>;
  openMemory?: (gameId: string, model: string) => Promise<Mem>;
}
export const TL_FLAG = 'emu.tl';
export const TL_COPY_FLAG = 'emu.tl.copy';
export const TL_MODEL_FLAG = 'emu.tl.model';
/** '' or 'auto' follows the model's source language; otherwise one of the profile names */
export const TL_FILTER_FLAG = 'emu.tl.filter';

export class Translation {
  private on = false;
  private idle = false;
  private gameId = '';
  private panel: Panel | null = null;
  private queue: TranslationQueue | null = null;
  private mem: Mem | null = null;
  private model: ModelChoice | null = null;
  private profile: FilterProfile = 'ja';
  private seen = new Set<number>();
  private src = new Map<number, string>();
  private gen = 0;
  readonly counts: Record<string, number> = {};

  constructor(private h: TlHost) {}

  get enabled() {
    return this.on;
  }

  // ------------------------------------------------------------------ packs and models
  private packs() {
    return (this.h.getPacks ?? Store.listPacks)();
  }
  /** the installed zips, for the Controls summary */
  async packInfo() {
    return (await this.packs()).map((p) => ({
      key: p.key,
      name: p.name,
      size: p.size,
      added: p.added,
      title: p.manifest.name,
      kind: p.manifest.kind,
      models: modelsOf(p.manifest)
        .map((m) => `${m.from}→${m.to}`)
        .join(', '),
    }));
  }
  /** the models that can be chosen, with whether an engine is available for each */
  async modelChoices() {
    return resolveModels(await this.packs()).map((c) => ({ id: c.id, label: c.label, ready: !!c.engine }));
  }
  /** kept for shells that show it after an add; always '' now (an unknown engine is refused with an error instead) */
  lastNotice = '';
  async addPack(file: File): Promise<string> {
    const manifest = await readManifest(file); // throws before anything is stored
    const verdict = await identifyPack(file, manifest);
    this.lastNotice = '';
    if (!verdict.recognised) throw new Error(verdict.notice); // nothing is stored
    await Store.putPack({
      key: Store.packKey(manifest),
      name: file.name,
      size: file.size,
      added: new Date().toISOString(),
      manifest,
      blob: file,
      recognised: verdict.recognised,
    });
    if (this.on) {
      this.disable();
      await this.enable();
    }
    return manifest.name;
  }
  async removePack() {
    this.disable();
    this.h.flag(TL_FLAG, '');
    await Store.removeAllPacks();
  }
  isPackZip(f: Blob | Uint8Array) {
    return isTranslationZip(f);
  }

  /** the chosen model id (what the picker shows), '' when none is chosen yet */
  modelSetting() {
    return this.h.flag(TL_MODEL_FLAG) ?? '';
  }
  async selectModel(id: string) {
    this.h.flag(TL_MODEL_FLAG, id);
    if (this.on) {
      this.disable();
      await this.enable();
    }
  }
  filterSetting(): 'auto' | FilterProfile {
    const v = this.h.flag(TL_FILTER_FLAG);
    return (FILTER_PROFILES as readonly string[]).includes(v ?? '') ? (v as FilterProfile) : 'auto';
  }
  setFilter(p: 'auto' | FilterProfile) {
    this.h.flag(TL_FILTER_FLAG, p === 'auto' ? '' : p);
    this.profile = this.pickProfile();
    this.queue?.setProfile(this.profile);
    this.seen.clear();
    this.src.clear();
  }
  /** the filter in effect now (auto follows the active model's source language) */
  activeProfile() {
    return this.profile;
  }
  private pickProfile(): FilterProfile {
    const f = this.filterSetting();
    return f !== 'auto' ? f : this.model ? profileForLanguage(this.model.from) : 'ja';
  }

  // ------------------------------------------------------------------ switch
  copyWanted() {
    return this.h.flag(TL_COPY_FLAG) === '1';
  }
  setCopy(on: boolean) {
    this.h.flag(TL_COPY_FLAG, on ? '1' : '');
    this.panel?.setCopy?.(on);
  }
  /** true when the flag says on (read at boot; nothing else is touched until `enable`) */
  wantedOn() {
    return this.h.flag(TL_FLAG) === '1';
  }
  async enable(): Promise<boolean> {
    if (this.on) return true;
    const choices = resolveModels(await this.packs());
    if (!choices.length) {
      this.h.say(
        'Translation: no translation model is installed (drop a language zip such as translation-ja-en.zip, and the engine zip if it is separate).',
      );
      return false;
    }
    const want = this.modelSetting();
    const pick = choices.find((c) => c.id === want) ?? choices.find((c) => c.id.startsWith('ja>en')) ?? choices[0];
    if (!pick.engine) {
      this.h.say(
        `Translation: ${pick.label} is installed but there is no translation engine yet (drop translation-engine.zip).`,
      );
      return false;
    }
    this.model = pick;
    this.profile = this.pickProfile();
    this.on = true;
    this.h.flag(TL_FLAG, '1');
    this.panel = (this.h.makePanel ?? (() => createPanel()))();
    this.panel.setCopy?.(this.copyWanted());
    const eng = pick.engine;
    const provider = (this.h.makeProvider ?? ((s) => new BergamotProvider(s)))({
      engine: { blob: async () => eng.pack.blob, spec: eng.spec },
      model: { blob: async () => pick.pack.blob, spec: pick.spec },
    });
    this.queue = new TranslationQueue({
      provider,
      memory: { get: (t) => this.mem?.get(t), put: (e) => this.mem?.put(e) },
      isIdle: () => this.idle,
      profile: this.profile,
      to: pick.to,
      onResult: (id, s, tr, flagged) => {
        this.panel?.update({ id, src: s, tr, flagged });
        this.panel?.setStatus(`${this.mem?.size() ?? 0} saved`);
      },
      onError: (m) => {
        this.h.say('Translation: ' + m);
        this.panel?.setStatus('error, see Debug');
      },
    });
    this.panel.setStatus('ready');
    if (this.gameId) await this.newGame(this.gameId);
    this.h.say(`Translation: on (${pick.label}, filter ${this.profile}). Output only: game text is never changed.`);
    return true;
  }
  disable() {
    if (!this.on) return;
    this.on = false;
    this.h.flag(TL_FLAG, '');
    this.queue?.stop();
    this.queue = null;
    void this.mem?.flush();
    this.mem = null;
    this.panel?.destroy();
    this.panel = null;
    this.seen.clear();
    this.src.clear();
  }
  async clearMemory() {
    await this.mem?.clear();
    this.h.say('Translation: saved translations for this game cleared.');
  }
  memorySize() {
    return this.mem?.size() ?? 0;
  }

  // ------------------------------------------------------------------ the three hooks the shell calls
  async newGame(gameId: string) {
    this.gameId = gameId;
    if (!this.on) return;
    const g = ++this.gen;
    this.queue?.reset();
    this.seen.clear();
    this.src.clear();
    this.panel?.clear();
    const mem = await (this.h.openMemory ?? Store.openMemory)(gameId, this.model?.id ?? 'ja>en');
    if (g !== this.gen || !this.on) return;
    void this.mem?.flush();
    this.mem = mem;
    this.panel?.setStatus(`ready, ${mem.size()} saved`);
  }
  setIdle(idle: boolean) {
    this.idle = idle;
    if (this.on && idle) this.queue?.wake();
  }
  /** every `screen` message; read-only (the message is not modified) */
  onScreen(m: Pick<ScreenMsg, 'lines' | 'lineIds'>) {
    if (!this.on || !this.queue || !this.mem || !m.lineIds) return;
    const live = new Set<number>();
    for (let i = 0; i < m.lines.length; i++) {
      const id = m.lineIds[i];
      if (id === undefined || id < 0) continue; // -1 is the unfinished line being typed
      live.add(id);
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      const text = lineText(m.lines[i]);
      if (text === null) {
        this.counts['layout'] = (this.counts['layout'] ?? 0) + 1;
        continue;
      }
      const why = skipReason(text, this.profile);
      if (why) {
        this.counts[why] = (this.counts[why] ?? 0) + 1;
        continue;
      }
      const t = text.trim();
      this.src.set(id, t);
      this.panel?.add({ id, src: t });
      this.queue.push(id, t);
    }
    if (this.seen.size > 6000) {
      for (const id of this.seen) if (!live.has(id)) this.seen.delete(id);
    }
    this.queue.setLive(live);
    if (this.idle) this.queue.wake();
  }
}
