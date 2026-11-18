/**
 * Game-specific native patches for erablue_resort (opt-in, fingerprint-gated).
 *
 * `弱点コマンド初期設定` (NEWGAME.ERB) spends ~99% of its statements in loop skeletons
 * (2 passes x 1000 x 20 GETBIT checks per character). This port runs the skeleton natively but still
 * calls the real ERB leaf functions (`敏感素質対応判定`, `弱点コマンド候補判定`, COMTYPE_*) at exactly the
 * same points and order, so RAND consumption and leaf side effects are unchanged.
 */
import type { FuncDef } from '../compiler/types';
import type { Value } from '../runtime/value';
import type { VM } from '../runtime/vm';

export function fingerprint(fn: FuncDef): string {
  const s =
    fn.name +
    '|' +
    fn.params.length +
    '|' +
    fn.body
      .map(
        (x) =>
          x.cmd +
          JSON.stringify(x.arg, (k, v) =>
            k === 'pos' || k === 'line' || k === 'col' ? undefined : typeof v === 'bigint' ? String(v) : v,
          ),
      )
      .join('\n');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16) + ':' + fn.body.length;
}
/** body-shape fingerprint of the shipped erablue_resort_en function this port was written against */
export const WEAK_INIT_FINGERPRINT = 'ce1a333d:191';

const bit = (v: Value, b: number) => Math.floor(Number(v) / 2 ** b) % 2 === 1;

function* weakInit(vm: VM, args: Value[]): Generator<any, void, any> {
  const a0: any = args[0];
  const ARG = Number(a0 && typeof a0 === 'object' && 'v' in a0 ? a0.v : a0);
  const st = vm.store;
  const slotsMeta = st.meta('弱点コマンド枠')!;
  const flagN = vm.global('通常コマンド存在フラグ');
  const flagP = vm.global('場所固有コマンド存在フラグ');
  const NO = Number(st.charaArr(ARG, st.meta('NO')!)[0]);
  const slotArr = st.charaArr(ARG, slotsMeta);
  const slots = () => slotArr;
  const count = (v: string) => {
    let n = 0;
    for (const x of slots()) if (x === v) n++;
    return n;
  }; // MATCH(arr, v)
  const count5 = (v: string) => {
    const a = slots();
    let n = 0;
    for (let i = 0; i < 5; i++) if (a[i] === v) n++;
    return n;
  };
  const full = () => count5('') === 0 && count5('-1') === 0;
  const taken = (i: number) => {
    const x = slots()[i];
    return x !== '' && x !== '-1';
  };

  if ((globalThis as any).process?.env?.EMU_PDBG)
    console.error('weakInit', ARG, JSON.stringify(slots().slice(0, 6)), full());
  if (full()) return;
  slots().fill('');
  const keyIdx = vm.tables.nameToIndex('CSTR', '口上切り替えキー')!;
  const key = String(st.charaArr(ARG, st.meta('CSTR')!)[keyIdx] ?? '');
  const cb = vm.findFunc(`弱点コマンド変更_${key}${NO}`);
  if (cb) yield* vm.callFunction(cb, []);
  if (full()) return;

  const sens = vm.findFunc('敏感素質対応判定')!,
    judge = vm.findFunc('弱点コマンド候補判定')!;
  const isSens = (n: string) => Number(vm.callMethod(sens, [ARG, n])) !== 0;
  const judgeOf = (n: string) => Number(vm.callMethod(judge, [ARG, n]));

  const sSex: string[] = [],
    sUfu: string[] = [],
    sex: string[] = [],
    ufu: string[] = [];

  // pass 1: candidates that match a sensitivity talent;  pass 2: all candidates (sensitive = false)
  for (const sensitive of [true, false]) {
    const A = sensitive ? sSex : sex,
      B = sensitive ? sUfu : ufu;
    const add = (n: string, id: string) => {
      const r = judgeOf(n);
      if (r === 1) A.push(id);
      else if (r === 2) B.push(id);
    };
    const pass = (n: string) => (sensitive ? isSens(n) : true);
    for (let L = 0; L < 1000; L++) {
      if (L >= 385 && L <= 389) continue;
      const f = flagN[L];
      if (bit(f, 0)) {
        if (count(`${L}`) === 0 && pass(`COMTYPE_${L}`)) add(`COMTYPE_${L}`, `${L}`);
        if (Number(f) > 1) {
          for (let j = 0; j < 20; j++) {
            if (!bit(f, j + 1)) continue;
            if (count(`${L}_${j}`) > 0 || !pass(`COMTYPE_S_${L}_${j}`)) continue;
            add(`COMTYPE_S_${L}_${j}`, `${L}_${j}`);
          }
        }
      }
      if (L >= 370 && L <= 374) {
        if (!vm.findFunc(`COMTYPE_${L}_${NO}`)) continue;
        if (count(`${L}_${NO}`) > 0 || !pass(`COMTYPE_${L}_${NO}`)) continue;
        add(`COMTYPE_${L}_${NO}`, `${L}_${NO}`);
      } else if (L >= 380 && L <= 384) {
        for (let j = 0; j < 20; j++) {
          const f2 = flagP[((L - 380) * 2 + 0) * 20 + j];
          if (!Number(f2)) continue;
          for (let m = 0; m < 20; m++) {
            if (!bit(f2, m)) continue;
            const l3 = j * 100 + m + 1;
            const nm = `COMTYPE_${L}_0_${l3}`;
            if (count(`${L}_0_${l3}`) > 0 || !pass(nm)) continue;
            add(nm, sensitive ? `${L}_${l3}` : `${L}_0_${l3}`);
          }
        }
      }
    }
    if (sensitive) {
      // sensitive picks: one ufufu then one sexual-harassment, first free slot (index <= 3)
      for (const [list, pick] of [
        [sUfu, 'u'],
        [sSex, 's'],
      ] as const) {
        let i = 0;
        for (;;) {
          if (i > 3 || !list.length) break;
          if (taken(i)) {
            i++;
            continue;
          }
          const r = Number(vm.randInt(list.length));
          slots()[i] = list[r];
          break;
        }
        void pick;
      }
    }
  }

  // fill remaining slots: 2 sexual-harassment, 2 ufufu, 1 random
  for (let i = 0; i < 5; i++) {
    if (taken(i)) continue;
    if (i <= 1) {
      const r = Number(vm.randInt(sex.length));
      slots()[i] = sex[r];
      sex.splice(r, 1);
    } else if (i <= 3) {
      const r = Number(vm.randInt(ufu.length));
      slots()[i] = ufu[r];
      ufu.splice(r, 1);
    } else {
      const r = Number(vm.randInt(sex.length + ufu.length));
      slots()[i] = r < sex.length ? sex[r] : ufu[r - sex.length];
    }
  }
  if ((globalThis as any).process?.env?.EMU_PDBG)
    console.error(' ->', ARG, JSON.stringify(slots().slice(0, 6)), sSex.length, sUfu.length, sex.length, ufu.length);
}

