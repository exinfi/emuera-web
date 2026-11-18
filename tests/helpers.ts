/** Shared helpers: run a small ERB snippet through the engine adapter and read back what it printed. */
import { engine } from '../src/engine/adapter.ts';

export type Run = { output: string[]; errors: string[]; vars: Record<string, unknown>; finished: boolean };

/** Runs a snippet as `@SYSTEM_TITLE ... QUIT`, or a whole program when it starts with `@`. */
export function run(
  body: string | string[],
  o: { erh?: string; csv?: Record<string, string>; inputs?: string[]; readVars?: string[] } = {},
): Promise<Run> {
  const text = Array.isArray(body) ? body.join('\n') : body;
  const erb: Record<string, string> = {
    'ERB/MAIN.ERB': text.startsWith('@') ? text : ['@SYSTEM_TITLE', text, 'QUIT'].join('\n'),
  };
  if (o.erh) erb['ERB/V.ERH'] = o.erh;
  return engine.runGame({ erb, csv: o.csv ?? {} }, {
    inputs: o.inputs ?? [],
    readVars: o.readVars,
  } as any) as Promise<Run>;
}

/** Non-empty output lines with trailing space trimmed. */
export const lines = (r: { output: string[] }): string[] => r.output.map((l) => l.trimEnd()).filter(Boolean);

/** Runs a snippet and returns its non-empty output lines, failing if the engine reported an error. */
export async function out(body: string | string[], o: Parameters<typeof run>[1] = {}): Promise<string[]> {
  const r = await run(body, o);
  if (r.errors.length) throw new Error('engine errors: ' + r.errors.join(' | '));
  return lines(r);
}
