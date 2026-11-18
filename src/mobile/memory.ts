/** Memory-card UI: the buttons, prompts and confirms around the CardSession (host/web). */
import { CardSession, type Card, type CardMeta } from '../host/web/cardsession';
import type { Client } from '../host/client';
import JSZip from 'jszip';
import { isNativeSave, scanNative, describeNative, type NativeInfo } from '../host/web/nativescan';

const $ = (id: string) => document.getElementById(id)!;

export interface MemoryDeps {
  client: () => Client;
  say(msg: string): void;
  problem(msg: string): void;
}

export function createMemory(d: MemoryDeps) {
  const cs = new CardSession({
    onError: (t) => d.problem(t),
    onAssociate: () => {
      void refreshUi();
    },
  }); // a first save made the card the game's own: redraw the list and the warning
  const persist = (key: string, v: { info: string; data: string } | null) => cs.persist(key, v);
  const persistFile = (key: string, text: string) => cs.persistFile(key, text);

  /** a game was loaded: pick its card (the remembered one, else the default "Browser memory" card) and return what to start the engine with */
  async function openForGame(csv: Record<string, string>, erb: Record<string, string | number>, zipName: string) {
    const r = await cs.open(csv, erb, zipName);
    if (r.migrated) d.say(`Migrated ${r.migrated} save file(s) from the old storage into the card.`);
    return { gameId: cs.ident!.id, saves: r.saves, files: r.files, cardName: cs.card?.meta.name ?? '(none)' };
  }

  const cardsel = () => $('cardsel') as HTMLSelectElement;
  /** the card bar works with or without a game: before a game, a chosen card is the pending one the next game takes; cards made then are unassigned until a game claims them */
  async function refreshUi() {
    const ident = cs.ident,
      card = cs.card;
    for (const id of ['cardsel', 'cnew', 'cbundled', 'cimp', 'cdir']) ($(id) as HTMLInputElement).disabled = false;
    for (const id of ['cren', 'cexp', 'cnat', 'cdel']) ($(id) as HTMLInputElement).disabled = !card;
    ($('cdir') as HTMLButtonElement).hidden = !cs.canMountFolder();
    $('cextra').hidden = !!($('cbundled').hidden && $('cdir').hidden); // the bundled / mounted-folder line shows only when one of its buttons does
    const all = await cs.list();
    const sel = cardsel();
    sel.textContent = '';
    const add = (id: string, meta: CardMeta, tag: string) => {
      const o = document.createElement('option');
      o.value = id;
      const other = ident && meta.gameId && meta.gameId !== ident.id ? `  \u26a0 for ${meta.gameTitle}` : '';
      o.textContent = `${meta.name}${tag}${meta.gameId ? '' : '  (unassigned)'}${other}`;
      sel.appendChild(o);
    };
    if (!card) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = ident ? '(none)' : "(none: game's own card)";
      sel.appendChild(o);
    }
    if (card && card.where !== 'browser') add(card.id, card.meta, card.where === 'folder' ? ' [folder]' : '');
    for (const c of all) add(c.id, c.meta, '');
    sel.value = card ? card.id : '';
    $('cardwarn').textContent = cs.mismatch();
  }
  async function useCard(c: Card) {
    const { saves, files } = await cs.use(c);
    const n = Object.keys(saves).filter((k) => k !== 'global').length;
    if (cs.ident) {
      d.client().setCard(saves, files);
      d.say(`Card "${c.meta.name}" inserted (${n} save slot(s)). Re-open the save/load screen to see it.`);
    } else d.say(`Card "${c.meta.name}" chosen (${n} save slot(s)). The next game you load will use it.`);
    await refreshUi();
  }
  const download = (blob: Blob, name: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  };

  cardsel().onchange = async () => {
    if (!cardsel().value) return;
    const c = await cs.openById(cardsel().value);
    if (c) await useCard(c);
  };
  $('cnew').onclick = async () => {
    const name = prompt('Name for the new memory card:', `Card ${new Date().toLocaleDateString()}`);
    if (!name) return;
    await useCard(await cs.create(name));
  };
  async function exportCard() {
    const blob = await cs.exportZip();
    if (!blob) return;
    download(blob, cs.exportName());
  }
  $('cexp').onclick = exportCard;
  $('cren').onclick = async () => {
    const card = cs.card;
    if (!card) return;
    const n = prompt('New name for this memory card:', card.meta.name);
    if (n === null) return;
    if (!(await cs.rename(n))) {
      d.say('A card needs a name.');
      return;
    }
    await refreshUi();
    d.say(`Card renamed to "${cs.card?.meta.name}". Exports are saved as ${cs.exportName()}.`);
  };
  // ---- native Emuera saves (experimental): "Insert zip" recognises them by file signature and offers to convert them into the current card
  const MAX_NATIVE = 256 * 1024 * 1024;
  type NFile = { name: string; bytes: Uint8Array };
  async function nativeFilesIn(f: Blob & { name?: string }): Promise<NFile[]> {
    const out: NFile[] = [],
      nm = f.name ?? '';
    if (/\.sav$/i.test(nm)) {
      if (f.size <= MAX_NATIVE) {
        const b = new Uint8Array(await f.arrayBuffer());
        if (isNativeSave(b)) out.push({ name: nm, bytes: b });
      }
      return out;
    }
    try {
      const z = await JSZip.loadAsync(f);
      for (const [name, e] of Object.entries(z.files)) {
        if (e.dir || !/\.sav$/i.test(name) || out.length >= 300) continue;
        const b = await e.async('uint8array');
        if (b.length <= MAX_NATIVE && isNativeSave(b)) out.push({ name: name.replace(/^.*\//, ''), bytes: b });
      }
    } catch {
      /* not a zip */
    }
    return out;
  }
  const codeOfIdent = () => cs.ident?.id.split('|').pop() ?? '';
  async function offerNative(files: NFile[], source: string) {
    const infos: NativeInfo[] = [];
    for (const f of files) {
      const i = await scanNative(f.name, f.bytes);
      if (i) infos.push(i);
    }
    if (!infos.length) {
      d.say(`${source}: no readable Emuera save found.`);
      return;
    }
    const head = `Detected ${infos.length} native Emuera save file(s) in ${source} (experimental conversion):\n\n${infos.map(describeNative).join('\n')}`;
    const ident = cs.ident,
      card = cs.card;
    if (!ident || !card) {
      alert(
        `${head}\n\nNo game is open. Open the game they belong to first (conversion needs its variable table), then insert them again. These files were not kept.`,
      );
      d.say('Native Emuera saves found; open the game first, then insert them again.');
      return;
    }
    const gc = codeOfIdent(),
      diff = infos.filter((i) => i.gameCode !== gc);
    const over = infos.filter((i) => i.key && card.paths.has(`sav/${i.key}.sav`)).map((i) => i.key);
    const warn = [
      diff.length
        ? `Game code differs from "${ident.title}" (code ${gc}) in ${diff.length} file(s): the game will probably refuse those as "another game".`
        : '',
      infos.some((i) => i.fmt !== 1808)
        ? 'Some files use a save format other than 1808; conversion will be attempted anyway.'
        : '',
      over.length ? `This replaces existing slot(s) on card "${card.meta.name}": ${over.join(', ')}.` : '',
      infos.some((i) => i.kind === 'slot' && !i.key)
        ? 'A file whose name is not saveNN.sav cannot be placed in a slot and will be skipped.'
        : '',
    ]
      .filter(Boolean)
      .join('\n');
    if (
      !confirm(`${head}\n\n${warn ? warn + '\n\n' : ''}Convert them into "${ident.title}" (card "${card.meta.name}")?`)
    ) {
      d.say('Native save import cancelled.');
      return;
    }
    d.say('Converting native saves\u2026 (large saves take a while on a phone)');
    const byName = new Map(files.map((f) => [f.name, f]));
    const todo = infos
      .filter((i) => i.kind !== 'other')
      .map((i) => byName.get(i.name)!)
      .filter(Boolean);
    let res;
    try {
      res = await d.client().nativeImport(
        todo.map((f) => ({
          name: f.name,
          bytes: f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) as ArrayBuffer,
        })),
      );
    } catch (e) {
      d.problem('NATIVE IMPORT FAILED: ' + e);
      d.say('Native save import failed (see debug).');
      return;
    }
    let ok = 0;
    const said: string[] = [];
    for (const r of res) {
      if (!r.ok || !r.key || r.data === undefined) {
        said.push(`${r.name}: not converted (${r.error ?? 'unknown'})`);
        continue;
      }
      persist(r.key, { info: r.info ?? '', data: r.data });
      ok++;
      const n = r.skipped?.length ?? 0;
      said.push(
        `${r.name} -> ${r.key === 'global' ? 'global data' : 'slot ' + r.key.replace(/^save/, '')}${n ? `; ${n} variable(s) not in this game were left out (${r.skipped!.slice(0, 6).join(', ')}${n > 6 ? ', ...' : ''})` : ''}${r.warnings?.length ? '; ' + r.warnings.join('; ') : ''}`,
      );
    }
    if (ok) await useCard(card); // flushes the writes and hands the updated card to the running game
    d.problem(`NATIVE SAVE IMPORT (${ok}/${res.length}): ` + said.join(' | '));
    d.say(
      ok
        ? `Converted ${ok} native save file(s) into card "${card.meta.name}". Re-open the save/load screen to see them.`
        : 'No native save could be converted (see debug).',
    );
  }
  async function exportNative() {
    const ident = cs.ident,
      card = cs.card;
    if (!ident || !card) {
      d.say('Open a game first: the converter needs its variable table.');
      return;
    }
    const keys = [...card.paths].map((p) => /^sav\/(save\d+|global)\.sav$/.exec(p)?.[1]).filter(Boolean) as string[];
    if (!keys.length) {
      d.say(`Card "${card.meta.name}" has no saves to export.`);
      return;
    }
    await cs.flush();
    const btn = $('cnat') as HTMLButtonElement;
    btn.disabled = true;
    try {
      d.say(`Converting ${keys.length} slot(s) to native Emuera format\u2026 (large saves take a while on a phone)`);
      let res;
      try {
        res = await d.client().nativeExport(keys);
      } catch (e) {
        d.problem('NATIVE EXPORT FAILED: ' + e);
        d.say('Native export failed (see debug).');
        return;
      }
      const good = res.filter((r) => r.ok && r.bytes),
        bad = res.filter((r) => !r.ok);
      if (bad.length) d.problem('NATIVE EXPORT skipped: ' + bad.map((r) => `${r.name} (${r.error})`).join('; '));
      if (!good.length) {
        d.say('Nothing could be exported (see debug).');
        return;
      }
      const z = new JSZip();
      for (const r of good) z.file('sav/' + r.name, r.bytes!);
      z.file(
        'README.txt',
        `Native Emuera save files from "${ident.title}" (card "${card.meta.name}"), written by the Emuera web interpreter.\nEXPERIMENTAL: written from the Emuera source, not yet checked against the original program. Copy the contents of sav/ into the game's sav folder (keep a backup of your own saves first).\n`,
      );
      const name = cs.exportName().replace(/\.memcard\.zip$/, '') + '.native-sav.zip';
      download(await z.generateAsync({ type: 'blob', compression: 'DEFLATE' }), name);
      d.say(
        `Exported ${good.length} native save file(s) as ${name}${bad.length ? `; ${bad.length} skipped (see debug)` : ''}. Check your downloads.`,
      );
    } finally {
      btn.disabled = !cs.card;
    }
  }
  $('cnat').onclick = exportNative;
  async function importFile(f: Blob & { name?: string }) {
    // importZip reads `file.name`: a Blob from fetch() has none
    const file = f instanceof File ? f : new File([f], f.name || 'card.memcard.zip');
    const nat = await nativeFilesIn(file);
    if (nat.length) {
      await offerNative(nat, file.name);
      return;
    }
    if (/\.sav$/i.test(file.name)) {
      d.say(`${file.name}: not a native Emuera save.`);
      return;
    }
    try {
      await useCard(await cs.importZip(file));
    } catch (err) {
      d.problem('CARD IMPORT FAILED: ' + err);
    }
  }
  /** insert several card zips one after another (the last one stays inserted) */
  async function importMany(fs: (Blob & { name?: string })[]) {
    for (const f of fs) await importFile(f);
  }
  ($('cimp') as HTMLInputElement).onchange = async (e) => {
    const el = e.target as HTMLInputElement,
      fs = [...(el.files ?? [])];
    el.value = '';
    for (const f of fs) await importFile(f);
  };
  // Import sav folder zip…: the same detection as Import saves…, but only native saves are taken
  ($('cnatimp') as HTMLInputElement).onchange = async (e) => {
    const el = e.target as HTMLInputElement,
      fs = [...(el.files ?? [])];
    el.value = '';
    for (const f of fs) {
      const nat = await nativeFilesIn(f);
      if (nat.length) await offerNative(nat, f.name);
      else d.say(`${f.name}: not a native Emuera save folder zip.`);
    }
  };
  $('cdir').onclick = async () => {
    try {
      await useCard(await cs.mountFolder());
    } catch (err) {
      if ((err as any)?.name !== 'AbortError') d.problem('MOUNT FAILED: ' + err);
    }
  };
  $('cdel').onclick = async () => {
    const card = cs.card;
    if (!card) return;
    if (!cs.isBrowserCard) {
      const def = await cs.eject();
      d.say('Folder card ejected.');
      if (def) await useCard(def);
      else await refreshUi();
      return;
    }
    if (
      !confirm(
        `Delete memory card "${card.meta.name}" and all its saves from this browser? (Export first to keep a copy.)`,
      )
    )
      return;
    const def = await cs.deleteCurrent();
    if (def) await useCard(def);
    else {
      d.say('Card deleted.');
      await refreshUi();
    }
  };
  return {
    openForGame,
    persist,
    persistFile,
    refreshUi,
    exportCard,
    importFile,
    importMany,
    nativeFilesIn,
    offerNative,
    hasGame: () => !!cs.ident,
    flush: () => cs.flush(),
  };
}
