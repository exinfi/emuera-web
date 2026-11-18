/** Shared shapes of the translation tier. */
export interface Provider {
  readonly name: string;
  /** make the provider ready; idempotent while started */
  start(): Promise<void>;
  /** one translation per input text, same order */
  translate(texts: string[]): Promise<string[]>;
  /** free everything (the Bergamot provider terminates its worker, which returns all of its memory) */
  stop(): void;
}
/** per-game translation memory: synchronous reads from a loaded map, writes persisted by the page */
export interface Memory {
  get(text: string): { tr: string; flagged: boolean } | undefined;
  put(entries: { text: string; tr: string; flagged: boolean }[]): void;
}
export interface Entry {
  id: number;
  src: string;
  tr?: string;
  flagged?: boolean;
}
