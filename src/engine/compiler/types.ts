/** Compiler data types: statements and their arguments, variable and function declarations. */
import type { Expr, FormPart, Pos } from './ast';

export type CaseCond = { c: 'eq'; e: Expr } | { c: 'range'; lo: Expr; hi: Expr } | { c: 'is'; op: string; e: Expr };

export type Arg =
  | { a: 'none' }
  /** raw text to end of line (PRINT, BEGIN, DATA, ...) */
  | { a: 'raw'; text: string }
  | { a: 'form'; parts: FormPart[] }
  | { a: 'exprs'; list: Expr[] }
  /** INPUTS / ONEINPUTS: a form-string default (up to the first comma), then integer expressions (mouse, canskip) */
  | { a: 'inputs'; def: FormPart[] | null; rest: Expr[] }
  /** CALL/JUMP/GOTO/TRY*, CALLF, CALLFORM, FUNC */
  | { a: 'call'; name: string | FormPart[]; sub: Expr[]; args: Expr[] }
  | { a: 'case'; conds: CaseCond[] }
  /** assignment: A = x / A += x / A '= s / A++ */
  | { a: 'set'; target: Expr; op: string; rhs: Expr[] | FormPart[] | null; form: boolean };

export interface Stmt {
  pos: Pos;
  cmd: string;
  arg: Arg;
  /** matching end / loop head / end-of-block (set by link()) */
  jump?: number;
  /** next branch in an IF/SELECTCASE chain, or CATCH/ENDCATCH for TRYC* */
  alt?: number;
}

export interface VarDecl {
  name: string;
  isStr: boolean;
  dims: number[];
  isConst: boolean;
  isRef: boolean;
  isStatic: boolean;
  isGlobal: boolean;
  isSave: boolean;
  isChara: boolean;
  init?: (number | bigint | string)[];
  /** function-local #DIM whose initializer is not a load-time constant (e.g. `STRLENS(GETLINESTR("="))`): evaluated when the array is first created in a call */
  initExprs?: Expr[];
  /** declared ahead of its line by the VARI/VARS pre-pass: the line itself (or an earlier `#DIM`) takes its place */
  pre?: boolean;
  /** compiled form of initExprs, filled lazily by the evaluator */
  initFns?: ((fr: any) => any)[];
}

export interface Param {
  target: Expr;
  def?: Expr;
}

export interface FuncDef {
  name: string;
  pos: Pos;
  /** #FUNCTION / #FUNCTIONS: expression-function return type */
  method: 'int' | 'str' | null;
  event: boolean;
  single: boolean;
  pri: boolean;
  later: boolean;
  only: boolean;
  localSize: number;
  localsSize: number;
  params: Param[];
  vars: Map<string, VarDecl>;
  body: Stmt[];
  /** $label -> body index */
  labels: Map<string, number>;
}

export interface Diagnostic {
  file: string;
  line: number;
  msg: string;
  level: 'error' | 'warn';
}

export interface Program {
  funcs: Map<string, FuncDef[]>;
  globals: Map<string, VarDecl>;
  diagnostics: Diagnostic[];
  stats: { files: number; funcs: number; stmts: number };
  /** #DEFINE macro names in definition order (ISDEFINED, ENUMMACRO*) */
  macros?: string[];
  names?: { resolved: number; unresolved: number };
}
