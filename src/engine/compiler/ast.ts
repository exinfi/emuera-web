/** AST for the Emuera ERB compiler. Pure data, no behaviour. */

export type Pos = { file: string; line: number };

export type Align = 'left' | 'right' | 'center' | null;

export type FormPart =
  | { t: 'lit'; s: string }
  /** `{expr[,width[,align]]}` (int) or `%expr[,width[,align]]%` (string) */
  | { t: 'int' | 'str'; e: Expr; width?: Expr; align?: Align }
  /** `\@ cond ? a # b \@` */
  | { t: 'yenat'; cond: Expr; a: FormPart[]; b: FormPart[] | null };

export type Expr =
  | { k: 'int'; v: number | bigint }
  | { k: 'str'; v: string }
  /** decimal literal; only valid as the 2nd argument of TIMES */
  | { k: 'real'; v: number }
  | { k: 'form'; parts: FormPart[] }
  /** variable reference, or a bare name (CSV constant) when idx is empty */
  | { k: 'var'; name: string; idx: Expr[] }
  | { k: 'call'; name: string; args: Expr[] }
  | { k: 'un'; op: '+' | '-' | '!' | '~'; e: Expr }
  | { k: 'bin'; op: string; l: Expr; r: Expr }
  | { k: 'tern'; c: Expr; a: Expr; b: Expr }
  | { k: 'incdec'; op: '++' | '--'; prefix: boolean; target: Expr };

export class ParseError extends Error {
  constructor(
    msg: string,
    public col = -1,
  ) {
    super(msg);
  }
}
