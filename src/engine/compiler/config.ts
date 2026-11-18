/**
 * Parse-time switches that mirror Emuera config items. The compiler is otherwise pure;
 * this module-level object is (re)set by parseProgram() from its options.
 */
import type { EngineProfile } from '../profile';

export interface CompilerConfig {
  /** 全角スペースをホワイトスペースに含める (EM+EE default YES; erablue_resort sets NO in _fixed.config) */
  fullWidthSpace: boolean;
  /** 文字色 / 選択中文字色 as 0xRRGGBB: GETDEFCOLOR() and GETFOCUSCOLOR() fold to these at parse time (CanRestructure in the C#) */
  /** which Emuera the game targets (see engine/profile.ts) */
  profile: EngineProfile;
  foreColor: number;
  bgColor: number;
  focusColor: number;
  /** FORM中の三連記号を展開しない (erablue_resort: YES) */
  ignoreTripleSymbol: boolean;
  /** #DEFINE macros: upper-cased name -> replacement text (filled while the ERH files load) */
  macros: Map<string, string>;
  /** VARSIZEの次元指定をERD機能に合わせる: the dimension argument of VARSIZE counts from 1 */
  varsizeDim: boolean;
  /** システム関数の上書きを許可する (default YES; erablue_resort: NO) */
  allowOverload: boolean;
  /** システム関数が上書きされたとき警告を表示する (forced on when overriding is not allowed) */
  warnOverload: boolean;
}
export const cfg: CompilerConfig = {
  fullWidthSpace: true,
  profile: 'em-ee',
  foreColor: 0xc0c0c0,
  bgColor: 0,
  focusColor: 0xffff00,
  ignoreTripleSymbol: true,
  macros: new Map(),
  varsizeDim: false,
  allowOverload: true,
  warnOverload: true,
};
