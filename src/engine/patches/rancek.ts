/**
 * Game-specific native patch for eraRanceK (fingerprint-gated, speed only: same results as the script).
 *
 * @CHECK_COUNTRY_RELATION(ARG:0, ARG:1) (ERB/SLG/SLG_FUNCTION.ERB) tells how country ARG:0 stands to country ARG:1 (hostile, truce, union, alliance,
 * marquis/colony/puppet and their overlords, own country). It walks every treaty table for each call: 100 slots each for the three vassal kinds (twice),
 * alliances and truces, 10 for unions, with a 15-entry country list inside the last three. The relation map (@TMP_CREATE_RELATION_MAP) calls it for
 * every pair of countries, about 4,700 times per shop screen and again each turn, which is several seconds in the interpreter.
 * This port runs the same checks in the same order natively and sets RESULT:1 (remaining term of the winning relation) exactly as the script does.
 */
import type { Value } from '../runtime/value';
import type { VM } from '../runtime/vm';
import { fingerprint } from './erablue';

const n = (v: Value | undefined) => Number(v ?? 0);

/** how country a stands to country b: [relation code, remaining term of the winning relation]; shared by the call form and the expression form of the script function */
function countryRelation(vm: VM, a: number, b: number): [number, number] {
  const st = vm.store;
  if (a === 0 || b === 0) return [0, 0]; // GROUPMATCH(0, ARG:0, ARG:1)
  if (a === b) return [5, 0];
  const arr = (name: string) => st.globalArr(st.meta(name)!);
  const C = st.meta('TREATY_A_COUNTRY')!.dims[1]; // MAX_TREATY_COUNTRY
  // vassal tables: IS_x[slot] > 0 and X_COUNTRY[slot][0][0] / [slot][1][1] (flat: (slot * C + k) * 2 + k)
  const vassal = (is: string, cty: string, subj: number, lord: number): boolean => {
    const on = arr(is),
      c = arr(cty);
    for (let i = 0; i < on.length; i++) {
      if (n(on[i]) <= 0) continue;
      if (n(c[(i * C + 1) * 2 + 1]) === lord && n(c[(i * C + 0) * 2 + 0]) === subj) return true;
    }
    return false;
  };
  // (ARG:1 is ARG:0's marquis / colony / puppet) then (ARG:1 is ARG:0's overlord)
  if (vassal('IS_TREATY_M', 'TREATY_M_COUNTRY', b, a)) return [7, 0];
  if (vassal('IS_TREATY_CO', 'TREATY_CO_COUNTRY', b, a)) return [8, 0];
  if (vassal('IS_TREATY_P', 'TREATY_P_COUNTRY', b, a)) return [9, 0];
  if (vassal('IS_TREATY_M', 'TREATY_M_COUNTRY', a, b)) return [6, 0];
  if (vassal('IS_TREATY_CO', 'TREATY_CO_COUNTRY', a, b)) return [6, 0];
  if (vassal('IS_TREATY_P', 'TREATY_P_COUNTRY', a, b)) return [6, 0];
  // alliance / union / truce: both countries listed in the same entry
  const both = (term: string, cty: string): number => {
    const t = arr(term),
      c = arr(cty);
    for (let i = 0; i < t.length; i++) {
      if (n(t[i]) <= 0) continue;
      let f = false,
        g = false;
      for (let j = 0; j < C; j++) {
        const v = n(c[i * C + j]);
        if (v === a) f = true;
        if (v === b) g = true;
      }
      if (f && g) return n(t[i]);
    }
    return NaN;
  };
  let t = both('TREATY_A_TERM', 'TREATY_A_COUNTRY');
  if (!Number.isNaN(t)) return [t === 9999 ? 4 : 3, t];
  t = both('TREATY_U_TERM', 'TREATY_U_COUNTRY');
  if (!Number.isNaN(t)) return [2, t];
  t = both('TREATY_C_TERM', 'TREATY_C_COUNTRY');
  return Number.isNaN(t) ? [0, 0] : [1, t];
}

/** @CHECK_COUNTRY_RELATION(ARG:0, ARG:1) as a statement: RESULT is the code, RESULT:1 the remaining term (zeroed first, as the script does) */
function* checkCountryRelation(vm: VM, args: Value[]): Generator<any, number, any> {
  const [code, term] = countryRelation(vm, n(args[0]), n(args[1]));
  vm.global('RESULT')[1] = term;
  return code;
}
/** @CHECK_COUNTRY_RELATION_F(ARG:0, ARG:1): the same code as an expression value; it never touches RESULT */
function* checkCountryRelationF(vm: VM, args: Value[]): Generator<any, number, any> {
  return countryRelation(vm, n(args[0]), n(args[1]))[0];
}

