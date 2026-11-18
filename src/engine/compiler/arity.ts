/** Argument-count rules of the built-in functions (FunctionMethod.CheckArgumentTypeEx): null when the call is acceptable, else the original's message. */
import type { Expr } from './ast';
import { ARITY } from './arity-table';

const isHole = (a: Expr) => a.k === 'var' && a.name === '__EMPTY__';

export function arityError(name: string, args: Expr[]): string | null {
  const forms = ARITY[name.toUpperCase()];
  if (!forms) return null;
  const n = args.length;
  let why = '';
  for (const [min, max, omit, dv] of forms) {
    if (n < min) {
      why ||= `${name}: Required ${min} arguments`;
      continue;
    }
    if (max >= 0 && n > max) {
      why ||=
        max === 0
          ? `${name}: Not required arguments`
          : omit < 0
            ? `${name}: Required ${max} arguments but passed ${n}`
            : `${name}: Too many arguments`;
      continue;
    }
    // an omitted argument is only allowed from OmitStart on (and not where DisallowVoid); a form without OmitStart takes holes (the original then reads null) but the plain fixed-type form (argumentTypeArray) rejects them
    let bad = '';
    for (let i = 0; i < n; i++)
      if (isHole(args[i]) && (omit === -2 || (omit > -1 && (i < omit || dv?.includes(i))))) {
        bad = `${name}: The ${i + 1} argument cannot be omitted`;
        break;
      }
    if (!bad) return null;
    why ||= bad;
  }
  return why || null;
}

import { STMT_ARITY } from './stmt-arity-table';
/**
 * ArgumentBuilder.checkArgumentType for statements. `error` makes the line an error line (the original throws when it is executed);
 * `warn` is the level-1 "too many arguments" case, where the extra arguments are dropped.
 */
export function stmtArityError(name: string, argsIn: Expr[]): { error?: string; warn?: string } | null {
  const r = STMT_ARITY[name.toUpperCase()];
  if (!r) return null;
  // ReduceArguments adds nothing for a comma at the very end (`VARSET X,`): drop our trailing placeholder
  const args = argsIn.length && isHole(argsIn[argsIn.length - 1]) ? argsIn.slice(0, -1) : argsIn;
  const [min, max] = r;
  const n = args.length;
  if (n < min) return { error: `${name} instruction: Not enough arguments` };
  for (let i = 0; i < Math.min(n, max); i++)
    if (isHole(args[i]) && !(name.toUpperCase() === 'FOR' && i === 1))
      return { error: `${name} instruction: Can not recognize the ${i + 1} argument` };
  if (n > max) return { warn: `${name} instruction: Too many arguments` };
  return null;
}
