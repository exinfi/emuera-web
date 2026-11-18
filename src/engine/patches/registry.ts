/**
 * Per-game patches: the catalogue the shells list ("per-game patches" option) and the engine consults.
 * A patch is only ever applied to the game it was written for; each can be switched off on its own, and the master switch (StartOptions.patches) turns them all off.
 * Games are recognised by the code in CSV/GameBase.csv (the author's id, stable across versions), not by version.
 */
export interface GamePatch {
  id: string;
  /** short name for the list */
  title: string;
  /** one plain sentence shown to the player under the title */
  summary: string;
  /** the full technical background (what, why, which game version); kept for whoever edits the patch, not shown in the list */
  desc: string;
  /** 'speed': identical results, faster; 'layout': changes how the game is laid out on screen; 'compat': makes the game accept resources it would otherwise miss; 'fix': corrects a bug in the game's own script (behaviour differs from the original program, so it is applied only to the exact function it was written against) */
  kind: 'speed' | 'layout' | 'compat' | 'fix';
  game: string;
  /**
   * Maintainer information, never shown to players. Era games are in active development, so a patch written against one build can stop applying or stop being needed later;
   * these two dates say how old the patch's assumptions are (read them together with the game version named in `desc`). Both are YYYY-MM-DD.
   * `entered`: the day the patch was first added to the registry. Never changes.
   * `updated`: the day the patch was last changed or re-checked against a game build (new matching rule, new fix inside it, rewritten `desc`, or "still needed and still applies to build X").
   *   Set it to the same day as `entered` when the patch is new, and move it forward on every such change. Not before `entered`.
   * The patches that existed when the fields were introduced all carry 2026-11-14 for both (their real dates were not recorded).
   */
  entered: string;
  updated: string;
  /** GameBase.csv game codes this patch is meant for */
  codes: string[];
  /**
   * Also require the GameBase.csv title (`タイトル`, compared ignoring case) to be one of these. Needed where the code is not unique to a game: 9224517 is the default code of the
   * erakanon template, so every game made from it shares it (eratohoK and eraRanceK both do).
   */
  titles?: string[];
  /** 'fingerprint': also confirmed per function at boot (the shell learns the outcome from the engine) */
  confirm?: 'fingerprint';
  /** layout patches: the window width (px) to use instead of the game's own config */
  windowWidth?: number;
}

