/**
 * Default caps for the history log (host-web tier, no DOM). A game's own `履歴ログの行数` is lowered to the cap when it asks for more (eraMegaten asks for 50000);
 * the engine applies it from `StartMsg.logCap` and leaves a debug note. Tentative numbers: erablue asks for 500, which was never a problem.
 */
export const LOG_CAP_DESKTOP = 2000;
export const LOG_CAP_MOBILE = 500;
