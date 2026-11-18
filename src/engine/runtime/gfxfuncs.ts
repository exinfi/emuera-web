/** G* / SPRITE* / CBG* commands and functions over vm.gfx. Usable as statements (result in RESULT) and in expressions. */
import { asInt, asStr, compile } from './eval';
import { EmueraError } from './value';
import { def, defRaw, I, refOf, S } from './funcs';
import type { VM } from './vm';

const n = (v: unknown) => Number(I(v as any));
const g = (vm: VM) => vm.gfx;

def('GCREATE', (vm, a) => g(vm).create(n(a[0]), n(a[1]), n(a[2])));
def('GCREATEFROMFILE', (vm, a) => {
  const r = g(vm).createFromFile(n(a[0]), S(a[1]));
  if (!r) vm.missedFile('GCREATEFROMFILE', S(a[1]));
  return r;
});
def('GDISPOSE', (vm, a) => g(vm).dispose(n(a[0])));
def('GCREATED', (vm, a) => (g(vm).surfaces.has(n(a[0])) ? 1 : 0));
def('GWIDTH', (vm, a) => g(vm).surfaces.get(n(a[0]))?.w ?? 0);
def('GHEIGHT', (vm, a) => g(vm).surfaces.get(n(a[0]))?.h ?? 0);
/** the 5x5 ColorMatrix argument of GDRAWG (11th) and GDRAWSPRITE (7th): a 2D array element `M:a:b` is the top-left cell, a 3D one `M:i:a:b` too; ReadColormatrix divides by 256 */
const matrixArg = (name: string, e: Parameters<typeof refOf>[0], fn: Parameters<typeof refOf>[1], vm: VM) => {
  const ref = refOf(e, fn, vm);
  return (fr: Parameters<typeof ref.locate>[0]): number[] => {
    const { arr, off } = ref.locate(fr),
      dims = ref.dimsOf(fr);
    if (dims.length < 2) throw new EmueraError(`${name}: the colour matrix must be a 2D or 3D array`);
    const stride = dims[dims.length - 1],
      col = off % stride;
    if (col + 5 > stride || off + 4 * stride + 5 > arr.length)
      throw new EmueraError(
        `${name}: the colour matrix element (${Math.floor(off / stride)}, ${col}) is out of range or leaves less than 5x5`,
      );
    const out: number[] = [];
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) out.push(Number(arr[off + x * stride + y]) / 256);
    return out;
  };
};
defRaw('GDRAWG', (vm, args, fn) => {
  if (args.length < 10 || args.length > 11) throw new EmueraError('GDRAWG takes 10 or 11 arguments');
  const v = args.slice(0, 10).map((x) => compile(x, fn, vm));
  const m = args[10] ? matrixArg('GDRAWG', args[10], fn, vm) : null;
  return (fr) => {
    const a = v.map((f) => n(f(fr)));
    return g(vm).drawG(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9], m ? m(fr) : undefined);
  };
});
def('GDRAWGWITHMASK', (vm, a) => g(vm).drawGWithMask(n(a[0]), n(a[1]), n(a[2]), n(a[3]), n(a[4])));
defRaw('GDRAWSPRITE', (vm, args, fn) => {
  const f = args.slice(0, 6).map((x) => (x ? compile(x, fn, vm) : null));
  const m = args[6] ? matrixArg('GDRAWSPRITE', args[6], fn, vm) : null;
  return (fr) => {
    const a = f.map((x) => (x ? x(fr) : undefined));
    return g(vm).drawSprite(
      n(a[0]),
      S(a[1]),
      a[2] === undefined ? 0 : n(a[2]),
      a[3] === undefined ? 0 : n(a[3]),
      a[4] === undefined ? undefined : n(a[4]),
      a[5] === undefined ? undefined : n(a[5]),
      m ? m(fr) : undefined,
    );
  };
});
def('GFILLRECTANGLE', (vm, a) => g(vm).fillRect(n(a[0]), n(a[1]), n(a[2]), n(a[3]), n(a[4])));
def('GDRAWLINE', (vm, a) => g(vm).drawLine(n(a[0]), n(a[1]), n(a[2]), n(a[3]), n(a[4])));
def('GDRAWTEXT', (vm, a) =>
  g(vm).drawText(n(a[0]), S(a[1]), a[2] === undefined ? 0 : n(a[2]), a[3] === undefined ? 0 : n(a[3])),
);
def('GCLEAR', (vm, a) => g(vm).clear(n(a[0]), a[1] === undefined ? 0 : n(a[1])));
def('GSETBRUSH', (vm, a) => {
  const s = g(vm).get(n(a[0]));
  if (!s) return 0;
  s.brush = n(a[1]) >>> 0;
  return 1;
});
def('GGETBRUSH', (vm, a) => g(vm).get(n(a[0]))?.brush ?? 0);
def('GSETPEN', (vm, a) => {
  const s = g(vm).get(n(a[0]));
  if (!s) return 0;
  s.pen = n(a[1]) >>> 0;
  s.penW = a[2] === undefined ? 1 : n(a[2]);
  return 1;
});
def('GGETPEN', (vm, a) => g(vm).get(n(a[0]))?.pen ?? 0);
def('GGETPENWIDTH', (vm, a) => g(vm).get(n(a[0]))?.penW ?? 0);
def('GSETFONT', (vm, a) => {
  const s = g(vm).get(n(a[0]));
  if (!s) return 0;
  s.font = S(a[1]);
  s.fontSize = n(a[2]);
  s.fontStyle = a[3] === undefined ? 0 : n(a[3]);
  return 1;
});
def('GGETFONTSIZE', (vm, a) => g(vm).get(n(a[0]))?.fontSize ?? 0);
def('GGETFONT', (vm, a) => g(vm).get(n(a[0]))?.font ?? '');
def('GGETCOLOR', (vm, a) => g(vm).getColor(n(a[0]), n(a[1]), n(a[2])));
def('GSETCOLOR', (vm, a) => g(vm).setColor(n(a[0]), n(a[1]), n(a[2]), n(a[3])));
def('GGETTEXTSIZE', (vm, a) => {
  const t = g(vm).textSize(S(a[0]), S(a[1]), n(a[2]), a[3] === undefined ? 0 : n(a[3]));
  vm.global('RESULT')[1] = t.h;
  return t.w;
});
def('GSAVE', () => 0);
def('GLOAD', () => 0);

