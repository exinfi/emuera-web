/**
 * Console state (colours, font style, alignment, redraw) and the commands/functions that read it back
 * (SETCOLOR..ALIGNMENT, GETCOLOR..COLOR_FROMRGB, PRINTCPERLINE...).
 */
import { COMMANDS } from './commands';
import { compile, toNum } from './eval';
import { def } from './funcs';
import { EmueraError } from './value';
import type { VM } from './vm';
import { exprs } from './cmdargs';

export interface ConState {
  color: number;
  bg: number;
  style: number;
  font: string;
  align: 'left' | 'center' | 'right';
  redraw: boolean;
  init: boolean;
}
export const newConState = (): ConState => ({
  color: 0,
  bg: 0,
  style: 0,
  font: '',
  align: 'left',
  redraw: true,
  init: false,
});
export function con(vm: VM): ConState {
  const c = vm.con;
  if (!c.init) {
    c.init = true;
    c.color = vm.config.textColor;
    c.bg = vm.config.backColor;
    c.font = vm.config.fontName;
  }
  return c;
}

/** EmueraConsole.ResetStyle (BEGIN, RESETDATA and the title screen): default colour, regular font, default font name, left alignment; the background is kept */
export function resetStyle(vm: VM) {
  const c = con(vm),
    cfg = vm.config;
  c.color = cfg.textColor;
  c.style = 0;
  c.font = cfg.fontName;
  c.align = 'left';
  vm.host.setColor(cfg.textColor);
  vm.host.setStyle(0);
  vm.host.setFont('');
  vm.host.setAlign('left'); // '' = the default font (an explicit name is a deliberate segment font, see WebRenderer.setFont)
}

/** System.Drawing.KnownColor web colours (Color.FromName is case-insensitive) */
const WEB =
  'AliceBlue F0F8FF AntiqueWhite FAEBD7 Aqua 00FFFF Aquamarine 7FFFD4 Azure F0FFFF Beige F5F5DC Bisque FFE4C4 Black 000000 BlanchedAlmond FFEBCD Blue 0000FF BlueViolet 8A2BE2 Brown A52A2A BurlyWood DEB887 CadetBlue 5F9EA0 Chartreuse 7FFF00 Chocolate D2691E Coral FF7F50 CornflowerBlue 6495ED Cornsilk FFF8DC Crimson DC143C Cyan 00FFFF DarkBlue 00008B DarkCyan 008B8B DarkGoldenrod B8860B DarkGray A9A9A9 DarkGreen 006400 DarkKhaki BDB76B DarkMagenta 8B008B DarkOliveGreen 556B2F DarkOrange FF8C00 DarkOrchid 9932CC DarkRed 8B0000 DarkSalmon E9967A DarkSeaGreen 8FBC8B DarkSlateBlue 483D8B DarkSlateGray 2F4F4F DarkTurquoise 00CED1 DarkViolet 9400D3 DeepPink FF1493 DeepSkyBlue 00BFFF DimGray 696969 DodgerBlue 1E90FF Firebrick B22222 FloralWhite FFFAF0 ForestGreen 228B22 Fuchsia FF00FF Gainsboro DCDCDC GhostWhite F8F8FF Gold FFD700 Goldenrod DAA520 Gray 808080 Green 008000 GreenYellow ADFF2F Honeydew F0FFF0 HotPink FF69B4 IndianRed CD5C5C Indigo 4B0082 Ivory FFFFF0 Khaki F0E68C Lavender E6E6FA LavenderBlush FFF0F5 LawnGreen 7CFC00 LemonChiffon FFFACD LightBlue ADD8E6 LightCoral F08080 LightCyan E0FFFF LightGoldenrodYellow FAFAD2 LightGray D3D3D3 LightGreen 90EE90 LightPink FFB6C1 LightSalmon FFA07A LightSeaGreen 20B2AA LightSkyBlue 87CEFA LightSlateGray 778899 LightSteelBlue B0C4DE LightYellow FFFFE0 Lime 00FF00 LimeGreen 32CD32 Linen FAF0E6 Magenta FF00FF Maroon 800000 MediumAquamarine 66CDAA MediumBlue 0000CD MediumOrchid BA55D3 MediumPurple 9370DB MediumSeaGreen 3CB371 MediumSlateBlue 7B68EE MediumSpringGreen 00FA9A MediumTurquoise 48D1CC MediumVioletRed C71585 MidnightBlue 191970 MintCream F5FFFA MistyRose FFE4E1 Moccasin FFE4B5 NavajoWhite FFDEAD Navy 000080 OldLace FDF5E6 Olive 808000 OliveDrab 6B8E23 Orange FFA500 OrangeRed FF4500 Orchid DA70D6 PaleGoldenrod EEE8AA PaleGreen 98FB98 PaleTurquoise AFEEEE PaleVioletRed DB7093 PapayaWhip FFEFD5 PeachPuff FFDAB9 Peru CD853F Pink FFC0CB Plum DDA0DD PowderBlue B0E0E6 Purple 800080 RebeccaPurple 663399 Red FF0000 RosyBrown BC8F8F RoyalBlue 4169E1 SaddleBrown 8B4513 Salmon FA8072 SandyBrown F4A460 SeaGreen 2E8B57 SeaShell FFF5EE Sienna A0522D Silver C0C0C0 SkyBlue 87CEEB SlateBlue 6A5ACD SlateGray 708090 Snow FFFAFA SpringGreen 00FF7F SteelBlue 4682B4 Tan D2B48C Teal 008080 Thistle D8BFD8 Tomato FF6347 Turquoise 40E0D0 Violet EE82EE Wheat F5DEB3 White FFFFFF WhiteSmoke F5F5F5 Yellow FFFF00 YellowGreen 9ACD32'.split(
    ' ',
  );
