import { expect, it } from 'vitest';
import { readExpression } from '@/features/questions/graphSyntax';
import captured from './jessiecode-values.json';

/* Function values against JSXGraph's JessieCode, captured before JSXGraph
 * was removed (plan step 1): each typed row's term at each x, read as the
 * plain text the row reader also takes. */

const decode = (value: number | string) =>
  value === 'NaN'
    ? Number.NaN
    : value === 'Infinity'
      ? Number.POSITIVE_INFINITY
      : value === '-Infinity'
        ? Number.NEGATIVE_INFINITY
        : Number(value);

const same = (a: number, b: number) =>
  Object.is(a, b) ||
  (Number.isNaN(a) && Number.isNaN(b)) ||
  Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a));

/** Where our reader and JessieCode differ, which Epo accepted (2026-11-17):
 * ours keeps these values. [term, x, JessieCode, ours]. */
const KNOWN: [string, number, number, number][] = [
  // JessieCode's log refuses a base of 0 or 1; ours divides by its log.
  ['log(8,x)', 0, Number.NaN, -0],
  ['log(8,x)', 1, Number.NaN, Number.POSITIVE_INFINITY],
  // JessieCode's power gives 0 for 0 to a negative power; ours Infinity.
  ['x^(-2)', 0, 0, Number.POSITIVE_INFINITY],
  ['x^(-1)/2', 0, 0, Number.POSITIVE_INFINITY],
];

/** Rows written as the reader takes them now: a power past one digit braced,
 * as LaTeX reads `x^0.5` as x⁰·0.5, and JessieCode's natural `log` as `ln`,
 * `log` being base 10 as in Desmos (Epo 2026-11-18). */
const WRITTEN: Partial<Record<string, string>> = {
  'log(x)': 'ln(x)',
  'x^0.5': 'x^{0.5}',
  'x^1.5': 'x^{1.5}',
};

it('evaluates every captured row as JessieCode did, apart from the listed cases', () => {
  const differences: [string, number, number, number][] = [];
  for (const { term, values } of captured.rows) {
    const read = readExpression(WRITTEN[term] ?? term);
    if (read.kind !== 'function') throw new Error(term);
    const fn = read.at;
    captured.xs.forEach((x, i) => {
      const old = decode(values[i]);
      const ours = fn(x);
      if (!same(old, ours)) differences.push([term, x, old, ours]);
    });
  }
  expect(differences).toEqual(KNOWN);
});

it('covers every allowed function and the operator cases', () => {
  const terms = captured.rows.map((row) => row.term).join(' ');
  for (const name of [
    'sin',
    'cos',
    'tan',
    'asin',
    'acos',
    'atan',
    'sqrt',
    'abs',
    'exp',
    'log',
    'ln',
    'floor',
    'ceil',
    'pow',
    'min',
    'max',
  ])
    expect(terms).toContain(`${name}(`);
  for (const term of [
    '-x^2',
    '2^(3^2)',
    '2*x',
    'x*(x+1)',
    '2*sin(x)',
    'pi',
    'e',
  ])
    expect(captured.rows.map((row) => row.term)).toContain(term);
});