/**
 * Shop-screen loop (patch 'rancek-shop-loop'). @SHOW_SHOP rebuilds a few maps every time the shop menu is drawn, i.e. after every action:
 *  - @TMP_CREATE_IS_FREE_MAP (ERB/SLG/SLG_FUNCTION_TMP.ERB): for every character, the tests that mark a character as not free. Three of its four
 *    @ID_TO_CHARA calls per character scan the whole roster (FINDCHARA over CFLAG:キャラＩＤ); the native version looks the id up in a table built once.
 *    The first IF chain of that function has a block of nested IFs after a CONTINUE that can never run (the ENDIFs close the nested chain, so the
 *    following ELSEIFs belong to the outer IF); only the reachable tests are kept. The commander passes call the real @GET_CITY_COMMANDER / @GET_UNIT_COMMANDER.
 *  - @TMP_CREATE_COUNTRY_NEIBORING_MAP: all city pairs (200 x 200) tested with @IS_ROUTE; the native version does the cheap tests natively and does the
 *    @IS_ROUTE / @GET_RELAYPOINT searches natively (15,500 relay searches per draw).
 * Both are also fingerprint-checked on the leaf functions they inline (@ID_TO_CHARA, @GET_ID, @IS_ANIMAL, @IS_ROUTE, @GET_RELAYPOINT) so a changed leaf turns the patch off.
 */
function* isFreeMap(vm: VM): Generator<any, void, any> {
  const st = vm.store,
    nch = st.charas.length;
  const cm = (name: string) => st.meta(name)!;
  const ci = (t: string, name: string) => vm.tables.nameToIndex(t, name)!;
  const CFLAG = cm('CFLAG'),
    TALENT = cm('TALENT'),
    COOL = cm('COOLTIME'),
    FREE = cm('TMP_IS_FREE'),
    FLAG = vm.global('FLAG');
  const iCapt = ci('CFLAG', '捕虜先'),
    iAct = ci('CFLAG', '行動不能状態'),
    iId = ci('CFLAG', 'キャラＩＤ');
  const tTent = ci('TALENT', '触手妊娠'),
    tATent = ci('TALENT', 'Ａ触手妊娠'),
    tAnimal = ci('TALENT', '動物');
  const child = n(vm.global('行動不能_子供')[0]);
  // @ID_TO_CHARA(x): first character whose CFLAG:キャラＩＤ is x, else -1
  const byId = new Map<number, number>();
  for (let c = 0; c < nch; c++) {
    const id = n(st.charaArr(c, CFLAG)[iId]);
    if (!byId.has(id)) byId.set(id, c);
  }
  const idToChara = (x: number) => byId.get(x) ?? -1;
  const mgr = ['娯楽担当', '触手部屋管理者', '弁当屋店長', '娼館管理者'].map((nm) =>
    idToChara(n(FLAG[ci('FLAG', nm)])),
  ); // GROUPMATCH(c, ID_TO_CHARA(FLAG:..) x4)
  for (let c = 0; c < nch; c++) st.charaArr(c, FREE)[0] = 0; // CVARSET TMP_IS_FREE, 0, 0
  for (let c = 0; c < nch; c++) {
    const cf = st.charaArr(c, CFLAG),
      tl = st.charaArr(c, TALENT);
    let busy = n(cf[iCapt]) !== 0 || n(cf[iAct]) === child;
    if (!busy) busy = n(tl[tTent]) !== 0 || n(tl[tATent]) !== 0 || n(tl[tAnimal]) !== 0; // @IS_ANIMAL(c): TALENT:動物 (c is in range here)
    if (!busy) busy = n(st.charaArr(c, COOL)[0]) !== 0 || mgr.includes(c);
    if (busy) st.charaArr(c, FREE)[0] = -1;
  }
  const maxCity = n(vm.global('MAX_CITY')[0]),
    maxCountry = n(vm.global('MAX_COUNTRY')[0]);
  const gcc = vm.findFunc('GET_CITY_COMMANDER')!,
    guc = vm.findFunc('GET_UNIT_COMMANDER')!,
    isCountry = vm.findFunc('IS_COUNTRY')!;
  const setFree = (c: number, v: number) => {
    st.charaArr(c, FREE)[0] = v;
  }; // out-of-range characters raise the same error the script would
  for (let a = 0; a < maxCity; a++)
    for (let j = 0; j < 2; j++) {
      const c = n(vm.callMethod(gcc, [a, j]));
      if (c >= 0) setFree(c, 2);
    }
  const soldier = vm.global('UNIT_SOLDIER');
  const uDim = vm.store.meta('UNIT_SOLDIER')!.dims[1];
  for (let a = 0; a < maxCountry; a++) {
    if (!n(vm.callMethod(isCountry, [a]))) continue;
    for (let u = 0; u < 10; u++) {
      if (n(soldier[a * uDim + u]) <= 0) continue;
      for (let k = 0; k < 3; k++) {
        const c = n(vm.callMethod(guc, [a, u, k]));
        if (c >= 0) setFree(c, 1);
      }
    }
  }
}