def('SPRITECREATE', (vm, a) =>
  g(vm).spriteCreate(
    S(a[0]),
    n(a[1]),
    a[2] === undefined ? undefined : n(a[2]),
    a[3] === undefined ? undefined : n(a[3]),
    a[4] === undefined ? undefined : n(a[4]),
    a[5] === undefined ? undefined : n(a[5]),
  ),
);
def('SPRITEANIMECREATE', (vm, a) => g(vm).animeCreate(S(a[0]), n(a[1]), n(a[2])));
def('SPRITEANIMEADDFRAME', (vm, a) =>
  g(vm).animeAddFrame(S(a[0]), n(a[1]), n(a[2]), n(a[3]), n(a[4]), n(a[5]), n(a[6]), n(a[7]), n(a[8])),
);
def('SPRITEDISPOSE', (vm, a) => g(vm).spriteDispose(S(a[0])));
def('SPRITEDISPOSEALL', (vm, a) => g(vm).spriteDisposeAll(a[0] !== undefined && n(a[0]) !== 0));
// SpriteStateMethod: a missing sprite, or one that is not created (disposed, or its graphic is gone), answers 0
def('SPRITECREATED', (vm, a) => (g(vm).liveSprite(S(a[0])) ? 1 : 0));
def('SPRITEWIDTH', (vm, a) => (g(vm).liveSprite(S(a[0])) ? (g(vm).spriteSize(S(a[0]))?.w ?? 0) : 0));
def('SPRITEHEIGHT', (vm, a) => (g(vm).liveSprite(S(a[0])) ? (g(vm).spriteSize(S(a[0]))?.h ?? 0) : 0));
def('SPRITEPOSX', (vm, a) => g(vm).liveSprite(S(a[0]))?.px ?? 0);
def('SPRITEPOSY', (vm, a) => g(vm).liveSprite(S(a[0]))?.py ?? 0);
def('SPRITEMOVE', (vm, a) => g(vm).spritePos(S(a[0]), n(a[1]), n(a[2]), true));
def('SPRITESETPOS', (vm, a) => g(vm).spritePos(S(a[0]), n(a[1]), n(a[2]), false));
def('GDASHSTYLE', (vm, a) => g(vm).setDash(n(a[0]), n(a[1]), n(a[2])));
def('GDRAWGWITHROTATE', (vm, a) =>
  g(vm).drawGWithRotate(
    n(a[0]),
    n(a[1]),
    n(a[2]),
    a[3] === undefined ? undefined : n(a[3]),
    a[4] === undefined ? undefined : n(a[4]),
  ),
);
def('GGETFONTSTYLE', (vm, a) => (g(vm).get(n(a[0]))?.fontStyle ?? 0) & 15);
// GROTATE is commented out of the original function table, so there it is an unknown function
def('GROTATE', () => {
  throw new Error('GROTATE is disabled in Emuera EM+EE (unknown function)');
});
def('SPRITEGETCOLOR', (vm, a) => g(vm).spriteGetColor(S(a[0]), n(a[1]), n(a[2])));

def('CBGSETG', (vm, a) => g(vm).cbgSet('g', n(a[0]), n(a[1]), n(a[2]), n(a[3])));
def('CBGSETSPRITE', (vm, a) => g(vm).cbgSet('sprite', S(a[0]), n(a[1]), n(a[2]), n(a[3])));
def('CBGCLEAR', (vm) => g(vm).cbgClear());
def('CBGREMOVERANGE', (vm, a) => g(vm).cbgRemoveRange(n(a[0]), n(a[1])));
def('CBGCLEARBUTTON', (vm) => g(vm).cbgClearButton());
def('CBGSETBUTTONSPRITE', (vm, a) =>
  g(vm).cbgSetButton(n(a[0]), S(a[1]), S(a[2]), n(a[3]), n(a[4]), n(a[5]), a[6] === undefined ? undefined : S(a[6])),
);
def('CBGSETBMAPG', (vm, a) => g(vm).cbgSetButtonMap(n(a[0])));
def('CBGREMOVEBMAP', (vm) => {
  g(vm).cbgMapG = -1;
  return 1;
});
void asInt;
void asStr;
