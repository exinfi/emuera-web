/** Test/CLI adapter: runs the new engine headless against the EngineAdapter interface. */
import type { EngineAdapter, GameFiles, ImplementedSet, RunOptions, RunResult } from '../../tools/lib/engine';
import { parseProgram } from './compiler/parser';
import { Cursor } from './compiler/cursor';
import { ExprParser } from './compiler/expr';
import { Tables } from './compiler/tables';
import { cfg as compilerCfg } from './compiler/config';
import { VM } from './runtime/vm';
import { compile } from './runtime/eval';
import { loadConfig, useNewRandom } from './runtime/config';
import { CharaTemplates } from './runtime/charatemplates';
import { formatStack } from './runtime/errctx';
import { installPatches } from './patches/erablue';
import { COMMANDS } from './runtime/commands';
import { FUNCS } from './runtime/funcs';
import type { Renderer } from './runtime/host';

export class Capture implements Renderer {
  lines: string[] = [];
  cur = '';
  notes: string[] = [];
  print(t: string) {
    this.cur += t;
  }
  /** the last line was printed by REUSELASTLINE: the next line replaces it (EmueraConsole.addDisplayLine) */
  tempLast = false;
  /** same 履歴ログの行数 handling as the page renderer (src/play/worker.ts): drop the oldest lines, keep LINECOUNT logical */
  maxLog = 5000;
  dropped = 0;
  newline() {
    if (this.tempLast) {
      this.lines.pop();
      this.tempLast = false;
    }
    this.lines.push(this.cur);
    this.cur = '';
    if (this.lines.length > this.maxLog) {
      this.lines.shift();
      this.dropped++;
    }
  }
  clearScreen() {
    this.lines = [];
    this.cur = '';
    this.tempLast = false;
    this.dropped = 0;
  }
  clearLines(n: number) {
    if (n > 0) this.tempLast = false;
    const have = this.lines.length,
      take = Math.min(n, have);
    this.lines.length = have - take;
    if (n > take) this.dropped = Math.max(0, this.dropped - (n - take));
  }
  pending() {
    return this.cur !== '';
  }
  lineCount() {
    return this.lines.length + this.dropped;
  }
  displayLine(n: number) {
    return this.lines[n] ?? '';
  }
  htmlLine(n: number) {
    const l = this.lines[this.lines.length - 1 - n];
    return l === undefined ? '' : `<p align='left'><nobr>${l}</nobr></p>`;
  }
  popPendingHtml() {
    const t = this.cur;
    this.cur = '';
    return t;
  }
  lastLine() {
    return { temp: this.tempLast, empty: this.lines.length > 0 && this.lines[this.lines.length - 1].trim() === '' };
  }
  drawLine(ch = '-') {
    if (this.cur) this.newline();
    this.cur = ch.repeat(40);
    this.newline();
  }
  setColor() {}
  setBgColor() {}
  resetColor() {}
  setFont() {}
  setStyle() {}
  setAlign() {}
  reuseLastLine(t: string) {
    if (t === '') return;
    if (this.cur !== '') this.newline();
    if (this.tempLast) {
      this.lines.pop();
      this.tempLast = false;
    }
    this.cur = t;
    this.newline();
    this.tempLast = true;
  }
  buttons: { label: string; value: string }[] = [];
  button(text: string, value = '') {
    this.cur += text;
    this.buttons.push({ label: text, value });
  }
  image(name: string) {
    this.cur += `[IMG ${name}]`;
  }
  html(m: string, noNewline = false) {
    if (!noNewline && this.cur !== '') this.newline();
    for (const b of m.matchAll(/<button\b((?:[^>'"]|'[^']*'|"[^"]*")*)>(.*?)<\/button>/gis)) {
      const v = /value\s*=\s*['"]?([^'">\s]*)/i.exec(b[1]);
      this.buttons.push({ label: b[2].replace(/<[^>]*>/g, '').trim(), value: v ? v[1] : '' });
    }
    const text = m
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<img[^>]*src=['"]([^'"]*)['"][^>]*>/gi, '[IMG $1]')
      .replace(/<[^>]*>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
    text.split('\n').forEach((t, i, arr) => {
      this.cur += t;
      if (i < arr.length - 1) this.newline();
    });
    if (!noNewline) this.newline();
  }
  note(m: string) {
    this.notes.push(m);
  }
  lineIsEmpty() {
    return this.cur === '';
  }
  all() {
    return this.cur ? [...this.lines, this.cur] : this.lines;
  }
}

function toCsvPaths(files: GameFiles) {
  const csv: Record<string, string> = {};
  for (const [p, t] of Object.entries(files.csv)) csv[/^csv\//i.test(p) ? p : 'CSV/' + p.replace(/^.*\//, '')] = t;
  return csv;
}

async function run(files: GameFiles, opts: RunOptions & { maxSteps?: number } = {}): Promise<RunResult> {
  const csv = files.csv;
  const prog = parseProgram(
    Object.entries(files.erb).map(([path, text]) => ({ path, text })),
    { csv },
  );
  const cap = new Capture();
  const vm = new VM(prog, new Tables(csv), cap);
  vm.templates = new CharaTemplates(csv, vm.tables);
  if (compilerCfg.profile === 'puchi') vm.tables.loadTranslation(csv); // same step as the page's worker
  vm.config = loadConfig(csv);
  cap.maxLog = vm.config.maxLog;
  vm.maxSteps = opts.maxSteps ?? 2_000_000;
  vm.gameFiles = [
    ...Object.keys(files.erb),
    ...Object.keys(files.csv),
    ...(((opts as any).extraFiles as string[]) ?? []),
  ];
  for (const f of ((opts as any).unloadedFiles as string[]) ?? []) vm.unloadedFiles.add(f);
  vm.fontFamilies = ((opts as any).fontFamilies as string[]) ?? [];
  const sounds: unknown[] = [];
  for (const f of (opts as any).soundFiles ?? []) vm.soundFiles.add(String(f).toLowerCase());
  (cap as any).sound = (m: unknown) => {
    sounds.push(m);
  };
  const errors0: string[] = [];
  const env = (globalThis as any).process?.env ?? {};
  vm.setOptimize(env.EMU_OPT === '1');
  vm.useNewRandom = useNewRandom(csv);
  if (env.EMU_SEED) {
    let a = Number(env.EMU_SEED) >>> 0;
    vm.rng = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  if (env.EMU_PATCH) errors0.push('patches: ' + (installPatches(vm).join(',') || 'none matched'));
  const errors: string[] = prog.diagnostics
    .filter((d) => d.level === 'error')
    .map((d) => `${d.file}:${d.line} ${d.msg}`);
  const queue = [...(opts.inputs ?? [])];
  let autoLeft = opts.autoCount ?? 0;
  let finished = false,
    starved = false;
  const deadline = Date.now() + (opts.timeoutMs ?? 4000);
  try {
    const gen = vm.run();
    let r = gen.next();
    while (!r.done) {
      if (Date.now() > deadline) break;
      const req: any = r.value;
      if (req.t === 'input') {
        if (!queue.length && autoLeft > 0 && opts.auto !== undefined) {
          queue.push(opts.auto);
          autoLeft--;
        }
        if (!queue.length) {
          starved = true;
          break;
        }
        let inp = queue.shift()!;
        if (inp.startsWith('@')) {
          // "@label" picks the most recently shown button with that label (or label substring)
          const want = inp.slice(1);
          const hit =
            [...cap.buttons].reverse().find((b) => b.label === want || b.label.replace(/[\[\]]/g, '') === want) ??
            [...cap.buttons].reverse().find((b) => b.label.includes(want));
          if (!hit) {
            errors.push(`script: no button '${want}'`);
            break;
          }
          inp = hit.value;
        }
        r = gen.next(inp);
      } else r = gen.next(null);
    }
    finished = !!r.done;
  } catch (e: any) {
    errors.push(e.message + (e.erb ? '\n' + formatStack(e.erb) : ''));
  }
  errors.push(...errors0);
  if (env.EMU_DUMP) (await import('node:fs')).writeFileSync(env.EMU_DUMP, vm.snapshot());
  const vars: Record<string, unknown> = {};
  const fn = vm.findFunc('SYSTEM_TITLE') ?? [...prog.funcs.values()][0]?.[0];
  for (const v of opts.readVars ?? []) {
    try {
      const ex = new ExprParser(new Cursor(v)).expr();
      vars[v] = fn ? compile(ex, fn, vm)(vm.newFrame(fn, false)) : `<no function>`;
      if (typeof vars[v] === 'bigint') vars[v] = Number(vars[v]);
    } catch (e: any) {
      vars[v] = `<error: ${e.message}>`;
    }
  }
  return {
    output: cap.all(),
    vars,
    errors: [...errors, ...cap.notes, ...[...vm.unimplemented].map(([k, n]) => `unimplemented ${k} x${n}`)],
    finished,
    starved,
    sounds,
  } as RunResult;
}

export const engine: EngineAdapter = {
  name: 'new',
  async implemented(): Promise<ImplementedSet> {
    return { commands: new Set(Object.keys(COMMANDS)), functions: new Set(Object.keys(FUNCS)), method: 'registry' };
  },
  runSnippet: (erb, opts) => run({ erb: { 'ERB/TEST.ERB': erb }, csv: {} }, opts),
  runGame: (files, opts) => run(files, opts),
};
void toCsvPaths;
