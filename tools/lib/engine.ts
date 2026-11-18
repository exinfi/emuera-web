/** Engine interface the headless adapter (src/engine/adapter.ts) and the tests run against. */
export interface RunOptions {
  /** Inputs fed, in order, whenever the engine blocks on INPUT/WAIT/BINPUT. */
  inputs?: string[];
  /** Variable expressions to read after the run, e.g. "FLAG:1" or "RESULTS:0". */
  readVars?: string[];
  /** Hard stop in ms (default 4000). */
  timeoutMs?: number;
  /** when inputs run out, feed this string up to `autoCount` more times (exploration only) */
  auto?: string;
  autoCount?: number;
}

export interface RunResult {
  /** Text of every output line, in order. */
  output: string[];
  /** Values of the requested variable expressions. */
  vars: Record<string, unknown>;
  /** Runtime errors and unrecognised-command messages. */
  errors: string[];
  /** True if the engine finished the entry function without being cut off. */
  finished: boolean;
  /** True if the engine asked for more input than was supplied. */
  starved: boolean;
}

export interface ImplementedSet {
  commands: Set<string>;
  functions: Set<string>;
  /** How the set was derived, shown in reports. */
  method: 'registry' | 'heuristic';
}

export interface EngineAdapter {
  name: string;
  implemented(): Promise<ImplementedSet>;
  /** Runs `erb` as a one-file game. The entry point is `@SYSTEM_TITLE`. */
  runSnippet(erb: string, opts?: RunOptions): Promise<RunResult>;
  /** Mounts a full game (as raw ERB/CSV text) and runs it with scripted input. */
  runGame?(files: GameFiles, opts?: RunOptions & { maxSteps?: number }): Promise<RunResult>;
}

export interface GameFiles {
  erb: Record<string, string>;
  csv: Record<string, string>;
}

export async function loadAdapter(name: string): Promise<EngineAdapter> {
  if (name === 'new') {
    try {
      const adapterPath = '../../src/engine/adapter.ts';
      const mod = await import(adapterPath);
      return mod.engine as EngineAdapter;
    } catch {
      throw new Error('Could not load src/engine/adapter.ts');
    }
  }
  throw new Error(`Unknown engine "${name}"`);
}
