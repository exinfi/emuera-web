/** HtmlManager.Unescape: every '&' must start a complete reference "&name;" / "&#NN;" / "&#xHH;"; anything else is a script error in the original */
import { EmueraError } from '../engine/runtime/value';

export function unescapeHtml(str: string, profile: 'em-ee' | 'emuera-net' | 'puchi' = 'em-ee'): string {
  let found = str.indexOf('&');
  if (found < 0) return str;
  if (profile === 'emuera-net') return htmlDecode(str);
  let index = 0,
    out = '';
  while (index < str.length) {
    found = str.indexOf('&', index);
    if (found < 0) {
      out += str.slice(index);
      break;
    }
    if (found > index) out += str.slice(index, found);
    index = found;
    found = str.indexOf(';', index);
    if (found <= index + 1) {
      if (found < 0) throw new EmueraError("No ';' was found for the '&'");
      throw new EmueraError("'&' and ';' are adjacent");
    }
    const row = str.slice(index + 1, found);
    index = found + 1;
    let w = row.toLowerCase();
    switch (w) {
      case 'nbsp':
        out += ' ';
        break;
      case 'amp':
        out += '&';
        break;
      case 'gt':
        out += '>';
        break;
      case 'lt':
        out += '<';
        break;
      case 'quot':
        out += '"';
        break;
      case 'apos':
        out += "'";
        break;
      default: {
        if (w[0] !== '#') throw new EmueraError(`"&${row};" is not a valid character reference`);
        let base = 10;
        if (w.length > 1 && w[1] === 'x') {
          base = 16;
          w = w.slice(2);
        } else w = w.slice(1);
        // Convert.ToInt32(text, base): optional sign, digits of the base only (a 0x prefix is allowed for base 16)
        const m = (base === 16 ? /^(?:0x)?([0-9a-f]+)$/ : /^([0-9]+)$/).exec(w.trim());
        if (!m) throw new EmueraError(`"&${row};" is not a valid character reference`);
        const code = parseInt(m[1], base);
        if (!(code >= 0 && code <= 0xffff))
          throw new EmueraError(`"&${row};" is outside the Unicode range (surrogate pairs cannot be used)`);
        out += String.fromCharCode(code);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Emuera.NET (profile 'emuera-net'): HtmlManager.Unescape is `HttpUtility.HtmlDecode(str)`, which is forgiving where EM+EE is strict: a '&' that does not
// start a known entity is kept as it is (no script error), names are case-sensitive and come from the HTML 4 table (plus apos), `&nbsp;` is U+00A0, and a
// numeric reference may be any Unicode scalar value. The algorithm follows .NET's WebUtility.HtmlDecode: after a '&', look for the next ';' or '&';
// only when a ';' comes first is the text between them tried as an entity.
const ENT: Record<string, number> = {
  AElig: 198,
  Aacute: 193,
  Acirc: 194,
  Agrave: 192,
  Alpha: 913,
  Aring: 197,
  Atilde: 195,
  Auml: 196,
  Beta: 914,
  Ccedil: 199,
  Chi: 935,
  Dagger: 8225,
  Delta: 916,
  ETH: 208,
  Eacute: 201,
  Ecirc: 202,
  Egrave: 200,
  Epsilon: 917,
  Eta: 919,
  Euml: 203,
  Gamma: 915,
  Iacute: 205,
  Icirc: 206,
  Igrave: 204,
  Iota: 921,
  Iuml: 207,
  Kappa: 922,
  Lambda: 923,
  Mu: 924,
  Ntilde: 209,
  Nu: 925,
  OElig: 338,
  Oacute: 211,
  Ocirc: 212,
  Ograve: 210,
  Omega: 937,
  Omicron: 927,
  Oslash: 216,
  Otilde: 213,
  Ouml: 214,
  Phi: 934,
  Pi: 928,
  Prime: 8243,
  Psi: 936,
  Rho: 929,
  Scaron: 352,
  Sigma: 931,
  THORN: 222,
  Tau: 932,
  Theta: 920,
  Uacute: 218,
  Ucirc: 219,
  Ugrave: 217,
  Upsilon: 933,
  Uuml: 220,
  Xi: 926,
  Yacute: 221,
  Yuml: 376,
  Zeta: 918,
  aacute: 225,
  acirc: 226,
  acute: 180,
  aelig: 230,
  agrave: 224,
  alefsym: 8501,
  alpha: 945,
  amp: 38,
  and: 8743,
  ang: 8736,
  apos: 39,
  aring: 229,
  asymp: 8776,
  atilde: 227,
  auml: 228,
  bdquo: 8222,
  beta: 946,
  brvbar: 166,
  bull: 8226,
  cap: 8745,
  ccedil: 231,
  cedil: 184,
  cent: 162,
  chi: 967,
  circ: 710,
  clubs: 9827,
  cong: 8773,
  copy: 169,
  crarr: 8629,
  cup: 8746,
  curren: 164,
  dArr: 8659,
  dagger: 8224,
  darr: 8595,
  deg: 176,
  delta: 948,
  diams: 9830,
  divide: 247,
  eacute: 233,
  ecirc: 234,
  egrave: 232,
  empty: 8709,
  emsp: 8195,
  ensp: 8194,
  epsilon: 949,
  equiv: 8801,
  eta: 951,
  eth: 240,
  euml: 235,
  euro: 8364,
  exist: 8707,
  fnof: 402,
  forall: 8704,
  frac12: 189,
  frac14: 188,
  frac34: 190,
  frasl: 8260,
  gamma: 947,
  ge: 8805,
  gt: 62,
  hArr: 8660,
  harr: 8596,
  hearts: 9829,
  hellip: 8230,
  iacute: 237,
  icirc: 238,
  iexcl: 161,
  igrave: 236,
  image: 8465,
  infin: 8734,
  int: 8747,
  iota: 953,
  iquest: 191,
  isin: 8712,
  iuml: 239,
  kappa: 954,
  lArr: 8656,
  lambda: 955,
  lang: 9001,
  laquo: 171,
  larr: 8592,
  lceil: 8968,
  ldquo: 8220,
  le: 8804,
  lfloor: 8970,
  lowast: 8727,
  loz: 9674,
  lrm: 8206,
  lsaquo: 8249,
  lsquo: 8216,
  lt: 60,
  macr: 175,
  mdash: 8212,
  micro: 181,
  middot: 183,
  minus: 8722,
  mu: 956,
  nabla: 8711,
  nbsp: 160,
  ndash: 8211,
  ne: 8800,
  ni: 8715,
  not: 172,
  notin: 8713,
  nsub: 8836,
  ntilde: 241,
  nu: 957,
  oacute: 243,
  ocirc: 244,
  oelig: 339,
  ograve: 242,
  oline: 8254,
  omega: 969,
  omicron: 959,
  oplus: 8853,
  or: 8744,
  ordf: 170,
  ordm: 186,
  oslash: 248,
  otilde: 245,
  otimes: 8855,
  ouml: 246,
  para: 182,
  part: 8706,
  permil: 8240,
  perp: 8869,
  phi: 966,
  pi: 960,
  piv: 982,
  plusmn: 177,
  pound: 163,
  prime: 8242,
  prod: 8719,
  prop: 8733,
  psi: 968,
  quot: 34,
  rArr: 8658,
  radic: 8730,
  rang: 9002,
  raquo: 187,
  rarr: 8594,
  rceil: 8969,
  rdquo: 8221,
  real: 8476,
  reg: 174,
  rfloor: 8971,
  rho: 961,
  rlm: 8207,
  rsaquo: 8250,
  rsquo: 8217,
  sbquo: 8218,
  scaron: 353,
  sdot: 8901,
  sect: 167,
  shy: 173,
  sigma: 963,
  sigmaf: 962,
  sim: 8764,
  spades: 9824,
  sub: 8834,
  sube: 8838,
  sum: 8721,
  sup: 8835,
  sup1: 185,
  sup2: 178,
  sup3: 179,
  supe: 8839,
  szlig: 223,
  tau: 964,
  there4: 8756,
  theta: 952,
  thetasym: 977,
  thinsp: 8201,
  thorn: 254,
  tilde: 732,
  times: 215,
  trade: 8482,
  uArr: 8657,
  uacute: 250,
  uarr: 8593,
  ucirc: 251,
  ugrave: 249,
  uml: 168,
  upsih: 978,
  upsilon: 965,
  uuml: 252,
  weierp: 8472,
  xi: 958,
  yacute: 253,
  yen: 165,
  yuml: 255,
  zeta: 950,
  zwj: 8205,
  zwnj: 8204,
};

export function htmlDecode(str: string): string {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '&') {
      let j = i + 1;
      while (j < str.length && str[j] !== ';' && str[j] !== '&') j++;
      if (j > i + 1 && str[j] === ';') {
        const ent = str.slice(i + 1, j);
        let rep: string | null = null;
        if (ent.length > 1 && ent[0] === '#') {
          const hex = ent[1] === 'x' || ent[1] === 'X';
          const digits = hex ? ent.slice(2) : ent.slice(1);
          if (hex ? /^[0-9a-fA-F]+$/.test(digits) : /^[0-9]+$/.test(digits)) {
            const v = parseInt(digits, hex ? 16 : 10);
            if (v > 0 && v <= 0x10ffff && !(v >= 0xd800 && v <= 0xdfff)) rep = String.fromCodePoint(v);
          }
        } else if (Object.prototype.hasOwnProperty.call(ENT, ent)) rep = String.fromCharCode(ENT[ent]);
        if (rep !== null) {
          out += rep;
          i = j;
          continue;
        }
      }
    }
    out += ch;
  }
  return out;
}
