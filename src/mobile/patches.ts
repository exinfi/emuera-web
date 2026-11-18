/** Per-game patches and window width override (UI around the engine's patch registry and the `patches` message). */
import { GAME_PATCHES, patchesFor, patchWidth } from '../engine/patches/registry';
import { loadConfig } from '../engine/runtime/config';

const $ = (id: string) => document.getElementById(id)!;
const lsGet = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* private mode */
  }
};

export function createPatches() {
  let csv: Record<string, string> = {},
    game = '',
    active: string[] | null = null,
    gameWidth = 0,
    winKey = '';
  const master = $('patch') as HTMLInputElement;
  const bootsum = $('bootsum'); // the engine's boot summary (game, engine profile, patches applied / ignored / off), shown at the top of the Debug sheet
  const panel = $('patchpanel'),
    open = $('patchopen') as HTMLButtonElement;
  // the "button next to" the master checkbox: it lives in the generated options row
  master.closest('label')?.after(open);
  open.after(panel);
  // one switch per patch id ('0' off, '1' on), usable before a game opens; the old per-game key is still honoured until the switch is touched
  const isOff = (id: string): boolean => {
    const v = lsGet('emuera-patch:' + id);
    return v === '0' ? true : v === '1' ? false : !!game && lsGet('emuera-patch:' + game + ':' + id) === '0';
  };
  /** ids of single patches the player switched off (this browser) */
  const offIds = (): string[] => GAME_PATCHES.filter((p) => isOff(p.id)).map((p) => p.id);

  function renderPatches() {
    const mine = new Set(patchesFor(csv).map((p) => p.id));
    panel.textContent = '';
    const note = document.createElement('div');
    note.className = 'small';
    note.textContent = !master.checked
      ? 'Per-game patches are switched off: every game runs as the original engine would.'
      : game
        ? 'Changes apply the next time the game loads. Patches for other games can be set now too.'
        : 'Patches will only apply on detected applicable games.';
    panel.appendChild(note);
    // patches are maintained against English-translated builds, so say so (and where to see the outcome)
    const stale = document.createElement('div');
    stale.className = 'small';
    stale.style.marginTop = '4px';
    stale.textContent =
      'These patches were written and tested against the English-translated builds of each game, and may not apply to other branches (for example the original Japanese releases). Most era games are also in active development, so a patch can be out of date for a newer build. Please check the debug log to see which patches were applied.';
    panel.appendChild(stale);
    const list = document.createElement('div');
    list.className = 'patchlist';
    panel.appendChild(list);
    const mkRow = (p: (typeof GAME_PATCHES)[number], dim: boolean): HTMLElement => {
      const row = document.createElement('label');
      row.className = 'patchrow';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !isOff(p.id);
      cb.disabled = !master.checked; // a patch for another game stays switchable: the switch is stored per id and used when that game opens
      cb.onchange = () => {
        lsSet('emuera-patch:' + p.id, cb.checked ? '1' : '0');
        renderWidth();
      };
      const state = !game
        ? `for ${p.game}`
        : active?.includes(p.id)
          ? 'active'
          : active
            ? mine.has(p.id)
              ? 'off'
              : p.confirm === 'fingerprint'
                ? 'did not match this game'
                : 'not for this game'
            : mine.has(p.id)
              ? 'applies to this game'
              : p.confirm === 'fingerprint'
                ? 'checked against the game when it boots'
                : 'not for this game';
      const text = document.createElement('span');
      text.append(
        Object.assign(document.createElement('b'), { textContent: p.title }),
        state ? ` (${state})` : '',
        document.createElement('br'),
        Object.assign(document.createElement('span'), { className: 'small', textContent: p.summary }),
      );
      row.append(cb, text);
      row.title = `${p.title}\nPatch created: ${p.entered}\nLast updated: ${p.updated}`; // maintainer dates: how old the patch's assumptions about the game are (long-press / hover)
      row.style.opacity = dim ? '0.5' : '1';
      return row;
    };
    const head = (text: string, hint?: string) => {
      const h = document.createElement('div');
      h.className = 'patchhead';
      h.textContent = text;
      if (hint) h.title = hint;
      return h;
    };
    if (!game) {
      for (const p of GAME_PATCHES) list.appendChild(mkRow(p, false)); // no game open: registry order, so the switches can be set in advance
    } else {
      // grouped by what is known about the open game: written for it / speed-ups checked against its functions at boot / written for other games
      const forGame = GAME_PATCHES.filter((p) => mine.has(p.id));
      const checked = GAME_PATCHES.filter((p) => !mine.has(p.id) && p.kind === 'speed' && p.confirm === 'fingerprint');
      const other = GAME_PATCHES.filter((p) => !mine.has(p.id) && !checked.includes(p));
      if (forGame.length) {
        list.appendChild(head('Written for this game'));
        for (const p of forGame) list.appendChild(mkRow(p, false));
      }
      if (checked.length) {
        list.appendChild(
          head(
            'Speed-ups checked against the game when it loads',
            'These give the same results as the game\u2019s own script, so they are tried on any game whose functions match exactly. The Debug tab shows which were applied.',
          ),
        );
        for (const p of checked) list.appendChild(mkRow(p, false));
      }
      if (other.length) {
        const d = document.createElement('details');
        const sm = document.createElement('summary');
        sm.className = 'patchhead';
        sm.textContent = `Written for other games (${other.length})`;
        d.appendChild(sm);
        for (const p of other) d.appendChild(mkRow(p, true));
        list.appendChild(d);
      }
    }
  }
  open.onclick = () => {
    panel.hidden = !panel.hidden;
    open.textContent = panel.hidden ? 'List…' : 'Close list';
    if (!panel.hidden) renderPatches();
  };
  master.addEventListener('change', () => {
    renderPatches();
    renderWidth();
  });

  // window width override (per game, in this browser)
  const winw = $('winw') as HTMLInputElement,
    hint = $('winwhint'),
    reset = $('winwreset');
  const widthOverride = (): number | undefined => {
    const v = Number(lsGet(winKey));
    return v >= 200 ? v : undefined;
  };
  function renderWidth() {
    const o = widthOverride();
    winw.disabled = !winKey;
    winw.value = o ? String(o) : '';
    const pw = patchWidth(csv, master.checked, offIds());
    winw.placeholder = pw ? String(pw.px) : gameWidth ? String(gameWidth) : 'game default';
    hint.textContent = !winKey
      ? 'open a game first'
      : o
        ? `override (${pw ? `patch ${pw.px}, ` : ''}game default ${gameWidth})`
        : pw
          ? `${pw.px} from the ${pw.id} patch (game default ${gameWidth})`
          : `game default ${gameWidth}`;
    reset.hidden = !o;
  }
  winw.onchange = () => {
    const v = Math.round(Number(winw.value));
    lsSet(winKey, v >= 200 && v <= 4000 && v !== gameWidth ? String(v) : '');
    renderWidth();
    hint.textContent += ' - applies when the game is loaded again';
  };
  reset.onclick = () => {
    lsSet(winKey, '');
    renderWidth();
    hint.textContent += ' - applies when the game is loaded again';
  };
  renderWidth();

  return {
    offIds,
    widthOverride,
    /** a game is about to start: remember its files and identity, forget the last engine report */
    onGame(files: Record<string, string>, gameId: string) {
      csv = files;
      game = gameId;
      active = null;
      winKey = 'emuera-width:' + gameId;
      try {
        gameWidth = loadConfig(files).windowWidth;
      } catch {
        gameWidth = 0;
      }
      renderPatches();
      renderWidth();
    },
    /** the engine's report once the game is parsed */
    onReport(m: { active: string[]; boot?: string[] }) {
      active = m.active;
      bootsum.textContent = (m.boot ?? []).join('\n');
      renderPatches();
    },
  };
}