function* neiboringMap(vm: VM): Generator<any, void, any> {
  const st = vm.store,
    maxCity = n(vm.global('MAX_CITY')[0]);
  const type = vm.global('CITY_TYPE'),
    owner = vm.global('CITY_OWNER'),
    route = vm.global('CITY_ROUTE');
  const R = st.meta('CITY_ROUTE')!.dims[1];
  const nb = vm.global('TMP_COUNTRY_IS_NEIBORING'),
    K = st.meta('TMP_COUNTRY_IS_NEIBORING')!.dims[1];
  const relay = vm.findFunc('GET_RELAYPOINT')!;
  nb.fill(0); // VARSET TMP_COUNTRY_IS_NEIBORING, 0
  // @IS_ROUTE(a, b): a != b, both 1..MAX_CITY, a direct entry in CITY_ROUTE:a (10 slots), else a relay point
  const isRoute = (a: number, b: number): boolean => {
    if (a === b || a < 1 || a > maxCity || b < 1 || b > maxCity) return false;
    for (let k = 0; k < 10; k++) if (n(route[a * R + k]) === b) return true;
    return relayPoint(a, b);
  };
  // @GET_RELAYPOINT(a, b) >= 0: some entry of CITY_ROUTE:a is a relay point (CITY_TYPE 1) that CITY_ROUTE:b also lists. An entry outside the city table is
  // left to the script itself (it raises the error the original would).
  const relayPoint = (a: number, b: number): boolean => {
    for (let k = 0; k < 10; k++) {
      const r = n(route[a * R + k]);
      if (r < 0 || r >= type.length) return n(vm.callMethod(relay, [a, b])) >= 0;
      if (n(type[r]) !== 1) continue;
      for (let m = 0; m < 10; m++) if (n(route[b * R + m]) === r) return true;
    }
    return false;
  };
  for (let a = 1; a < maxCity; a++) {
    if (n(type[a]) !== 0 || !n(owner[a])) continue;
    const oa = n(owner[a]);
    for (let b = 1; b < maxCity; b++) {
      const ob = n(owner[b]);
      if (!ob || oa === ob) continue; // (the script tests CITY_TYPE:a again here, not CITY_TYPE:b)
      if (isRoute(a, b)) nb[oa * K + ob] = 1;
    }
  }
}

type Native = { fingerprint: string; run: (vm: VM, args: Value[]) => Generator<any, void | number, any> };
/** patch id -> the functions it replaces; `needs` are leaf functions the native code inlines (fingerprint-checked, never replaced) */
export const RANCEK_PATCHES: Record<string, { natives: Record<string, Native>; needs?: Record<string, string> }> = {
  'rancek-relation': {
    natives: { CHECK_COUNTRY_RELATION: { fingerprint: 'e980e843:128', run: checkCountryRelation } },
  },
  // MOVE_CHARA_CITY itself stays the script's (its random draws must keep their order); what it spends its time on is ~6,000 calls of the expression form below
  'rancek-move-chara': {
    natives: { CHECK_COUNTRY_RELATION_F: { fingerprint: '2c2e66d:122', run: checkCountryRelationF } },
  },
  'rancek-shop-loop': {
    natives: {
      TMP_CREATE_IS_FREE_MAP: { fingerprint: 'af451590:51', run: (vm) => isFreeMap(vm) },
      TMP_CREATE_COUNTRY_NEIBORING_MAP: { fingerprint: '87b65cc1:12', run: (vm) => neiboringMap(vm) },
    },
    needs: {
      ID_TO_CHARA: '86e319ea:7',
      IS_ANIMAL: '24c95c77:3',
      IS_ROUTE: '7abd6954:10',
      GET_RELAYPOINT: 'cefa720a:12',
      GET_ID: 'c7963e26:4',
    },
  },
};

/** Install one patch's natives when every function it replaces or relies on matches the shipped game. Returns the names applied (empty = patch not active). */
export function installRanceKPatches(vm: VM, id: string): string[] {
  const p = RANCEK_PATCHES[id];
  if (!p) return [];
  for (const [name, fp] of Object.entries(p.needs ?? {})) {
    const f = vm.findFunc(name);
    if (!f || fingerprint(f) !== fp) return [];
  }
  const fns = Object.entries(p.natives).map(([name, nat]) => ({ name, nat, fn: vm.findFunc(name) }));
  if (fns.some((x) => !x.fn || fingerprint(x.fn) !== x.nat.fingerprint)) return []; // all or nothing
  vm.natives ??= new Map();
  for (const x of fns) vm.natives.set(x.fn!, x.nat.run);
  return fns.map((x) => x.name);
}

/** why a patch could not be installed, for the boot summary: the first function it replaces or relies on that is missing or differs from the build it was written for */
export function whyNotRanceK(vm: VM, id: string): string {
  const p = RANCEK_PATCHES[id];
  if (!p) return 'unknown patch';
  const wanted: [string, string][] = [
    ...Object.entries(p.needs ?? {}),
    ...Object.entries(p.natives).map(([k, v]) => [k, v.fingerprint] as [string, string]),
  ];
  for (const [name, fp] of wanted) {
    const f = vm.findFunc(name);
    if (!f) return `@${name} not found`;
    if (fingerprint(f) !== fp) return `@${name} differs from the build the patch was written for`;
  }
  return 'not installed';
}