const COLORS = new Map<string, number>();
for (let i = 0; i < WEB.length; i += 2) COLORS.set(WEB[i].toLowerCase(), parseInt(WEB[i + 1], 16));
/** rgb of a known colour name, undefined when unknown; "transparent" is an error as in the original */
export function colorByName(name: string): number | undefined {
  const k = name.toLowerCase();
  if (k === 'transparent') throw new EmueraError('Transparent cannot be specified as a color');
  return COLORS.get(k);
}

const rgbArgs = (vals: number[]): number => {
  if (vals.length <= 1) return vals[0] & 0xffffff;
  const [r, g, b] = vals;
  if (r < 0 || g < 0 || b < 0) throw new EmueraError('SETCOLOR was given an argument less than 0');
  if (r > 255 || g > 255 || b > 255) throw new EmueraError('SETCOLOR was given an argument greater than 255');
  return (r << 16) | (g << 8) | b;
};
const colorCmd = (bg: boolean) => (st: any, fn: any, vm: VM) => {
  const l = exprs(st).map((e) => compile(e, fn, vm));
  return (fr: any) => {
    const c = rgbArgs(l.map((f) => toNum(f(fr))));
    if (bg) {
      con(vm).bg = c;
      vm.host.setBgColor(c);
    } else {
      con(vm).color = c;
      vm.host.setColor(c);
    }
  };
};
COMMANDS.SETCOLOR = colorCmd(false);
COMMANDS.SETBGCOLOR = colorCmd(true);
const byNameCmd = (bg: boolean) => (st: any, _fn: any, vm: VM) => {
  const name = st.arg.a === 'raw' ? st.arg.text.trim() : '';
  return () => {
    const c = colorByName(name);
    if (c === undefined) throw new EmueraError(`Specified color name "${name}" is invalid`);
    if (bg) {
      con(vm).bg = c;
      vm.host.setBgColor(c);
    } else {
      con(vm).color = c;
      vm.host.setColor(c);
    }
  };
};
COMMANDS.SETCOLORBYNAME = byNameCmd(false);
COMMANDS.SETBGCOLORBYNAME = byNameCmd(true);
COMMANDS.RESETCOLOR = (_s, _f, vm) => () => {
  const c = vm.config.textColor;
  con(vm).color = c;
  vm.host.setColor(c);
};
COMMANDS.RESETBGCOLOR = (_s, _f, vm) => () => {
  const c = vm.config.backColor;
  con(vm).bg = c;
  vm.host.setBgColor(c);
};

