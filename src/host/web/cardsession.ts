/**
 * Memory-card session (host-web tier): the "current card" for one loaded game, the chained write queue,
 * and the open/use/create/import/export/mount/eject/delete flows. No DOM; the shell supplies prompts/confirms
 * and renders the card UI. Storage primitives live in src/play/cards.ts.
 */
import * as Cards from '../../play/cards';

export type { Card, CardMeta, GameIdent, Slots } from '../../play/cards';

export interface CardSessionOptions {
  /** a failure the user should see (e.g. "SAVE FAILED: ..."); the shell decides where to show it */
  onError(text: string): void;
  /** optional: a save was written to a card that belonged to another game or another build of this one, and the card now belongs to the game that is running (`from` is what it said before) */
  onAssociate?(card: Cards.Card, from: { gameTitle: string; gameVersion: string; build: string; gameId: string }): void;
}

export class CardSession {
  ident: Cards.GameIdent | null = null;
  card: Cards.Card | null = null;
  /** a card chosen before any game was open; the first game that loads takes it (and claims it if it has no game id) */
  private pending: Cards.Card | null = null;
  private writes: Promise<void> = Promise.resolve();
  constructor(private o: CardSessionOptions) {}

  private key() {
    return 'emuera-card:' + (this.ident?.id ?? '');
  }
  private lsGet(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  }
  private lsSet(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  }
  private defaultId() {
    return 'default:' + this.ident!.id;
  }
  /** the game's own automatic card: one per game id, found again (never duplicated) on every load, named after the game so several games' cards can be told apart in the list */
  private autoName() {
    return `Browser memory (${this.ident!.title})`;
  }
  private async defaultCard(): Promise<Cards.Card> {
    const c =
      (await Cards.openCard(this.defaultId())) ??
      (await Cards.createCard(this.ident!, this.autoName(), this.defaultId()));
    if (c.meta.name === 'Browser memory') await Cards.renameCard(c, this.autoName()); // made before cards were named after their game
    return c;
  }
  /** writes are chained so a slow save never overlaps the next one */
  private enqueue(fn: () => Promise<void>) {
    this.writes = this.writes.then(fn).catch((e) => {
      console.warn('save failed', e);
      this.o.onError('SAVE FAILED: ' + e);
    });
  }
  /** resolves when every queued write has finished */
  flush(): Promise<void> {
    return this.writes;
  }

  /** a game was loaded: identify it and open the remembered card, else the default "Browser memory" card (v1 saves migrated in) */
  async open(
    csv: Record<string, string>,
    erb: Record<string, string | number>,
    fileName: string,
  ): Promise<{ saves: Cards.Slots; files: Record<string, string>; migrated: number }> {
    this.ident = Cards.identify(csv, erb, fileName);
    const pend = this.pending;
    this.pending = null;
    this.card = null;
    let migrated = 0;
    try {
      if (pend) {
        this.card = pend;
        if (!pend.paths.size)
          await Cards.adoptCard(pend, this.ident); // nothing stored yet: nothing to mismatch, it simply belongs to this game now
        else await Cards.claimCard(pend, this.ident);
        if (pend.where === 'browser') this.lsSet(this.key(), pend.id); // remembered as this game's card, as if picked by hand
      } else {
        const want = this.lsGet(this.key());
        this.card = (want && (await Cards.openCard(want))) || null;
        if (!this.card) {
          this.card = await this.defaultCard();
          if (!this.card.paths.size) {
            await Cards.adoptCard(this.card, this.ident);
            migrated = await Cards.importLegacy(fileName, this.card);
          } // an empty Browser memory card always carries the build that is open now
        }
      }
      if (this.card && this.card.id === this.defaultId() && this.card.meta.name === 'Browser memory')
        await Cards.renameCard(this.card, this.autoName()); // the remembered card can be the automatic one made under the old name
    } catch (e) {
      console.warn('card open failed', e);
      this.o.onError('CARD ERROR: ' + e);
    }
    const { saves, files } = this.card ? await Cards.readAll(this.card) : { saves: {}, files: {} };
    return { saves, files, migrated };
  }

  /** the engine's persist / persistFile messages */
  persist(key: string, v: { info: string; data: string } | null) {
    const c = this.card;
    if (!c) return;
    const [pd, pi] = Cards.slotPaths(key);
    const g = this.ident;
    this.enqueue(async () => {
      await Cards.writeFile(c, pd, v ? v.data : null);
      await Cards.writeFile(c, pi, v ? v.info : null);
      if (v && g) {
        // a save was carried out: from now on the card belongs to the game and build that wrote it
        const from = {
          gameTitle: c.meta.gameTitle,
          gameVersion: c.meta.gameVersion,
          build: c.meta.build,
          gameId: c.meta.gameId,
        };
        if (await Cards.adoptCard(c, g)) this.o.onAssociate?.(c, from);
      }
    });
  }
  persistFile(key: string, text: string) {
    const c = this.card;
    if (c)
      this.enqueue(async () => {
        await Cards.writeFile(c, 'dat/' + key, text);
      });
  }

  /** make `c` current and return its contents (the shell then calls client.setCard) */
  async use(c: Cards.Card): Promise<{ saves: Cards.Slots; files: Record<string, string> }> {
    await this.writes;
    this.card = c;
    if (!this.ident)
      this.pending = c; // no game yet: the next game that loads takes this card
    else if (c.where === 'browser') this.lsSet(this.key(), c.id);
    return Cards.readAll(c);
  }
  list() {
    return Cards.listCards().catch(() => [] as { id: string; meta: Cards.CardMeta }[]);
  }
  openById(id: string) {
    return Cards.openCard(id);
  }
  create(name: string) {
    return Cards.createCard(this.ident!, name);
  }
  importZip(f: File) {
    return Cards.importZip(f, this.ident!);
  }
  /** rename the current card (waits for queued saves first); false when the name is empty */
  async rename(name: string): Promise<boolean> {
    if (!this.card) return false;
    await this.writes;
    return Cards.renameCard(this.card, name);
  }
  mountFolder() {
    return Cards.mountFolder(this.ident!);
  }
  canMountFolder() {
    return Cards.canMountFolder();
  }
  exportName(): string {
    return this.card ? Cards.cardFileName(this.card.meta.name) : '';
  }
  async exportZip(): Promise<Blob | null> {
    if (!this.card) return null;
    await this.writes;
    return Cards.exportZip(this.card);
  }
  mismatch(): string {
    return this.card && this.ident ? Cards.mismatch(this.card, this.ident) : '';
  }
  get isBrowserCard() {
    return this.card?.where === 'browser';
  }

  /** drop a folder/zip card from use; returns the default card to switch to */
  async eject(): Promise<Cards.Card | null> {
    this.card = null;
    this.pending = null;
    return this.ident ? Cards.openCard(this.defaultId()) : null;
  }
  /** delete the current browser card, then return the default card to switch to (created if missing) */
  async deleteCurrent(): Promise<Cards.Card | null> {
    const id = this.card!.id;
    await this.writes;
    await Cards.deleteCard(id);
    if (!this.ident) {
      this.card = null;
      this.pending = null;
      return null;
    } // no game open: nothing to fall back to
    return this.defaultCard();
  }
}
