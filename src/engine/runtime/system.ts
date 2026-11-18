/**
 * The Emuera system state machine, following the original.
 *
 * In Emuera a "system state" decides what the engine does when the script call stack runs empty:
 * every handler below is the equivalent of one `SystemStateCode` entry in `systemProcessDictionary`.
 * Handlers that start a script function set the *next* state first (the function may BEGIN something
 * else, which overrides it) and then run it to completion; when it returns the loop dispatches on the
 * state that is current by then, exactly like `runSystemProc()`.
 *
 * BEGIN is deferred: it records the target, the current function returns, and the switch happens when the
 * outermost call finishes (ProcessState.Return -> Begin). Inside @EVENTSHOP the switch is postponed until
 * after the autosave (ProcessState.Begin: `Shop_CallEventShop -> return`).
 */
import { resetStyle } from './consolestate';
import type { FuncDef } from '../compiler/types';
import { COMMANDS, StarvedError } from './commands';
import { addChara } from './charas';
import { asInt, compile, padTo, toNum } from './eval';
import { saveSlot, slotExists, slotInfo, loadSlot, SAVE_AUTO } from './savedata';
import { EmueraError, Value } from './value';
import * as V from './value';
import type { Arr } from './vars';
import { LoadSignal } from './vm';
import type { Gen, VM } from './vm';

const BEGIN_TARGETS: Record<string, string> = {
  SHOP: 'Shop_Begin',
  TRAIN: 'Train_Begin',
  AFTERTRAIN: 'AfterTrain_Begin',
  ABLUP: 'Ablup_Begin',
  TURNEND: 'Turnend_Begin',
  FIRST: 'First_Begin',
  TITLE: 'Title_Begin',
};
/** states where SAVEGAME/LOADGAME are allowed (__CAN_SAVE__) */
const CAN_SAVE = new Set([
  'Shop_Begin',
  'Shop_CallEventShop',
  'Shop_CallShowShop',
  'Shop_WaitInput',
  'Shop_CallEventBuy',
  'Normal',
]);
/** states where DOTRAIN is allowed */
const CAN_DOTRAIN = new Set([
  'Train_CallEventTrain',
  'Train_CallShowStatus',
  'Train_CallShowUserCom',
  'Train_CallEventComEnd',
]);

/** the strings Emuera prints itself (emuera-eng.xml) */
export const MSG = {
  invalid: 'Invalid value',
  executed: (n: number, of: number) => `＜Executed command：${n}/${of}＞`,
  cantExecute: 'Unable to execute command',
  noMoney: 'Not enough money.',
  outOfStock: 'Out of stock.',
  saveQ: 'Where do you want to save?',
  loadQ: 'What do you want to load?',
  overwrite: 'Save already exists. Overwrite?',
  yes: '[0] Yes',
  no: '[1] No',
  noData: 'No data found',
  autoSaveErr1: 'An unexpected error occurred during autosave',
  autoSaveErr2: 'Autosave will be skipped',
  saveErr: 'Unexpected error while saving has occurred',
  scriptEnd: 'Script execution terminated',
  back: '[100] 戻る',
};

