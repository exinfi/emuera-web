/**
 * The translation queue (translation tier, no DOM). Lines are pushed as they are finished on screen; they are translated only while the
 * interpreter is idle (waiting for input), in small slices, newest first, so the game is never held up. A call into the translation
 * engine cannot be interrupted, so a slice is a few lines (tens to low hundreds of ms) and idleness is re-checked between slices.
 * When there is nothing left to do for `idleStopMs`, the provider is stopped, which frees the engine's memory.
 */
import { guardOutput, joinGroups, splitClauses } from './guards';
import { hasSource, splitMenu, type FilterProfile } from './filter';
import type { Memory, Provider } from './types';

export interface QueueDeps {
  provider: Provider;
  memory: Memory;
  isIdle(): boolean;
  onResult(id: number, src: string, tr: string, flagged: boolean): void;
  onError?(msg: string): void;
  /** the original-language profile (which labels of a numbered choice line get translated) and the target language code; default ja to en */
  profile?: FilterProfile;
  to?: string;
  sliceSize?: number;
  maxQueue?: number;
  idleStopMs?: number;
  /** test hooks */
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export class TranslationQueue {
  private items: { id: number; text: string }[] = [];
  private live: Set<number> | null = null;
  private running = false;
  private stopped = false;
  private timer: unknown = null;
  private started = false;
  private failures = 0;
  readonly stats = { retried: 0, translated: 0, fromMemory: 0, dropped: 0, errors: 0, starts: 0 };
  constructor(private d: QueueDeps) {}

  private get slice() {
    return this.d.sliceSize ?? 3;
  }
  private get max() {
    return this.d.maxQueue ?? 400;
  }
  private setT(f: () => void, ms: number) {
    return (this.d.setTimer ?? ((g, m) => setTimeout(g, m)))(f, ms);
  }
  private clearT(h: unknown) {
    (this.d.clearTimer ?? ((x) => clearTimeout(x as any)))(h);
  }

  private get to() {
    return this.d.to ?? 'en';
  }
  get pending() {
    return this.items.length;
  }

  /** the filter profile can be changed live (it only affects which choice labels are translated) */
  setProfile(p: FilterProfile) {
    this.d.profile = p;
  }

  /** a finished line; answered straight from memory when seen before */
  push(id: number, text: string) {
    if (this.stopped) return;
    const hit = this.d.memory.get(text);
    if (hit) {
      this.stats.fromMemory++;
      this.d.onResult(id, text, hit.tr, hit.flagged);
      return;
    }
    this.items.push({ id, text });
    while (this.items.length > this.max) {
      this.items.shift();
      this.stats.dropped++;
    }
  }
  /** the line ids currently on screen; queued lines that were cleared are skipped */
  setLive(ids: Set<number>) {
    this.live = ids;
  }
  /** call when new lines arrived or the game became idle */
  wake() {
    if (this.stopped) return;
    if (this.timer !== null) {
      this.clearT(this.timer);
      this.timer = null;
    }
    if (!this.running) void this.run();
  }
  /** stop for good (feature switched off or game reset): drops the queue and frees the provider */
  stop() {
    this.stopped = true;
    this.items = [];
    if (this.timer !== null) {
      this.clearT(this.timer);
      this.timer = null;
    }
    this.d.provider.stop();
    this.started = false;
  }
  /** clear the queue only (a new game) */
  reset() {
    this.items = [];
    this.live = null;
  }

  private takeSlice() {
    const out: { id: number; text: string }[] = [];
    while (out.length < this.slice && this.items.length) {
      const it = this.items.pop()!; // newest first
      if (this.live && !this.live.has(it.id)) {
        this.stats.dropped++;
        continue;
      }
      const hit = this.d.memory.get(it.text);
      if (hit) {
        this.stats.fromMemory++;
        this.d.onResult(it.id, it.text, hit.tr, hit.flagged);
        continue;
      }
      out.push(it);
    }
    return out;
  }

  /** a looping or empty result: translate the line clause group by clause group and keep the better of the two */
  private async retryByClauses(text: string, first: { text: string; flagged: boolean }) {
    const sp = splitClauses(text);
    if (!sp) return first;
    try {
      const outs = await this.d.provider.translate(sp.groups);
      const g = guardOutput(text, joinGroups(outs, sp.quoted, this.to), this.to);
      this.stats.retried++;
      return g.text && (!g.flagged || first.flagged) ? g : first;
    } catch {
      return first;
    }
  }

  private async run() {
    this.running = true;
    try {
      while (!this.stopped && this.d.isIdle()) {
        const batch = this.takeSlice();
        if (!batch.length) {
          if (!this.items.length) break;
          continue;
        }
        if (!this.started) {
          await this.d.provider.start();
          this.started = true;
          this.stats.starts++;
          if (this.stopped) return;
        }
        // identical texts in one slice are translated once; a numbered-choice line is translated label by label (the [n] markers are kept)
        const uniq = [...new Set(batch.map((b) => b.text))];
        const JA = { test: (x: string) => hasSource(x, this.d.profile ?? 'ja') };
        const plan = uniq.map((t) => ({ menu: splitMenu(t), from: 0, n: 0 }));
        const send: string[] = [];
        uniq.forEach((t, i) => {
          const pl = plan[i];
          pl.from = send.length;
          const parts = pl.menu ? [pl.menu.head, ...pl.menu.items.map((x) => x.label)].filter((x) => JA.test(x)) : [t];
          send.push(...parts);
          pl.n = parts.length;
        });
        let outs: string[];
        try {
          const raw = await this.d.provider.translate(send);
          this.failures = 0;
          outs = uniq.map((_t, i) => {
            const pl = plan[i];
            if (!pl.menu) return raw[pl.from] ?? '';
            let g = pl.from;
            const tr = (x: string) => (JA.test(x) ? (raw[g++] ?? '').trim() : x.trim());
            const head = tr(pl.menu.head);
            const items = pl.menu.items.map((it) => `${it.mark} ${tr(it.label)}`);
            return [head, ...items].filter(Boolean).join('  ');
          });
        } catch (e) {
          this.stats.errors++;
          this.d.onError?.(String((e as Error)?.message ?? e));
          this.d.provider.stop();
          this.started = false;
          if (++this.failures >= 3) {
            this.d.onError?.('translation stopped after 3 failures in a row');
            this.stopped = true;
            this.items = [];
            return;
          }
          continue;
        }
        const done: { text: string; tr: string; flagged: boolean }[] = [];
        const by = new Map<string, { tr: string; flagged: boolean }>();
        for (let i = 0; i < uniq.length; i++) {
          const t = uniq[i];
          let g = guardOutput(t, outs[i] ?? '', this.to);
          if (g.flagged && !plan[i].menu) g = await this.retryByClauses(t, g);
          by.set(t, { tr: g.text, flagged: g.flagged });
          done.push({ text: t, ...by.get(t)! });
        }
        this.d.memory.put(done);
        this.stats.translated += uniq.length;
        for (const b of batch) {
          const r = by.get(b.text)!;
          this.d.onResult(b.id, b.text, r.tr, r.flagged);
        }
        await new Promise<void>((ok) => this.setT(ok, 0)); // let the page breathe between slices
      }
    } finally {
      this.running = false;
      if (!this.stopped && this.started && this.timer === null) {
        this.timer = this.setT(() => {
          this.timer = null;
          if (!this.items.length && !this.running) {
            this.d.provider.stop();
            this.started = false;
          } else this.wake();
        }, this.d.idleStopMs ?? 20000);
      }
    }
  }
}
