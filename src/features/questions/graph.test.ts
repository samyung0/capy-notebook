import { expect, it } from 'vitest';
import { validateGraphTerm } from './graph';

it('accepts arithmetic functions but not property access or statements', () => {
  expect(() => validateGraphTerm('sin(x) + 2.5*x^2')).not.toThrow();
  for (const term of [
    'x.constructor',
    'alert(x)',
    'x;while(1){}',
    'x=2',
    'x[0]',
    'Math.sin(x)',
  ])
    expect(() => validateGraphTerm(term)).toThrow();
});