export const GAME_PATCHES: readonly GamePatch[] = [
  {
    id: 'erablue-load',
    entered: '2026-11-14',
    updated: '2026-11-15',
    kind: 'speed',
    game: 'erablue_resort',
    codes: ['20140310'],
    confirm: 'fingerprint',
    title: 'erablue_resort: faster new game',
    summary: 'Runs some INIT_RELATION functions natively to improve speed.',
    desc: 'Runs the loop skeletons of the weak-point command setup and INIT_RELATION natively (same results, same random numbers). Applied only to functions whose body matches the shipped game. The original Japanese branch (jpbranch source, same GameBase code 20140310 and version 111) was compared statically on 2026-11-15: @弱点コマンド初期設定 (ce1a333d:191) and @INIT_RELATION (865ee63f:15) have the same fingerprints there, as do the two functions the first one calls (@敏感素質対応判定, @弱点コマンド候補判定) and every COMTYPE_ function, so the patch installs on that branch too. Not run on the Japanese branch yet; the other differences between the branches (translated text, kojo stubs, translation helpers) are not used by this patch.',
  },
  {
    id: 'erablue-form-folders',
    entered: '2026-11-14',
    updated: '2026-11-14',
    kind: 'compat',
    game: 'erablue_resort',
    codes: ['20140310'],
    title: 'erablue_resort: Vikala and Cagliostro forms',
    summary: 'Adds support for English-named folders "6VikalaY" and "25CagliostroA" to display their alternate forms.',
    desc: 'When Vikala (6) or Cagliostro (25) changes form, the game switches to a Japanese-named image folder (6ビカラ（陰）, 25大人カリオストロ) and has no English equivalent, so a pack that names its folders in English could never show the second form. With this patch the English pack folders 6Vikala, 6VikalaY (yin), 25Cagliostro and 25CagliostroA (adult) are also visible under the Japanese names the game asks for, so each form gets its own images. It only adds those names; a pack folder that already has the Japanese name is used as it is and is never replaced.',
  },
  {
    id: 'rancek-html-align',
    entered: '2026-11-15',
    updated: '2026-11-16',
    kind: 'layout',
    game: 'eraRanceK',
    codes: ['9224517'],
    titles: ['eraRanceK'],
    title: 'eraRanceK: centred images',
    summary:
      'Centres the scenario intro pictures (and other HTML-printed images) when the game has set centre alignment.',
    desc: 'The game sets ALIGNMENT CENTER and then prints its CG pictures with HTML_PRINT (@PRINT_CG_IMAGE -> @PRINT_IMAGE in ERB/IMAGE/IMAGE.ERB, e.g. the whale scenario intro). In the EM+EE source (HtmlManager: the alignment of an HTML line starts as LEFT and only <p align=...> changes it) a plain HTML_PRINT ignores ALIGNMENT, which is what this interpreter does for every game, so the pictures sit at the left edge although the text around them is centred. The game was written to show them centred (the owner remembers them centred), probably on an exe build that behaves differently. With this patch a plain HTML_PRINT follows the current ALIGNMENT for this game only; an explicit <p align=...> in the markup still wins. Written for eraRanceK 0.95 (GameBase.csv code 9224517, exe 1.824+v24+EMv18+EEv56). Switch it off if some screen ends up centred that should not be. Matched on the game code and the title "eraRanceK": the code 9224517 is the erakanon template default and eratohoK has it too.',
  },
  {
    id: 'rancek-relation',
    entered: '2026-11-15',
    updated: '2026-11-15',
    kind: 'speed',
    game: 'eraRanceK',
    codes: ['9224517'],
    titles: ['eraRanceK'],
    confirm: 'fingerprint',
    title: 'eraRanceK: faster country relations',
    summary:
      'Runs the country-relation check natively, which cuts several seconds from every shop screen and turn end.',
    desc: '@CHECK_COUNTRY_RELATION (ERB/SLG/SLG_FUNCTION.ERB) scans every treaty table (100 slots for each vassal kind, alliances and truces, 10 for unions, 15 countries per entry) on each call, and @TMP_CREATE_RELATION_MAP calls it for every pair of countries: about 4,700 calls per shop screen, roughly 0.9 ms each in the interpreter (about 3.5 s of a 4 s shop draw on a day-3 save with 637 characters). The patch runs the same checks in the same order natively and sets RESULT and RESULT:1 exactly as the script does (checked against the script on that save and on 6,000 random treaty states covering every relation kind, no differences). Only applied when the function body matches the build it was written against (eraRanceK 00905, fingerprint e980e843:128). The sibling @CHECK_COUNTRY_RELATION_F (expression form) is not covered.',
  },
  {
    id: 'rancek-move-chara',
    entered: '2026-11-15',
    updated: '2026-11-15',
    kind: 'speed',
    game: 'eraRanceK',
    codes: ['9224517'],
    titles: ['eraRanceK'],
    confirm: 'fingerprint',
    title: 'eraRanceK: faster End Turn movement',
    summary:
      'Speeds up the characters-move-between-cities step of End Turn by running the country-relation lookup it depends on natively.',
    desc: '@MOVE_CHARA_CITY (ERB/SYSTEM/MOVE_CHARA.ERB, run at every End Turn) spends most of its time in its last loop, which calls the expression form @CHECK_COUNTRY_RELATION_F up to ten times per character (about 6,000 calls with 637 characters), each one scanning every treaty table. The function itself is left to the script, because its random draws must keep their exact order; only @CHECK_COUNTRY_RELATION_F is replaced by a native version with the same result (same checks as the rancek-relation patch; it never touches RESULT, as in the script). Checked against the script on a day-3 save and on 6,000 random treaty states over every relation code, no differences. Applied only when @CHECK_COUNTRY_RELATION_F matches eraRanceK 00905 (fingerprint 2c2e66d:122). The other callers of the same function (bandit event, goddess check) get faster too. It needs the engine to accept native replacements for expression functions (VM.callMethod).',
  },
  {
    id: 'rancek-shop-loop',
    entered: '2026-11-15',
    updated: '2026-11-15',
    kind: 'speed',
    game: 'eraRanceK',
    codes: ['9224517'],
    titles: ['eraRanceK'],
    confirm: 'fingerprint',
    title: 'eraRanceK: faster shop screen',
    summary:
      'Runs two of the maps the shop screen rebuilds after every action natively, so returning to the shop is quicker.',
    desc: 'The shop menu is redrawn after every action and rebuilds several maps each time. This patch replaces two of them with native versions that give the same results: @TMP_CREATE_IS_FREE_MAP (which characters are free to act; three @ID_TO_CHARA calls per character each scanned the whole roster, now one id table per call; the nested IF block after the CONTINUE in the script is unreachable and is dropped; commander lookups still call @GET_CITY_COMMANDER / @GET_UNIT_COMMANDER) and @TMP_CREATE_COUNTRY_NEIBORING_MAP (200 x 200 city pairs with @IS_ROUTE and about 15,500 @GET_RELAYPOINT calls per draw, now searched natively). About 0.8 s down to about 0.07 s per draw on a day-3 save with 637 characters. Checked against the script on that save and on 40 random states (characters flags/talents/cooldowns, manager ids, city owners/types/routes), identical results. Applied only when every function it replaces or inlines (@ID_TO_CHARA, @GET_ID, @IS_ANIMAL, @IS_ROUTE, @GET_RELAYPOINT) matches eraRanceK 00905 (fingerprints in src/engine/patches/rancek.ts); otherwise the patch stays off as a whole. Not covered: @TMP_PREPARE_CHARA_STARS and @TMP_PREPARE_COUNTRY_STARS.',
  },
  {
    id: 'tensei-exp-bar',
    entered: '2026-11-14',
    updated: '2026-11-14',
    kind: 'fix',
    game: 'ShinEraTenseiP+egg',
    codes: ['666'],
    confirm: 'fingerprint',
    title: 'ShinEraTenseiP+egg: EXP bar',
    summary: 'Patches the ERB file to fix the EXP bar gain animation.',
    desc: ' ShinEraTenseiP 0.5.9 + /egg/ development (GameBase.csv version 000509309154). In @BATTLE_WIN (ERB/RPG/戦闘/BATTLE.ERB) the line that adds the gained EXP to the result bar has a misplaced parenthesis, (EXP - prev * 191) instead of (EXP - prev) * 191, so the sum goes negative, is clamped to 0, and the bar does not grow unless the character levels up. Tentative: the authors may have a reason; the older commented-out line and the line that sets the bar start both use the corrected form. Applied only when @BATTLE_WIN is exactly the function this was written for, otherwise the game runs unchanged.',
  },
  {
    id: 'tensei-name-matches',
    entered: '2026-11-14',
    updated: '2026-11-14',
    kind: 'fix',
    game: 'ShinEraTenseiP+egg',
    codes: ['666'],
    confirm: 'fingerprint',
    title: 'ShinEraTenseiP+egg: Auto-Recover names',
    summary: 'Makes dungeon Auto-Recover recognise the English heal skill names (Dia, Media, ...), so it heals.',
    desc: 'In the English build @SKILL_NAME_FE returns English skill names, but @AUTO_RECOVER_MAGIC_HP (ERB/RPG/ダンジョンアタック/AUTO_RECOVER.ERB) chooses the heal amount and target with SELECTCASE RESULTS against the Japanese names only (ディア, ディアラマ, ディアラハン, メ・ディア, メ・ディアラマ, メ・ディアラハン). Nothing matches, the CASEELSE skips every skill and Auto-Recover prints Finished without healing anyone. This adds Dia, Diarama, Diarahan, Media, Mediarama and Mediarahan to those CASE lines. Written for ShinEraTenseiP 0.5.9 + /egg/ development (GameBase.csv version 000509309154). Further places that compare translated names against Japanese ones will be added here. Applied only when the function is exactly the one this was written for, otherwise the game runs unchanged.',
  },
  {
    id: 'fgok-width',
    entered: '2026-11-14',
    updated: '2026-11-14',
    kind: 'layout',
    game: 'eraFGO K',
    codes: ['4022264'],
    windowWidth: 1080,
    title: 'eraFGO K: window width',
    summary: 'Experimental manual width setting to fix display issues.',
    desc: 'The game lays out status rows and menus for a window wider than the 900 px in its config, so they wrap. 1080 was found by raising the width until they fit. Your own width override wins over this.',
  },
];

