/**
 * Engine profile: which Emuera a game was written for. One interpreter serves both; a profile only switches the places where the two engines differ.
 *  - 'em-ee' (default): Emuera EM+EE (emuera.em), the engine of erablue_resort and the reference for everything shared.
 *  - 'emuera-net': Emuera.NET by VVII (eraMegaten / ShinEraTenseiP). Recognised by its JSON game config `setting.json` next to ERB/ and CSV/.
 * Rule: if a feature exists in EM+EE, EM+EE's behavior is the main implementation; a differing Emuera.NET behavior goes under the profile.
 * Features that only Emuera.NET has are added under the profile too when they could clash with an EM+EE game (instruction names), freely otherwise (functions).
 */
import { gameCode } from './patches/registry';

export type EngineProfile = 'em-ee' | 'emuera-net' | 'puchi';

/**
 * Profile 'puchi': PuchiEmuera 1821.0.1 (a fork of Emuera 1.821 by PCDRP), written for ONE game, eraSumireTeru (not updated in years). It is never guessed from
 * features: only the game code below switches it on, so none of its additions (fixed-image layer, FADE/SHAKE/FONTEDGE/OUTPUTHINTS, image lookup by file name) can leak
 * into an EM+EE or Emuera.NET game. Everything else behaves as 'em-ee'. Code from CSV/GameBase.csv `コード` (-era SumireTeru-, version 1010).
 */
export const PUCHI_GAME_CODES: readonly string[] = ['156375'];

/**
 * The three keys EM+EE's own JSON config knows (`JSONConfigData`: UseButtonFocusBackgroundColor, UseNewRandom, UseScopedVariableInstruction).
 * EM+EE itself reads and writes `setting.json` (`JSONConfig._configFileName`), so the file alone does not mean Emuera.NET: eraRanceK ships
 * `1.824+v24+EMv18+EEv56` with exactly these three keys. Emuera.NET's file carries more (ShinEraTenseiP: ImageSamplingOption, CheckUTF8withBOM,
 * FontAntialias, UseRenameInCharaCSV).
 */
const EMEE_JSON_KEYS = new Set(['UseButtonFocusBackgroundColor', 'UseNewRandom', 'UseScopedVariableInstruction']);

/**
 * `setting.json` next to ERB/ and CSV/ means Emuera.NET unless it is a JSON object with at least one key and no key outside EM+EE's set.
 * An empty, unreadable or non-object file stays Emuera.NET (what this function did before, so existing games keep their profile).
 * `why` is the sentence the playtest log prints, so a player can see what the game was recognised as and on what evidence.
 */
export function describeProfile(files: Record<string, string>): { profile: EngineProfile; why: string } {
  const code = gameCode(files);
  if (code && PUCHI_GAME_CODES.includes(code))
    return { profile: 'puchi', why: `GameBase.csv game code ${code} is eraSumireTeru (PuchiEmuera fork)` };
  const sj = Object.keys(files).find((p) => /(^|\/)setting\.json$/i.test(p));
  if (sj === undefined) return { profile: 'em-ee', why: 'no setting.json in the game (the default)' };
  try {
    const o = JSON.parse(String(files[sj] ?? '').replace(/^\uFEFF/, ''));
    const k = o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o) : [];
    if (k.length > 0 && k.every((x) => EMEE_JSON_KEYS.has(x)))
      return { profile: 'em-ee', why: `${sj} has recognized EM+EE keys: ${k.join(', ')}` };
    const extra = k.filter((x) => !EMEE_JSON_KEYS.has(x));
    return {
      profile: 'emuera-net',
      why: extra.length
        ? `${sj} has keys EM+EE does not know (${extra.join(', ')})`
        : `${sj} has no keys (treated as Emuera.NET)`,
    };
  } catch {
    return { profile: 'emuera-net', why: `${sj} is not readable JSON (treated as Emuera.NET)` };
  }
}
export function detectProfile(files: Record<string, string>): EngineProfile {
  return describeProfile(files).profile;
}

/**
 * instructions that exist only in PuchiEmuera (profile 'puchi'; runtime/puchicmds.ts), known to the parser only under that profile. FADE alpha,group,ms,color / SHAKE coef,amp,"g,g",ms
 * (screen effects on the fixed-image layer), FONTEDGE on / FONTEDGE_COLOR r,g,b / RESET_FONTEDGE_COLOR (text outline), OUTPUTHINTS (writes resources/HINT/*.dat out as .txt files).
 */
export const PUCHI_ONLY_INSTRUCTIONS: Record<string, string> = {
  FADE: 'INT',
  SHAKE: 'INT',
  FONTEDGE: 'INT',
  FONTEDGE_COLOR: 'INT',
  RESET_FONTEDGE_COLOR: 'VOID',
  OUTPUTHINTS: 'VOID',
  HTML_PRINTSL: 'SP_HTML_PRINT',
};

/** instructions that exist only in Emuera.NET (name -> argument builder), known to the parser only under that profile */
export const NET_ONLY_INSTRUCTIONS: Record<string, string> = { MATCHALL: 'SP_MATCHALL' };
