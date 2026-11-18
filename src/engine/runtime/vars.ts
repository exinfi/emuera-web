/**
 * Variable store. Builtin metadata comes from reference/builtins.json, array lengths from
 * compiler Tables (CSV names + VariableSize.csv). Arrays are flat JS arrays; 2D/3D are row-major.
 */
import builtins from '../../../reference/builtins.json';
import type { Tables } from '../compiler/tables';
import type { VarDecl } from '../compiler/types';
import { EmueraError, Value } from './value';

export interface Meta {
  name: string;
  isStr: boolean;
  rank: number; // number of subscripts (0 = scalar)
  chara: boolean; // per-character data
  dims: number[]; // length of each dimension (chara vars: excluding the character index)
  calc: boolean; // pseudo-variable computed by the engine
  konst: boolean; // constant (values come from CSV, not savable)
  save: boolean; // included in save files
  user?: VarDecl;
  /** cached upper-case name */
  key?: string;
  /** index into Chara.slots (optimization 'chara-read-zero'): assigned on first use */
  slot?: number;
  /** shared all-zero array for reads of unset character variables */
  zero?: Arr;
}

const flagsOf = new Map<string, string[]>();
for (const v of builtins.variables as { name: string; flags: string[] }[]) flagsOf.set(v.name, v.flags);

export const isBuiltinVar = (n: string) => flagsOf.has(n);
export const builtinVarNames = (): string[] => [...flagsOf.keys()];

export type Arr = Value[];
export const fill = (n: number, isStr: boolean): Arr => new Array(n).fill(isStr ? '' : 0);

export class Chara {
  private _vars = new Map<string, Arr>();
  /** arrays by Meta.slot, filled on demand from `vars` when the fast path is on; dropped whenever `vars` is replaced */
  slots: (Arr | undefined)[] = [];
  /** like `slots` but for reads only: an unset variable may hold the shared all-zero array (never write through it) */
  rslots: (Arr | undefined)[] = [];
  get vars(): Map<string, Arr> {
    return this._vars;
  }
  set vars(m: Map<string, Arr>) {
    this._vars = m;
    this.slots = [];
    this.rslots = [];
  }
  /** CSV template number (NO) lives in the NO variable; kept here for debugging */
  constructor(public no = 0) {}
}

export class Store {
  private metas = new Map<string, Meta>();
  global = new Map<string, Arr>();
  charas: Chara[] = [];
  /** EMU_LENIENT=1: tolerate references to characters absent from a trimmed game (never for real runs) */
  lenient = !!(globalThis as any).process?.env?.EMU_LENIENT;
  /** optimization 'chara-read-zero' (see opts.ts): plain reads of an unset character variable do not allocate it */
  readZero = false;
  private nextSlot = 0;
  /** user static #DIM (per function) and #DIM CONST arrays */
  statics = new Map<string, Arr>();
  /** initial contents of system arrays whose default is not all zero (ITEMPRICE, STR, PALAMLV, TARGET...) */
  defaultFor?: (nameUp: string) => Value[] | undefined;

  constructor(
    public tables: Tables,
    public userGlobals: Map<string, VarDecl>,
  ) {}

  meta(nameUp: string): Meta | undefined {
    let m = this.metas.get(nameUp);
    if (m) return m;
    const u = this.userGlobals.get(nameUp);
    if (u) {
      m = {
        name: u.name,
        isStr: u.isStr,
        rank: u.dims.length,
        chara: u.isChara,
        dims: u.dims,
        calc: false,
        konst: u.isConst,
        save: u.isSave,
        user: u,
      };
    } else {
      const f = flagsOf.get(nameUp);
      if (!f) return undefined;
      const rank = f.includes('ARRAY_3D') ? 3 : f.includes('ARRAY_2D') ? 2 : f.includes('ARRAY_1D') ? 1 : 0;
      const dims: number[] = [];
      for (let d = 0; d < rank; d++) dims.push(this.tables.varSize(nameUp, d) ?? 1);
      if (rank === 0) dims.push(1);
      m = {
        name: nameUp,
        isStr: f.includes('STRING'),
        rank,
        chara: f.includes('CHARACTER_DATA'),
        dims,
        calc: f.includes('CALC'),
        konst: f.includes('CONSTANT') || f.includes('UNCHANGEABLE'),
        save: !f.includes('CALC') && !f.includes('LOCAL'),
      };
    }
    this.metas.set(nameUp, m);
    return m;
  }

  size(m: Meta): number {
    return m.dims.reduce((a, b) => a * b, 1);
  }

  globalArr(m: Meta): Arr {
    const k = m.key ?? (m.key = m.name.toUpperCase());
    let a = this.global.get(k);
    if (!a) {
      a = fill(this.size(m), m.isStr);
      if (m.user?.init)
        m.user.init.forEach((v, i) => {
          if (i < a!.length) a![i] = v as Value;
        });
      else if (!m.user)
        this.defaultFor?.(k)?.forEach((v, i) => {
          if (i < a!.length) a![i] = v;
        });
      this.global.set(k, a);
    }
    return a;
  }

  charaArr(ci: number, m: Meta): Arr {
    const c = this.charas[ci];
    // trimmed-game testing only: a missing character reads as zeros and swallows writes
    if (!c && this.lenient) return fill(this.size(m), m.isStr);
    if (!c) throw new EmueraError(`character index ${ci} is out of range (CHARANUM=${this.charas.length})`);
    if (this.readZero) {
      // fast path: per-character slot array instead of a Map lookup by name
      const sl = m.slot ?? (m.slot = this.nextSlot++);
      const hit = c.slots[sl];
      if (hit) return hit;
      const k = m.key ?? (m.key = m.name.toUpperCase());
      let a = c.vars.get(k);
      if (!a) {
        a = fill(this.size(m), m.isStr);
        c.vars.set(k, a);
      }
      c.rslots[sl] = a; // a read slot that held the shared zeros now points at the real array
      return (c.slots[sl] = a);
    }
    const k = m.key ?? (m.key = m.name.toUpperCase());
    let a = c.vars.get(k);
    if (!a) {
      a = fill(this.size(m), m.isStr);
      c.vars.set(k, a);
    }
    return a;
  }

  /**
   * Read-only twin of charaArr for plain value reads. With readZero on, an unset variable is answered from one shared
   * all-zero array (never written: every writer goes through charaArr), so no per-character array is created.
   */
  charaArrRead(ci: number, m: Meta): Arr {
    if (!this.readZero) return this.charaArr(ci, m);
    const c = this.charas[ci];
    if (!c) return this.charaArr(ci, m); // lenient / out-of-range handling stays in one place
    const sl = m.slot ?? (m.slot = this.nextSlot++);
    const hit = c.rslots[sl];
    if (hit) return hit;
    const a = c.vars.get(m.key ?? (m.key = m.name.toUpperCase()));
    if (a) {
      c.slots[sl] = a;
      return (c.rslots[sl] = a);
    }
    return (c.rslots[sl] = m.zero ??= fill(this.size(m), m.isStr));
  }

  /** flat offset for subscripts (already validated count == dims.length) */
  offset(m: Meta, idx: number[]): number {
    let off = 0;
    for (let d = 0; d < m.dims.length; d++) {
      const i = idx[d] ?? 0;
      if (i < 0 || i >= m.dims[d]) throw new EmueraError(`${m.name}: index ${i} is out of range (0..${m.dims[d] - 1})`);
      off = off * m.dims[d] + i;
    }
    return off;
  }
}