const setStyle = (vm: VM, bits: number) => {
  con(vm).style = bits;
  vm.host.setStyle(bits);
};
COMMANDS.FONTBOLD = (_s, _f, vm) => () => setStyle(vm, con(vm).style | 1);
COMMANDS.FONTITALIC = (_s, _f, vm) => () => setStyle(vm, con(vm).style | 2);
COMMANDS.FONTREGULAR = (_s, _f, vm) => () => setStyle(vm, 0);
COMMANDS.FONTSTYLE = (st, fn, vm) => {
  const e = exprs(st)[0];
  const f = e ? compile(e, fn, vm) : null;
  return (fr) => setStyle(vm, (f ? toNum(f(fr)) : 0) & 15);
};
COMMANDS.SETFONT = (st, fn, vm) => {
  const e = exprs(st)[0];
  const raw = st.arg.a === 'raw' ? st.arg.text.trim() : null;
  const f = e ? compile(e, fn, vm) : null;
  return (fr) => {
    const n = raw ?? (f ? String(f(fr)) : '');
    con(vm).font = n;
    vm.host.setFont(n);
  };
};
COMMANDS.ALIGNMENT = (st, _fn, vm) => {
  const w = st.arg.a === 'raw' ? st.arg.text.trim() : '';
  const u = w.toUpperCase();
  return () => {
    if (u !== 'LEFT' && u !== 'CENTER' && u !== 'RIGHT') throw new EmueraError(`ALIGNMENT keyword "${w}" is illegal`);
    const a = u === 'CENTER' ? 'center' : u === 'RIGHT' ? 'right' : 'left';
    con(vm).align = a;
    vm.host.setAlign(a);
  };
};
COMMANDS.REDRAW = (st, fn, vm) => {
  const f = compile(exprs(st)[0], fn, vm);
  return (fr) => {
    const i = toNum(f(fr));
    con(vm).redraw = (i & 1) !== 0;
  };
};

// ---------------------------------------------------------------- functions --
def('GETCOLOR', (vm) => con(vm).color);
def('GETDEFCOLOR', (vm) => vm.config.textColor);
def('GETBGCOLOR', (vm) => con(vm).bg);
def('GETDEFBGCOLOR', (vm) => vm.config.backColor);
def('GETFOCUSCOLOR', (vm) => vm.config.focusColor);
def('GETFONT', (vm) => con(vm).font);
def('GETSTYLE', (vm) => con(vm).style & 15);
def('CURRENTALIGN', (vm) => con(vm).align.toUpperCase());
def('CURRENTREDRAW', (vm) => (con(vm).redraw ? 1 : 0));
def('COLOR_FROMNAME', (_vm, a) => {
  const c = colorByName(String(a[0]));
  return c === undefined ? -1 : c;
});
def('COLOR_FROMRGB', (_vm, a) => {
  const v = a.map((x) => toNum(x));
  v.forEach((x, i) => {
    if (x < 0 || x > 255) throw new EmueraError(`COLOR_FROMRGB: The ${i + 1} argument(${x}) is out of 0-255 range`);
  });
  return (v[0] << 16) + (v[1] << 8) + v[2];
});
def('PRINTCPERLINE', (vm) => vm.config.printCPerLine);
def('PRINTCLENGTH', (vm) => vm.config.printCLength);
def('SAVENOS', (vm) => vm.config.saveDataNos);