/** CSV/GameBase.csv `コード` (the game code), '' when missing */
export function gameCode(csv: Record<string, string>): string {
  const k = Object.keys(csv).find((n) => n.toLowerCase().replace(/\\/g, '/').endsWith('csv/gamebase.csv'));
  if (!k) return '';
  for (const line of csv[k].replace(/^﻿/, '').split(/\r\n|\n|\r/)) {
    const m = /^\s*コード\s*,\s*([^,;\s]+)/.exec(line);
    if (m) return m[1];
  }
  return '';
}
/** CSV/GameBase.csv `タイトル` (the game title), '' when missing */
export function gameTitle(csv: Record<string, string>): string {
  const k = Object.keys(csv).find((n) => n.toLowerCase().replace(/\\/g, '/').endsWith('csv/gamebase.csv'));
  if (!k) return '';
  for (const line of csv[k].replace(/^﻿/, '').split(/\r\n|\n|\r/)) {
    const m = /^\s*タイトル\s*,\s*([^,;]+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return '';
}
/** the patches written for this game */
export const patchesFor = (csv: Record<string, string>): GamePatch[] => {
  const c = gameCode(csv);
  if (!c) return [];
  const t = gameTitle(csv).toLowerCase();
  return GAME_PATCHES.filter((p) => p.codes.includes(c) && (!p.titles || p.titles.some((x) => x.toLowerCase() === t)));
};
/** the window width a layout patch asks for, given the patches that are switched on (master switch and per-patch ids) */
export function patchWidth(
  csv: Record<string, string>,
  master: boolean,
  off: readonly string[],
): { px: number; id: string } | undefined {
  if (!master) return undefined;
  const p = patchesFor(csv).find((x) => x.windowWidth && !off.includes(x.id));
  return p ? { px: p.windowWidth!, id: p.id } : undefined;
}