/** @INIT_RELATION(ARG): the original scans FINDELEMENT over CHARANUM for every character (O(n^2) per New Game). */
function* initRelation(vm: VM, args: Value[]): Generator<any, void, any> {
  const a0: any = args[0];
  const ARG = Number(a0 && typeof a0 === 'object' && 'v' in a0 ? a0.v : a0);
  const st = vm.store,
    n = st.charas.length;
  if (!(ARG >= 0 && ARG <= n - 1)) return;
  const relNo = st.charaArr(ARG, st.meta('RELATION_NO')!),
    relVal = st.charaArr(ARG, st.meta('RELATION_VAL')!);
  relNo.fill(0);
  relVal.fill(0);
  const cand = st.charaArr(ARG, st.meta('同行候補キャラ番号')!),
    prob = st.charaArr(ARG, st.meta('同行候補キャラ確率')!);
  const first = new Map<number, number>();
  for (let i = 0; i < cand.length; i++) {
    const v = Number(cand[i]);
    if (!first.has(v)) first.set(v, i);
  }
  let lc = 0;
  for (let L = 1; L < n; L++) {
    const r = first.get(L);
    if (r === undefined) continue;
    relNo[lc] = cand[r];
    relVal[lc] = Number(relVal[lc]) + Number(prob[r]) * 100;
    lc++;
    if (lc >= 100) break;
  }
}

export const PATCHES: Record<
  string,
  { fingerprint: string; run: (vm: VM, args: Value[]) => Generator<any, void, any> }
> = {
  弱点コマンド初期設定: { fingerprint: WEAK_INIT_FINGERPRINT, run: weakInit },
  INIT_RELATION: { fingerprint: '865ee63f:15', run: initRelation },
};

/** Install the patches whose fingerprint matches the loaded game. Returns the names applied. */
export function installPatches(vm: VM, names?: string[]): string[] {
  const applied: string[] = [];
  vm.natives ??= new Map();
  for (const [name, p] of Object.entries(PATCHES)) {
    if (names && !names.includes(name)) continue;
    const fn = vm.findFunc(name);
    if (!fn || fingerprint(fn) !== p.fingerprint) continue;
    vm.natives.set(fn, p.run);
    applied.push(name);
  }
  return applied;
}