const pad2 = (n: number) => String(n).padStart(2, ' ');
const stamp = () => {
  const d = new Date(),
    z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${z(d.getMonth() + 1)}/${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())} `;
};

export class SystemFlow {
  pendingBegin: string | null = null;
  calledWhenNormal = true;
  /** SAVEGAME/LOADGAME push the interrupted state here (Process.saveCurrentState) */
  prev: { st: string; begin: string | null; cwn: boolean }[] = [];
  done = false;
  systemResult: Value = 0;
  // CALLTRAIN
  isCTrain = false;
  coms: number[] = [];
  count = 0;
  // training loop
  comAble: number[] = [];
  lastCalledComable = -1;
  lastAddCom = -1;
  printComCount = 0;
  needCheck = true;
  needWaitToEventComEnd = false;
  doTrainSelectCom = -1;
  // FLOWINPUT (EE)
  flowinput = false;
  flowinputDef = 0;
  flowinputCanSkip = false;
  flowinputString = false;
  flowinputDefString = '';
  flowinputForceSkip = false;
  // save / load screens
  saveTarget = -1;
  page = 0;
  avail: boolean[] = [];
  /** set by the web player: running off the end of a script in the Normal state is an error, as in Emuera */
  strict = false;

  constructor(public vm: VM) {}

  get st(): string {
    return this.vm.system.state;
  }
  set st(s: string) {
    this.vm.system.state = s;
  }

  // ------------------------------------------------------------ plumbing
  private res(): Arr {
    return this.vm.global('RESULT');
  }
  private g(name: string): Arr {
    return this.vm.global(name);
  }
  private gnum(name: string, i = 0): number {
    return Number(this.g(name)[i] ?? 0);
  }
  private trainNames(): (string | undefined)[] {
    return this.vm.tables.tableFor('TRAIN')?.names ?? [];
  }
  private trainLen(): number {
    return this.vm.tables.tableFor('TRAIN')?.size ?? 1000;
  }

  setBegin(keyword: string) {
    const k = keyword.trim().toUpperCase();
    if (!(k in BEGIN_TARGETS)) throw new EmueraError(`BEGIN: "${keyword}" is not a valid argument`);
    this.pendingBegin = k;
  }

  /** ProcessState.Begin(): apply a recorded BEGIN now that the call stack is empty */
  private begin() {
    if (this.st === 'Shop_CallEventShop') return; // BEGIN from @EVENTSHOP is held back until after the autosave
    const k = this.pendingBegin;
    if (!k) return;
    if (k === 'SHOP') this.calledWhenNormal = this.st === 'Normal';
    this.st = BEGIN_TARGETS[k];
    this.pendingBegin = null;
  }

  /** CalledFunction + state.IntoFunction, run until the call stack is empty. Returns false when the function does not exist. */
  private *call(name: string, force: boolean, isEvent: boolean): Gen<boolean> {
    const vm = this.vm;
    let found: boolean;
    if (isEvent) found = yield* vm.callEvent(name);
    else {
      const f: FuncDef | undefined = vm.findFunc(name);
      found = !!f;
      if (f) yield* vm.callFunction(f, []);
    }
    if (!found) {
      if (force) throw new EmueraError(`function @${name} is not defined`);
      return false;
    }
    this.begin();
    return true;
  }

  // ----------------------------------------------------------- console helpers
  private flush() {
    const h = this.vm.host;
    if (h.pending?.()) h.newline();
  }
  private singleLine(t: string) {
    if (!t) return;
    this.flush();
    this.vm.host.print(t);
    this.vm.host.newline();
  }
  private tempLine(t: string) {
    const h = this.vm.host;
    if (h.reuseLastLine) h.reuseLastLine(t);
    else {
      h.clearLines(1);
      this.singleLine(t);
    }
  }
  private lastLine() {
    return this.vm.host.lastLine?.() ?? { temp: false, empty: false };
  }
  private resetStyle() {
    resetStyle(this.vm);
  }
  /** "last line was handled by the script -> keep the screen, otherwise replace the echoed input by a message" */
  private fixEmptyTemp() {
    const h = this.vm.host;
    if (this.lastLine().empty) {
      h.clearLines(2);
      this.tempLine(MSG.invalid);
    }
  }

  /** setWaitInput(): a system numeric (or EE string) input; sets systemResult */
  private *sysInput(): Gen {
    const vm = this.vm;
    if (this.flowinputForceSkip) {
      this.systemResult = this.flowinputDef;
      if (this.flowinputString) vm.setResult(this.flowinputDefString);
      return;
    }
    for (;;) {
      const r: string | null = yield {
        t: 'input',
        kind: this.flowinputString ? 'str' : 'int',
        def: this.flowinput ? (this.flowinputString ? this.flowinputDefString : String(this.flowinputDef)) : undefined,
      } as any;
      if (r === null) throw new StarvedError();
      let t = r.trim();
      if (this.flowinputString) {
        if (t === '' && this.flowinput) t = this.flowinputDefString;
        vm.echoInput(t);
        this.systemResult = this.flowinputDef;
        vm.setResult(t);
        return;
      }
      if (t === '' && this.flowinput) t = String(this.flowinputDef);
      if (!/^[+-]?\d+$/.test(t)) continue; // doInputToEmueraProgram: unparsable input is dropped silently
      vm.echoInput(t);
      this.systemResult = V.parseIntLoose(t);
      return;
    }
  }
  private *wait(): Gen {
    const r = yield { t: 'input', kind: 'wait' } as any;
    if (r === null) throw new StarvedError();
  }
  private sr(): number {
    return Number(this.systemResult);
  }

  // ------------------------------------------------------------- main loop
  *run(start: string): Gen {
    this.st = start;
    this.done = false;
    for (;;) {
      try {
        while (!this.done) yield* this.step();
        return;
      } catch (e) {
        if (e instanceof LoadSignal) {
          this.pendingBegin = null;
          continue;
        } // ClearFunctionList: everything on the call stack is gone
        throw e;
      }
    }
  }

  /** one runSystemProc() */
  *step(): Gen {
    switch (this.st) {
      case 'Title_Begin':
        return yield* this.beginTitle();
      case 'Openning':
        return yield* this.endOpenning();
      case 'First_Begin':
        return yield* this.beginFirst();
      case 'Openning_TitleLoadgame':
        return yield* this.beginTitle();

      case 'Train_Begin':
        return yield* this.beginTrain();
      case 'Train_CallEventTrain':
        return yield* this.endCallEventTrain();
      case 'Train_CallShowStatus':
        return yield* this.endCallShowStatus();
      case 'Train_CallComAbleXX':
        return yield* this.endCallComAbleXX();
      case 'Train_CallShowUserCom':
        return yield* this.endCallShowUserCom();
      case 'Train_WaitInput':
        return yield* this.trainWaitInput();
      case 'Train_CallEventCom':
        return yield* this.endEventCom();
      case 'Train_CallComXX':
        return yield* this.endCallComXX();
      case 'Train_CallSourceCheck':
        return yield* this.endCallSourceCheck();
      case 'Train_CallEventComEnd':
        return yield* this.endCallEventComEnd();
      case 'Train_DoTrain':
        return yield* this.doTrain();

      case 'AfterTrain_Begin':
        return yield* this.beginAfterTrain();
      case 'Ablup_Begin':
        return yield* this.beginAblup();
      case 'Ablup_CallShowJuel':
        return yield* this.endCallShowJuel();
      case 'Ablup_CallShowAblupSelect':
        return yield* this.endCallShowAblupSelect();
      case 'Ablup_WaitInput':
        return yield* this.ablupWaitInput();
      case 'Ablup_CallAblupXX':
        return yield* this.endCallAblupXX();
      case 'Turnend_Begin':
        return yield* this.beginTurnend();

      case 'Shop_Begin':
        return yield* this.beginShop();
      case 'Shop_CallEventShop':
        return yield* this.endCallEventShop();
      case 'Shop_CallShowShop':
        return yield* this.endCallShowShop();
      case 'Shop_WaitInput':
        return yield* this.shopWaitInput();
      case 'Shop_CallEventBuy':
        return yield* this.endCallEventBuy();

      case 'SaveGame_Begin':
      case 'LoadGame_Begin':
      case 'LoadGameOpenning_Begin':
        return yield* this.beginSaveLoadScreen();
      case 'SaveGame_WaitInput':
        return yield* this.saveGameWaitInput();
      case 'SaveGame_WaitInputOverwrite':
        return yield* this.saveGameWaitInputOverwrite();
      case 'SaveGame_CallSaveInfo':
        return yield* this.endCallSaveInfo();
      case 'LoadGame_WaitInput':
      case 'LoadGameOpenning_WaitInput':
        return yield* this.loadGameWaitInput();

      case 'AutoSave_CallSaveInfo':
        return yield* this.endAutoSaveCallSaveInfo();
      case 'AutoSave_CallUniqueAutosave':
        return yield* this.endAutoSave();

      case 'LoadData_DataLoaded':
        return yield* this.beginDataLoaded();
      case 'LoadData_CallSystemLoad':
        return yield* this.endSystemLoad();
      case 'LoadData_CallEventLoad':
        return yield* this.endAutoSave();

      case 'Normal':
        if (!this.strict) {
          this.done = true;
          return;
        }
        throw new EmueraError(MSG.scriptEnd);
      default:
        this.vm.note(`state:${this.st}`);
        this.done = true;
    }
  }

  // ------------------------------------------------------------------ title
  private *clearCommands(): Gen<boolean> {
    this.coms = [];
    this.count = 0;
    this.isCTrain = false;
    this.vm.system.skipDisp = true;
    return yield* this.call('CALLTRAINEND', false, false);
  }

  private *beginTitle(): Gen {
    if (this.isCTrain && (yield* this.clearCommands())) return;
    const vm = this.vm,
      h = vm.host;
    vm.system.skipDisp = false;
    this.resetStyle();
    this.prev.length = 0;
    if (vm.findFunc('SYSTEM_TITLE')) {
      this.st = 'Normal';
      yield* this.call('SYSTEM_TITLE', true, false);
      return;
    }
    // the built-in title screen
    const gb = vm.tables.gameBase,
      cfg = vm.config;
    h.drawLine(cfg.drawLine);
    h.newline();
    h.setAlign('center');
    this.singleLine(gb.get('TITLE') ?? '');
    const ver = Number(gb.get('VERSION') ?? 0);
    if (ver !== 0)
      this.singleLine(
        `${Math.trunc(ver / 1000)}.${ver % 10 !== 0 ? String(ver % 1000).padStart(3, '0') : String(Math.trunc((ver % 1000) / 10)).padStart(2, '0')}`,
      );
    this.singleLine(gb.get('AUTHOR') ?? '');
    this.singleLine(`(${gb.get('YEAR') ?? ''})`);
    h.newline();
    this.singleLine(gb.get('INFO') ?? '');
    h.setAlign('left');
    h.drawLine(cfg.drawLine);
    h.newline();
    this.singleLine('[0] ' + cfg.titleMenu0);
    this.singleLine('[1] ' + cfg.titleMenu1);
    yield* this.sysInput();
    this.st = 'Openning';
  }

  private *endOpenning(): Gen {
    const vm = this.vm,
      h = vm.host,
      r = this.sr();
    if (r === 0) {
      vm.resetData();
      addChara(vm, 0, 'csv');
      const dc = Number(vm.tables.gameBase.get('DEFAULTCHARA') ?? -1);
      if (dc > 0) addChara(vm, dc, 'csv');
      h.drawLine(vm.config.drawLine);
      h.newline();
      yield* this.beginFirst();
    } else if (r === 1) {
      if (vm.findFunc('TITLE_LOADGAME')) {
        this.st = 'Openning_TitleLoadgame';
        yield* this.call('TITLE_LOADGAME', true, false);
      } else this.openLoadScreen('LoadGameOpenning_Begin');
    } else {
      h.clearLines(1);
      this.tempLine(MSG.invalid);
      yield* this.sysInput();
      this.st = 'Openning';
    }
  }

  private *beginFirst(): Gen {
    this.st = 'Normal';
    if (this.isCTrain && (yield* this.clearCommands())) return;
    this.vm.system.skipDisp = false;
    yield* this.call('EVENTFIRST', true, true);
  }

  // ------------------------------------------------------------------ train
  private *beginTrain(): Gen {
    this.vm.updateInBeginTrain();
    this.st = 'Train_CallEventTrain';
    yield* this.call('EVENTTRAIN', false, true);
  }

  private *endCallEventTrain(): Gen {
    const vm = this.vm;
    const next = this.gnum('NEXTCOM');
    if (next >= 0) {
      this.st = 'Train_CallEventCom';
      this.g('SELECTCOM')[0] = next;
      this.g('NEXTCOM')[0] = 0; // eramaker quirk: 0, not -1
      yield* this.callEventCom();
      return;
    }
    if (this.isCTrain) vm.system.skipDisp = true;
    this.st = 'Train_CallShowStatus';
    yield* this.call('SHOW_STATUS', true, false);
  }

  private *endCallShowStatus(): Gen {
    this.st = 'Train_CallComAbleXX';
    this.lastCalledComable = -1;
    this.lastAddCom = -1;
    this.printComCount = 0;
    this.comAble = new Array(this.trainLen()).fill(-1);
    yield* this.endCallComAbleXX();
  }

  // getTrainComString: the command name goes through Translation.translate(.., "Train") ('puchi' only: trName returns the name itself when no _TR.csv was loaded)
  private comString(code: number, no: number): string {
    const t = this.vm.tables;
    return `${t.trName(t.trTableOf('TRAINNAME'), this.trainNames()[code])}[${String(no).padStart(3, ' ')}]`;
  }
  private printCom(code: number, no: number) {
    const h = this.vm.host;
    h.print(padTo(this.comString(code, no), this.vm.config.printCLength, 'right'));
    this.printComCount++;
    const per = this.vm.config.printCPerLine;
    if (per > 0 && this.printComCount % per === 0) this.flush();
  }

  private *endCallComAbleXX(): Gen {
    const vm = this.vm,
      names = this.trainNames(),
      len = this.trainLen();
    if (this.lastCalledComable >= 0 && names[this.lastCalledComable] != null) {
      this.lastAddCom++;
      if (!V.isZero(this.res()[0] as any)) {
        this.comAble[this.lastAddCom] = this.lastCalledComable;
        if (!this.isCTrain) this.printCom(this.lastCalledComable, this.lastAddCom);
      }
    }
    while (++this.lastCalledComable < len) {
      const n = this.lastCalledComable;
      if (names[n] == null) continue;
      if (!(yield* this.call(`COM_ABLE${n}`, false, false))) {
        this.lastAddCom++;
        if (vm.config.comAbleDefault === 0) continue;
        this.comAble[this.lastAddCom] = n;
        if (!this.isCTrain) this.printCom(n, this.lastAddCom);
        continue;
      }
      return;
    }
    this.st = 'Train_CallShowUserCom';
    this.flush();
    yield* this.call('SHOW_USERCOM', true, false);
  }

  private *endCallShowUserCom(): Gen {
    const vm = this.vm;
    vm.system.skipDisp = false;
    vm.updateAfterShowUsercom();
    if (!this.isCTrain) {
      yield* this.sysInput();
      this.st = 'Train_WaitInput';
    } else if (this.count < this.coms.length) {
      this.systemResult = this.coms[this.count];
      this.count++;
      yield* this.trainWaitInput();
    }
  }

  private *trainWaitInput(): Gen {
    const vm = this.vm,
      r = this.sr();
    let select = -1;
    if (!this.isCTrain) {
      if (r >= 0 && r < this.comAble.length) select = this.comAble[r];
    } else {
      for (const c of this.comAble) if (c === r) select = r;
      this.singleLine(MSG.executed(this.count, this.coms.length));
    }
    if (select >= 0) {
      this.g('SELECTCOM')[0] = select;
      yield* this.callEventCom();
    } else {
      if (this.isCTrain) this.singleLine(MSG.cantExecute);
      this.res()[0] = this.systemResult;
      this.st = 'Train_CallEventComEnd';
      yield* this.call('USERCOM', true, false);
    }
    void vm;
  }

  private *doTrain(): Gen {
    this.vm.updateAfterShowUsercom();
    this.g('SELECTCOM')[0] = this.doTrainSelectCom;
    yield* this.callEventCom();
  }

  private *callEventCom(): Gen {
    this.vm.updateAfterInputCom();
    this.st = 'Train_CallEventCom';
    yield* this.call('EVENTCOM', false, true);
  }

  private *endEventCom(): Gen {
    const sel = this.gnum('SELECTCOM');
    this.st = 'Train_CallComXX';
    yield* this.call(`COM${sel}`, true, false);
  }

  private *endCallComXX(): Gen {
    if (V.isZero(this.res()[0] as any)) {
      yield* this.endCallEventComEnd();
      return;
    }
    this.st = 'Train_CallSourceCheck';
    yield* this.call('SOURCE_CHECK', true, false);
  }

  private *endCallSourceCheck(): Gen {
    this.vm.updateAfterSourceCheck();
    this.st = 'Train_CallEventComEnd';
    this.needWaitToEventComEnd = true;
    yield* this.call('EVENTCOMEND', false, true);
  }

  private *endCallEventComEnd(): Gen {
    if (this.lastLine().temp && !this.isCTrain && this.needCheck) {
      this.fixEmptyTemp();
      yield* this.endCallShowUserCom();
      return;
    }
    if (this.isCTrain && this.count === this.coms.length) {
      this.isCTrain = false;
      this.vm.system.skipDisp = false;
      this.coms = [];
      this.count = 0;
      if (yield* this.call('CALLTRAINEND', false, false)) {
        this.needCheck = false;
        return;
      }
    }
    this.needCheck = true;
    if (this.needWaitToEventComEnd) yield* this.wait();
    this.needWaitToEventComEnd = false;
    yield* this.endCallEventTrain();
  }

  // ------------------------------------------------- after train / ablup / turn end
  private *beginAfterTrain(): Gen {
    if (this.isCTrain && (yield* this.clearCommands())) return;
    this.vm.system.skipDisp = false;
    this.st = 'Normal';
    yield* this.call('EVENTEND', true, true);
  }

  private *beginAblup(): Gen {
    if (this.isCTrain && (yield* this.clearCommands())) return;
    this.vm.system.skipDisp = false;
    this.st = 'Ablup_CallShowJuel';
    yield* this.call('SHOW_JUEL', true, false);
  }
  private *endCallShowJuel(): Gen {
    this.st = 'Ablup_CallShowAblupSelect';
    yield* this.call('SHOW_ABLUP_SELECT', true, false);
  }
  private *endCallShowAblupSelect(): Gen {
    yield* this.sysInput();
    this.st = 'Ablup_WaitInput';
  }
  private *ablupWaitInput(): Gen {
    const r = this.sr();
    if (r >= 0 && r < 100) {
      this.st = 'Ablup_CallAblupXX';
      if (!(yield* this.call(`ABLUP${r}`, false, false))) {
        this.vm.host.clearLines(1);
        this.tempLine(MSG.invalid);
        yield* this.endCallShowAblupSelect();
      }
    } else {
      this.res()[0] = this.systemResult;
      this.st = 'Ablup_CallAblupXX';
      yield* this.call('USERABLUP', true, false);
    }
  }
  private *endCallAblupXX(): Gen {
    if (this.lastLine().temp) {
      this.fixEmptyTemp();
      yield* this.endCallShowAblupSelect();
    } else yield* this.beginAblup();
  }

  private *beginTurnend(): Gen {
    if (this.isCTrain && (yield* this.clearCommands())) return;
    this.vm.system.skipDisp = false;
    this.st = 'Normal';
    yield* this.call('EVENTTURNEND', true, true);
  }

  // ------------------------------------------------------------------- shop
  private *beginShop(): Gen {
    if (this.isCTrain && (yield* this.clearCommands())) return;
    this.vm.system.skipDisp = false;
    this.st = 'Shop_CallEventShop';
    yield* this.call('EVENTSHOP', false, true);
  }

  private *endCallEventShop(): Gen {
    this.saveTarget = -1;
    if (this.vm.config.autoSave && this.calledWhenNormal) yield* this.beginAutoSave();
    else {
      this.st = 'AutoSave_Skipped';
      yield* this.endAutoSaveCallSaveInfo();
    }
  }

  private *beginAutoSave(): Gen {
    const vm = this.vm;
    if (vm.findFunc('SYSTEM_AUTOSAVE')) {
      this.st = 'AutoSave_CallUniqueAutosave';
      yield* this.call('SYSTEM_AUTOSAVE', true, false);
      return;
    }
    this.saveTarget = SAVE_AUTO;
    this.g('SAVEDATA_TEXT')[0] = stamp();
    this.st = 'AutoSave_CallSaveInfo';
    yield* this.call('SAVEINFO', false, false);
  }

  private *endAutoSaveCallSaveInfo(): Gen {
    if (this.saveTarget === SAVE_AUTO) {
      if (!saveSlot(this.vm, this.saveTarget, String(this.g('SAVEDATA_TEXT')[0] ?? ''))) {
        this.singleLine(MSG.autoSaveErr1);
        this.singleLine(MSG.autoSaveErr2);
        yield* this.wait();
      }
    }
    yield* this.endAutoSave();
  }

  private *endAutoSave(): Gen {
    if (this.pendingBegin) {
      this.begin();
      return;
    }
    this.st = 'Shop_CallShowShop';
    yield { t: 'delay', ms: 0, marker: 'shop' } as any; // snapshot-safe point: nothing below on the call stack
    yield* this.call('SHOW_SHOP', true, false);
  }

  private *endCallShowShop(): Gen {
    yield* this.sysInput();
    this.st = 'Shop_WaitInput';
  }

  private itemSales(no: number): boolean {
    const t = this.vm.tables.tableFor('ITEM');
    const sales = this.g('ITEMSALES');
    if (!t || no < 0 || no >= sales.length || no >= t.size) return false;
    return !V.isZero(sales[no] as any) && t.names[no] != null;
  }

  private *shopWaitInput(): Gen {
    const vm = this.vm,
      h = vm.host,
      r = this.sr();
    if (r >= 0 && r < vm.config.maxShopItem) {
      if (this.itemSales(r)) {
        const price = vm.tables.itemPrice[r] ?? 0;
        const money = this.g('MONEY');
        if (Number(money[0]) >= price) {
          money[0] = Number(money[0]) - price;
          const item = this.g('ITEM');
          item[r] = Number(item[r]) + 1;
          this.g('BOUGHT')[0] = r;
          this.st = 'Shop_CallEventBuy';
          yield* this.call('EVENTBUY', false, true);
          return;
        }
        h.clearLines(1);
        this.tempLine(MSG.noMoney);
      } else {
        h.clearLines(1);
        this.tempLine(MSG.outOfStock);
      }
      yield* this.endCallShowShop();
      return;
    }
    this.res()[0] = this.systemResult;
    this.st = 'Shop_CallEventBuy';
    yield* this.call('USERSHOP', true, false);
  }

  private *endCallEventBuy(): Gen {
    if (this.lastLine().temp) {
      this.fixEmptyTemp();
      yield* this.endCallShowShop();
    } else yield* this.endAutoSave();
  }

  // -------------------------------------------------------------- load data
  private *beginDataLoaded(): Gen {
    this.st = 'LoadData_CallSystemLoad';
    yield* this.call('SYSTEM_LOADEND', false, false);
  }
  private *endSystemLoad(): Gen {
    this.st = 'LoadData_CallEventLoad';
    if (!(yield* this.call('EVENTLOAD', false, true))) yield* this.endAutoSave();
  }

  // ----------------------------------------------------- save / load screens
  /** SAVEGAME / LOADGAME: run the picker as an interruption of the calling script */
  *saveLoad(isSave: boolean): Gen {
    if (!CAN_SAVE.has(this.st)) throw new EmueraError('SAVEGAME/LOADGAME cannot be used here');
    this.prev.push({ st: this.st, begin: this.pendingBegin, cwn: this.calledWhenNormal });
    const depth = this.prev.length;
    this.st = isSave ? 'SaveGame_Begin' : 'LoadGame_Begin';
    while (this.prev.length >= depth) yield* this.step();
  }
  private loadPrevState() {
    const p = this.prev.pop();
    if (!p) return;
    this.st = p.st;
    this.pendingBegin = p.begin;
    this.calledWhenNormal = p.cwn;
  }
  private openLoadScreen(state: 'LoadGameOpenning_Begin' | 'LoadGame_Begin') {
    this.st = state;
  }

  private slotCount(): number {
    return this.vm.config.saveDataNos;
  }

  private *beginSaveLoadScreen(): Gen {
    const h = this.vm.host,
      isSave = this.st === 'SaveGame_Begin';
    if (this.avail.length !== this.slotCount() + 1) this.avail = new Array(this.slotCount() + 1).fill(false);
    // the question is printed only when the screen is entered, not when it is redrawn on page change (printSaveDataText is shared)
    if (!this.redraw) this.singleLine(isSave ? MSG.saveQ : MSG.loadQ);
    this.redraw = false;
    const len = this.avail.length;
    for (let i = 0; i < this.page; i++) {
      this.flush();
      h.print(`[${pad2(i * 20)}] Display slots ${pad2(i * 20)}～${pad2(i * 20 + 19)}`);
      h.newline();
    }
    for (let i = 0; i < 20; i++) {
      const no = this.page * 20 + i;
      if (no === len - 1) break;
      this.avail[no] = false;
      this.flush();
      h.print(`[${pad2(no)}] `);
      const info = slotInfo(this.vm, no);
      h.print(info ?? '----');
      h.newline();
      if (info !== undefined) this.avail[no] = true;
    }
    for (let i = this.page; i < Math.trunc((len - 2) / 20); i++) {
      this.flush();
      h.print(`[${pad2((i + 1) * 20)}] Display slots ${pad2((i + 1) * 20)}～${pad2((i + 1) * 20 + 19)}`);
      h.newline();
    }
    this.avail[len - 1] = false;
    if (!isSave) {
      this.flush();
      h.print(`[${pad2(SAVE_AUTO)}] `);
      const info = slotInfo(this.vm, SAVE_AUTO);
      h.print(info ?? '----');
      h.newline();
      if (info !== undefined) this.avail[len - 1] = true;
    }
    this.singleLine(MSG.back);
    yield* this.sysInput();
    this.st = isSave
      ? 'SaveGame_WaitInput'
      : this.st === 'LoadGameOpenning_Begin'
        ? 'LoadGameOpenning_WaitInput'
        : 'LoadGame_WaitInput';
  }
  private redraw = false;

  private *saveGameWaitInput(): Gen {
    const h = this.vm.host,
      r = this.sr(),
      len = this.avail.length;
    if (r === 100) {
      this.loadPrevState();
      return;
    }
    if (Math.trunc(r / 20) !== this.page && r !== SAVE_AUTO && r >= 0 && r < len - 1) {
      this.page = Math.trunc(r / 20);
      this.st = 'SaveGame_Begin';
      this.redraw = true;
      return;
    }
    if (!(r >= 0 && r < len - 1)) {
      h.clearLines(1);
      this.tempLine(MSG.invalid);
      yield* this.sysInput(); // setWaitInput(): the state stays SaveGame_WaitInput
      return;
    }
    this.saveTarget = r;
    if (this.avail[r]) {
      this.singleLine(MSG.overwrite);
      this.flush();
      h.print(MSG.yes);
      h.print(MSG.no);
      h.newline();
      yield* this.sysInput();
      this.st = 'SaveGame_WaitInputOverwrite';
      return;
    }
    this.systemResult = 0;
    yield* this.saveGameWaitInputOverwrite();
  }

  private *saveGameWaitInputOverwrite(): Gen {
    const h = this.vm.host,
      r = this.sr();
    if (r === 1) {
      this.st = 'SaveGame_Begin';
      return;
    }
    if (r !== 0) {
      h.clearLines(1);
      this.tempLine(MSG.invalid);
      yield* this.sysInput();
      return;
    }
    this.g('SAVEDATA_TEXT')[0] = stamp();
    this.st = 'SaveGame_CallSaveInfo';
    yield* this.call('SAVEINFO', false, false);
  }

  private *endCallSaveInfo(): Gen {
    if (!saveSlot(this.vm, this.saveTarget, String(this.g('SAVEDATA_TEXT')[0] ?? ''))) {
      this.singleLine(MSG.saveErr);
      yield* this.wait();
    }
    this.loadPrevState();
  }

  private *loadGameWaitInput(): Gen {
    const h = this.vm.host,
      r = this.sr(),
      len = this.avail.length,
      opening = this.st === 'LoadGameOpenning_WaitInput';
    if (r === 100) {
      if (opening) {
        this.st = 'Title_Begin';
        return;
      }
      this.loadPrevState();
      return;
    }
    if (Math.trunc(r / 20) !== this.page && r !== SAVE_AUTO && r >= 0 && r < len - 1) {
      this.page = Math.trunc(r / 20);
      this.st = opening ? 'LoadGameOpenning_Begin' : 'LoadGame_Begin';
      this.redraw = true;
      return;
    }
    let available: boolean;
    if (r >= 0 && r < len - 1) available = this.avail[r];
    else if (r === SAVE_AUTO) available = this.avail[len - 1];
    else {
      h.clearLines(1);
      this.tempLine(MSG.invalid);
      yield* this.sysInput();
      return;
    }
    if (!available) {
      this.singleLine(String(r));
      this.singleLine(MSG.noData);
      this.st = opening ? 'LoadGameOpenning_Begin' : 'LoadGame_Begin';
      return;
    }
    loadSlot(this.vm, r);
    const nested = this.prev.length > 0;
    this.prev.pop(); // deletePrevState(): the interrupted script is abandoned
    this.st = 'LoadData_DataLoaded';
    if (nested) throw new LoadSignal();
  }

  /** LOADDATA command: load, drop the call stack, continue with SYSTEM_LOADEND / EVENTLOAD */
  loadFromScript(slot: number) {
    if (!slotExists(this.vm, slot)) throw new EmueraError('LOADDATA: save data is missing or corrupted');
    loadSlot(this.vm, slot);
    this.st = 'LoadData_DataLoaded';
    throw new LoadSignal();
  }

  // ----------------------------------------------------------------- CALLTRAIN
  setCommands(count: number) {
    const sc = this.g('SELECTCOM');
    if (count >= sc.length) throw new EmueraError('CALLTRAIN: the count exceeds the size of SELECTCOM');
    this.coms = [];
    for (let i = 0; i < count; i++) this.coms.push(Number(sc[i + 1]));
    this.isCTrain = true;
  }
  stopCallTrain(): void {
    if (this.isCTrain) {
      this.coms = [];
      this.count = 0;
      this.isCTrain = false;
      this.vm.system.skipDisp = true;
      this.pendingClear = true;
    }
  }
  /** STOPCALLTRAIN also runs @CALLTRAINEND when the stack empties; ClearCommands() starts it immediately in Emuera */
  pendingClear = false;
  doTrainCmd(train: number) {
    if (!CAN_DOTRAIN.has(this.st)) throw new EmueraError('DOTRAIN cannot be used here');
    this.coms = [];
    this.isCTrain = false;
    this.count = 0;
    if (train < 0) throw new EmueraError('DOTRAIN: argument must not be negative');
    if (train >= this.trainLen()) throw new EmueraError('DOTRAIN: argument is beyond the TRAINNAME array');
    this.doTrainSelectCom = train;
    this.st = 'Train_DoTrain';
  }
}

// ---------------------------------------------------------------------------------- commands
const BEGIN_CMD = (st: any, _fn: any, vm: VM) => (fr: any) => {
  const a = st.arg;
  vm.flow.setBegin(a.a === 'raw' ? a.text : '');
  resetStyle(vm);
  // state.Return(0): leave the current function; the switch happens when the outermost call returns
  fr.returned = true;
  fr.pc = fr.fn.body.length;
};
COMMANDS.BEGIN = BEGIN_CMD;
COMMANDS.FORCE_BEGIN = BEGIN_CMD;
COMMANDS.SAVEGAME = (_s, _f, vm) => () => vm.flow.saveLoad(true);
COMMANDS.LOADGAME = (_s, _f, vm) => () => vm.flow.saveLoad(false);
COMMANDS.CALLTRAIN = (st, fn, vm) => {
  const e = st.arg.a === 'exprs' ? st.arg.list[0] : undefined;
  if (!e) throw new EmueraError('CALLTRAIN: argument expected');
  const f = compile(e, fn, vm);
  return (fr) => {
    vm.flow.setCommands(toNum(f(fr)));
  };
};
COMMANDS.DOTRAIN = (st, fn, vm) => {
  const e = st.arg.a === 'exprs' ? st.arg.list[0] : undefined;
  if (!e) throw new EmueraError('DOTRAIN: argument expected');
  const f = compile(e, fn, vm);
  return (fr) => {
    vm.flow.doTrainCmd(toNum(f(fr)));
  };
};
COMMANDS.STOPCALLTRAIN = (_s, _f, vm) => () =>
  (function* (): Gen {
    const fl = vm.flow;
    if (!fl.isCTrain) return;
    fl.coms = [];
    fl.count = 0;
    fl.isCTrain = false;
    const f = vm.findFunc('CALLTRAINEND');
    if (f) yield* vm.callFunction(f, []); // Emuera pushes @CALLTRAINEND onto the call stack here
    vm.system.skipDisp = false;
  })();
COMMANDS.LOADDATA = (st, fn, vm) => {
  const e = st.arg.a === 'exprs' ? st.arg.list[0] : undefined;
  if (!e) throw new EmueraError('LOADDATA: argument expected');
  const f = compile(e, fn, vm);
  return (fr) => {
    const n = toNum(f(fr));
    if (n < 0) throw new EmueraError(`LOADDATA: argument must not be negative (${n})`);
    vm.flow.loadFromScript(n);
  };
};
COMMANDS.RESETDATA = (_s, _f, vm) => (fr: any) => {
  vm.resetData();
  resetStyle(vm);
  fr.local?.fill(0);
  fr.locals?.fill('');
};
