/**
 * PRINT command family, the PRINT_* data
 * printers, UPCHECK/CUPCHECK, PUTFORM, FORCEKANA and the K (kana conversion) / D (ignore SETCOLOR) suffixes. At the end: PRINT_IMG, PRINT_RECT, PRINT_SPACE, DRAWLINEFORM, REUSELASTLINE, BAR, BARL and CUSTOMDRAWLINE.
 * Name grammar: PRINT[SINGLE][V|S|FORMS|FORM][LC|C][K][D][N][L|W]
 */
import { COMMANDS, Factory, StarvedError } from './commands';
import { con } from './consolestate';
import { asStr, compile, compileForm, Frame, padTo, toNum } from './eval';
import { FUNCS } from './funcs';
import * as V from './value';
import { EmueraError, Value } from './value';
import type { Gen, VM } from './vm';
import { createBar } from './strfuncs';
import { exprs } from './cmdargs';

const toText = (v: Value) => (typeof v === 'string' ? v : String(v));

// ------------------------------------------------------------------ kana ----
const HALF = 'ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ';
const FULL =
  'ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン';
const DAKU: Record<string, string> = {};
'カガキギクグケゲコゴサザシジスズセゼソゾタダチヂツヅテデトドハバヒビフブヘベホボウヴ'.match(/../g)!.forEach((p) => {
  DAKU[p[0]] = p[1];
});
const HANDAKU: Record<string, string> = { ハ: 'パ', ヒ: 'ピ', フ: 'プ', ヘ: 'ペ', ホ: 'ポ' };
function toWide(s: string): string {
  let o = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i],
      cp = c.codePointAt(0)!;
    if (cp === 0x20) {
      o += '　';
      continue;
    }
    if (cp >= 0x21 && cp <= 0x7e) {
      o += String.fromCharCode(cp + 0xfee0);
      continue;
    }
    if (cp === 0xff61) {
      o += '。';
      continue;
    }
    if (cp === 0xff62) {
      o += '「';
      continue;
    }
    if (cp === 0xff63) {
      o += '」';
      continue;
    }
    if (cp === 0xff64) {
      o += '、';
      continue;
    }
    if (cp === 0xff65) {
      o += '・';
      continue;
    }
    const h = HALF.indexOf(c);
    if (h >= 0) {
      let f = FULL[h];
      const nx = s[i + 1];
      if (nx === 'ﾞ' && DAKU[f]) {
        f = DAKU[f];
        i++;
      } else if (nx === 'ﾟ' && HANDAKU[f]) {
        f = HANDAKU[f];
        i++;
      }
      o += f;
      continue;
    }
    if (c === 'ﾞ') {
      o += '゛';
      continue;
    }
    if (c === 'ﾟ') {
      o += '゜';
      continue;
    }
    o += c;
  }
  return o;
}
const toKatakana = (s: string) => s.replace(/[ぁ-ゖゝゞ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
const toHiragana = (s: string) => s.replace(/[ァ-ヶヽヾ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
/** FORCEKANA(flag): 0 off, 1 katakana, 2 hiragana, 3 hiragana + full-width (ExpressionMediator.ForceKana) */
export function convertKana(vm: VM, s: string): string {
  const f = vm.kana;
  if (!f) return s;
  if (f === 1) return toKatakana(s);
  return toHiragana(f === 3 ? toWide(s) : s);
}
COMMANDS.FORCEKANA = (st, fn, vm) => {
  const f = compile(exprs(st)[0], fn, vm);
  return (fr) => {
    const v = toNum(f(fr));
    vm.kana = v === 0 ? 0 : v === 1 ? 1 : v === 2 ? 2 : v === 3 ? 3 : v > 3 ? 2 : 0;
  };
};

// -------------------------------------------------------------- primitives ---
/** EmueraConsole.Print: a line feed inside the text ends the display line */
export function printText(vm: VM, s: string) {
  if (!s) return;
  const i = s.indexOf('\n');
  if (i < 0) {
    vm.host.print(s);
    return;
  }
  vm.host.print(s.slice(0, i));
  vm.host.newline();
  if (i < s.length - 1) printText(vm, s.slice(i + 1));
}
/** print with the user's SETCOLOR ignored (D functions) */
export function withPlain(vm: VM, plain: boolean, f: () => void) {
  const c = con(vm);
  if (plain && c.color !== vm.config.textColor) {
    vm.host.setColor(vm.config.textColor);
    try {
      f();
    } finally {
      vm.host.setColor(c.color);
    }
  } else f();
}
/** PrintC: padded to PRINTC_LENGTH display columns; nothing for an empty string */
const printC = (vm: VM, s: string, right: boolean) => {
  if (s) printText(vm, padTo(s, vm.system.printCLength, right ? 'right' : 'left'));
};
function* waitAnyKey(): Gen {
  const r = yield { t: 'input', kind: 'wait' };
  if (r === null) throw new StarvedError();
}

interface PrintDesc {
  single: boolean;
  kind: 'raw' | 'V' | 'S' | 'FORM' | 'FORMS';
  col: 'C' | 'LC' | null;
  k: boolean;
  d: boolean;
  n: boolean;
  l: boolean;
  w: boolean;
}
export function decodePrint(name: string): PrintDesc | null {
  let s = name.slice(5);
  const take = (p: string) => (s.startsWith(p) ? ((s = s.slice(p.length)), true) : false);
  const single = take('SINGLE');
  let kind: PrintDesc['kind'] = 'raw';
  if (take('V')) kind = 'V';
  else if (take('S')) kind = 'S';
  else if (take('FORMS')) kind = 'FORMS';
  else if (take('FORM')) kind = 'FORM';
  let col: PrintDesc['col'] = null;
  if (take('LC')) col = 'LC';
  else if (take('C')) col = 'C';
  const k = take('K'),
    d = take('D'),
    n = take('N');
  let l = false,
    w = false;
  if (take('L')) l = true;
  else if (take('W')) w = true;
  if (s !== '') return null;
  return { single, kind, col, k, d, n, l, w };
}

function printFactory(name: string): Factory {
  const d = decodePrint(name)!;
  return (st, fn, vm) => {
    const a = st.arg;
    let text: (fr: Frame) => string;
    switch (d.kind) {
      case 'raw': {
        const t = a.a === 'raw' ? a.text : '';
        text = () => t;
        break;
      }
      case 'FORM': {
        text = a.a === 'form' ? compileForm(a.parts, fn, vm) : () => '';
        break;
      }
      case 'V': {
        const l = exprs(st).map((e) => compile(e, fn, vm));
        text = (fr) => l.map((f) => toText(f(fr))).join('');
        break;
      }
      case 'S': {
        const l = exprs(st).map((e) => compile(e, fn, vm));
        text = (fr) => (l.length ? asStr(l[0](fr), name) : '');
        break;
      }
      case 'FORMS': {
        const l = exprs(st).map((e) => compile(e, fn, vm));
        text = (fr) => (l.length ? vm.formString(asStr(l[0](fr), name), fn)(fr) : '');
        break;
      }
    }
    const wait = d.w || d.n;
    return (fr): void | Gen => {
      if (vm.system.skipDisp) return;
      let t = text(fr);
      if (d.k) t = convertKana(vm, t);
      if (d.col) {
        withPlain(vm, d.d, () => printC(vm, t, d.col === 'C'));
        return;
      }
      if (d.single) {
        // PrintSingleLine: the text becomes a display line of its own
        if (!t) return;
        withPlain(vm, d.d, () => {
          if (vm.host.pending?.()) vm.host.newline();
          printText(vm, t);
          vm.host.newline();
        });
        return;
      }
      withPlain(vm, d.d, () => printText(vm, t));
      if (d.l || wait) vm.host.newline();
      if (wait) return waitAnyKey();
    };
  };
}
// every legal combination
for (const base of ['PRINT', 'PRINTSINGLE']) {
  for (const kind of ['', 'V', 'S', 'FORM', 'FORMS'])
    for (const col of base === 'PRINT' ? ['', 'C', 'LC'] : [''])
      for (const k of ['', 'K'])
        for (const dd of ['', 'D'])
          for (const e of col ? [''] : ['', 'N', 'L', 'W']) {
            const n = base + kind + col + k + dd + e;
            if (decodePrint(n)) COMMANDS[n] = printFactory(n);
          }
}
COMMANDS.PRINTPLAIN = printFactory('PRINT');
COMMANDS.PRINTPLAINFORM = printFactory('PRINTFORM');

// PRINTBUTTON[C|LC](text, value)
for (const [n, col] of [
  ['PRINTBUTTON', null],
  ['PRINTBUTTONC', 'C'],
  ['PRINTBUTTONLC', 'LC'],
] as const) {
  COMMANDS[n] = (st, fn, vm) => {
    const l = exprs(st).map((e) => compile(e, fn, vm));
    return (fr) => {
      if (vm.system.skipDisp) return;
      let t = toText(l[0](fr));
      if (!t) return;
      if (col) t = padTo(t, vm.system.printCLength, col === 'C' ? 'right' : 'left');
      vm.host.button(t, toText(l[1](fr)));
    };
  };
}

// --------------------------------------------------------- PUTFORM (SAVEINFO) --
COMMANDS.PUTFORM = (st, fn, vm) => {
  const f = st.arg.a === 'form' ? compileForm(st.arg.parts, fn, vm) : () => '';
  return (fr) => {
    const s = vm.global('SAVEDATA_TEXT');
    const t = f(fr);
    s[0] = s[0] ? String(s[0]) + t : t;
  };
};

// --------------------------------------------------------------- PRINT_xxx --
const names = (vm: VM, v: string) => vm.tables.tableFor(v)?.names ?? [];
function charaCheck(vm: VM, target: number) {
  if (target < 0 || target >= vm.store.charas.length)
    throw new EmueraError('Attempted to reference a registered character that does not exist');
}
function dataString(vm: VM, target: number, what: 'ABL' | 'TALENT' | 'MARK' | 'EXP'): string {
  charaCheck(vm, target);
  const arr = vm.store.charaArr(target, vm.store.meta(what)!);
  const nm = names(vm, what + 'NAME');
  let b = '';
  for (let i = 0; i < arr.length; i++) {
    if (i >= nm.length) break;
    if (V.isZero(arr[i] as any)) continue;
    if (!nm[i]) continue;
    if (what === 'TALENT') b += `[${nm[i]}]`;
    else if (what === 'EXP') b += `${nm[i]}${arr[i]} `;
    else b += `${nm[i]}LV${arr[i]} `;
  }
  return b;
}
for (const w of ['ABL', 'TALENT', 'MARK', 'EXP'] as const) {
  COMMANDS['PRINT_' + w] = (st, fn, vm) => {
    const f = compile(exprs(st)[0], fn, vm);
    return (fr) => {
      if (vm.system.skipDisp) return;
      const t = toNum(f(fr));
      printText(vm, dataString(vm, t, w));
      vm.host.newline();
    };
  };
}
/** GetCharacterParamString: "name[=====.....]   value", null when the parameter has neither value nor name */
function paramString(vm: VM, target: number, code: number): string | null {
  charaCheck(vm, target);
  const param = Number(vm.store.charaArr(target, vm.store.meta('PALAM')!)[code]);
  const lv = vm.global('PALAMLV').map(Number);
  const name = names(vm, 'PALAMNAME')[code] ?? '';
  if (param === 0 && !name) return null;
  let c = '-',
    border = lv[1];
  if (param >= border) {
    c = '=';
    border = lv[2];
  }
  if (param >= border) {
    c = '>';
    border = lv[3];
  }
  if (param >= border) {
    c = '*';
    border = lv[4];
  }
  let bar: string;
  if (border <= 0 || border <= param) bar = c.repeat(10);
  else if (param <= 0) bar = '.'.repeat(10);
  else {
    const n = Number(BigInt.asIntN(32, BigInt.asIntN(64, BigInt(param) * 10n) / BigInt(border)));
    bar = c.repeat(Math.max(0, n)) + '.'.repeat(Math.max(0, 10 - n));
  }
  return `${name}[${bar}]${String(param).padStart(6)}`;
}
COMMANDS.PRINT_PALAM = (st, fn, vm) => {
  const f = compile(exprs(st)[0], fn, vm);
  return (fr) => {
    if (vm.system.skipDisp) return;
    const target = toNum(f(fr));
    let count = 0;
    for (let i = 0; i < 100; i++) {
      const s = paramString(vm, target, i);
      if (s !== null) {
        printC(vm, s, true);
        count++;
        if (vm.config.printCPerLine > 0 && count % vm.config.printCPerLine === 0 && vm.host.pending?.())
          vm.host.newline();
      }
    }
    if (vm.host.pending?.()) vm.host.newline();
  };
};
COMMANDS.PRINT_ITEM = (_st, _fn, vm) => () => {
  if (vm.system.skipDisp) return;
  const item = vm.global('ITEM'),
    nm = names(vm, 'ITEMNAME');
  const len = Math.min(item.length, vm.global('ITEMNAME').length);
  let count = 0,
    b = '所持アイテム：';
  for (let i = 0; i < len; i++) {
    if (V.isZero(item[i] as any)) continue;
    count++;
    b += `${nm[i] ?? ''}(${item[i]}) `;
  }
  if (!count) b += 'なし';
  printText(vm, b);
  vm.host.newline();
};
COMMANDS.PRINT_SHOPITEM = (_st, _fn, vm) => () => {
  if (vm.system.skipDisp) return;
  const sales = vm.global('ITEMSALES'),
    nm = names(vm, 'ITEMNAME'),
    price = vm.global('ITEMPRICE');
  const len = Math.min(sales.length, vm.global('ITEMNAME').length, price.length);
  let count = 0;
  for (let i = 0; i < len; i++) {
    if (V.isZero(sales[i] as any) || nm[i] == null) continue;
    const p = price[i];
    const s = vm.config.moneyFirst
      ? `[${i}] ${nm[i]}(${vm.config.moneyLabel}${p})`
      : `[${i}] ${nm[i]}(${p}${vm.config.moneyLabel})`;
    printC(vm, s, false);
    count++;
    if (vm.config.printCPerLine > 0 && count % vm.config.printCPerLine === 0 && vm.host.pending?.()) vm.host.newline();
  }
  if (vm.host.pending?.()) vm.host.newline();
};

// -------------------------------------------------------- UPCHECK / CUPCHECK --
function upcheck(vm: VM, target: number, up: Value[], down: Value[]) {
  const pm = vm.store.meta('PALAM')!;
  if (target < 0 || target >= vm.store.charas.length) return;
  const param = vm.store.charaArr(target, pm);
  const nm = names(vm, 'PALAMNAME');
  const len = Math.min(param.length, up.length, down.length);
  const skip = vm.system.skipDisp;
  for (let i = 0; i < len; i++) {
    const u = V.norm(BigInt(up[i] as any)),
      dn = V.norm(BigInt(down[i] as any));
    if (u <= 0 && dn <= 0) continue;
    let b = '';
    if (!skip) {
      b = `${nm[i] ?? ''} ${param[i]}`;
      if (u > 0) b += `+${u}`;
      if (dn > 0) b += `-${dn}`;
    }
    param[i] = V.norm(BigInt.asIntN(64, BigInt(param[i] as any) + BigInt(u) - BigInt(dn)));
    if (!skip) {
      b += `=${param[i]}`;
      printText(vm, b);
      vm.host.newline();
    }
  }
}
COMMANDS.UPCHECK = (_st, _fn, vm) => () => {
  const up = vm.global('UP'),
    down = vm.global('DOWN');
  upcheck(vm, Number(vm.global('TARGET')[0]), up, down);
  up.fill(0);
  down.fill(0);
};
COMMANDS.CUPCHECK = (st, fn, vm) => {
  const f = compile(exprs(st)[0], fn, vm);
  return (fr) => {
    const t = toNum(f(fr));
    if (t < 0 || t >= vm.store.charas.length) return;
    const up = vm.store.charaArr(t, vm.store.meta('CUP')!),
      down = vm.store.charaArr(t, vm.store.meta('CDOWN')!);
    upcheck(vm, t, up, down);
    up.fill(0);
    down.fill(0);
  };
};
void FUNCS;

// ---- PRINT_IMG / PRINT_RECT / PRINT_SPACE, line drawing, BAR
COMMANDS.PRINT_IMG = (st, fn, vm) => {
  const l = exprs(st).map((e) => compile(e, fn, vm));
  return (fr) => {
    if (vm.system.skipDisp) return;
    const v = l.map((f) => f(fr));
    const name = asStr(v[0] ?? '');
    const nums: number[] = [];
    let srcb: string | undefined;
    for (const x of v.slice(1)) {
      if (typeof x === 'string') {
        if (srcb === undefined && x !== '') srcb = x;
      } else nums.push(Number(x));
    }
    // PRINT_IMG name[, srcb[, srcm]][, width[, height[, ypos]]]  (percent of font size)
    if (vm.host.image) vm.host.image(name, nums[1], nums[0], { ypos: nums[2], srcb });
    else vm.host.print('');
  };
};
// PRINT_RECT w  /  PRINT_RECT x, y, w, h  (EM+EE: SP_PRINT_SHAPE, 1 or 4 values; the original takes any count). Values are percent of the font size.
COMMANDS.PRINT_RECT = (st, fn, vm) => {
  const l = exprs(st).map((e) => compile(e, fn, vm));
  return (fr) => {
    if (vm.system.skipDisp) return;
    if (l.length !== 1 && l.length !== 4)
      throw new EmueraError('PRINT_RECT: the number of arguments is wrong (1 or 4)');
    vm.host.rect?.(
      l.map((f) => toNum(f(fr))),
      l.map(() => false),
    );
  };
};
COMMANDS.PRINT_SPACE = (st, fn, vm) => {
  const f = compile(exprs(st)[0], fn, vm);
  return (fr) => {
    if (!vm.system.skipDisp) vm.host.print(' '.repeat(Math.max(0, Math.trunc(toNum(f(fr)) / 100))));
  };
};

// ------------------------------------------------------ line / array extras --
COMMANDS.REUSELASTLINE = (st, fn, vm) => {
  const f =
    st.arg.a === 'form'
      ? compileForm(st.arg.parts, fn, vm)
      : st.arg.a === 'raw'
        ? (
            (t: string) => () =>
              t
          )(st.arg.text)
        : () => '';
  return (fr) => {
    const t = f(fr);
    if (vm.host.reuseLastLine) vm.host.reuseLastLine(t);
    else {
      vm.host.clearLines(1);
      vm.host.print(t);
      vm.host.newline();
    }
  };
};
COMMANDS.DRAWLINEFORM = (st, fn, vm) => {
  const f = st.arg.a === 'form' ? compileForm(st.arg.parts, fn, vm) : () => '-';
  return (fr) => {
    if (!vm.system.skipDisp) vm.host.drawLine(f(fr));
  };
};

// ------------------------------------------------------------ BAR / lines --
const barCmd =
  (nl: boolean): Factory =>
  (st, fn, vm) => {
    const l = exprs(st).map((e) => compile(e, fn, vm));
    return (fr) => {
      if (vm.system.skipDisp) return;
      vm.host.print(createBar(vm, l[0](fr) as number, l[1](fr) as number, l[2](fr) as number));
      if (nl) vm.host.newline();
    };
  };
COMMANDS.BAR = barCmd(false);
COMMANDS.BARL = barCmd(true);
COMMANDS.CUSTOMDRAWLINE = (st, _fn, vm) => {
  const t = st.arg.a === 'raw' ? st.arg.text.trim() : '';
  if (!t) throw new EmueraError('CUSTOMDRAWLINE: missing argument');
  return () => {
    if (!vm.system.skipDisp) vm.host.drawLine(t);
  };
};
