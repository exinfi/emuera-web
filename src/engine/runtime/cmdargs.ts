/** Argument helpers shared by the statement runners. */
import type { Expr } from '../compiler/ast';
import { EmueraError } from './value';

export const exprs = (st: { arg: any }): Expr[] => (st.arg.a === 'exprs' ? st.arg.list : []);
export const varExpr = (e: Expr | undefined, what: string) => {
  if (!e || e.k !== 'var') throw new EmueraError(`${what}: variable expected`);
  return e;
};
