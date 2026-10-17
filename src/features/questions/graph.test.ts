import { expect, it } from 'vitest';
import { axisNumber, tickStep, validateGraphTerm, wrapLabel } from './graph';

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

it('wraps labels at word breaks, splitting words wider than a line', () => {
  // 10px per character: 20 characters fit the 200px line.
  const measure = (line: string) => line.length * 10;
  expect(wrapLabel('Surface area : volume ratio (per µm)', measure)).toEqual([
    'Surface area :',
    'volume ratio (per',
    'µm)',
  ]);
  expect(
    wrapLabel('表面積與體積之比隨細胞邊長增加而迅速下降並趨近於零', measure)
  ).toEqual(['表面積與體積之比隨細胞邊長增加而迅速下降', '並趨近於零']);
  expect(wrapLabel('short', measure)).toEqual(['short']);
});

it('numbers axes like GeoGebra', () => {
  // 100px per number rounded down to 1, 2 or 5 × 10ⁿ.
  expect(tickStep(77)).toBe(1);
  expect(tickStep(30)).toBe(2);
  expect(tickStep(0.15)).toBe(500);
  expect(tickStep(4e7)).toBe(2e-6);
  expect(axisNumber(2010, 5)).toBe('2010');
  expect(axisNumber(-0.25, 0.05)).toBe('–0.25');
  expect(axisNumber(5e8, 5e8)).toBe('5E8');
  expect(axisNumber(-1.5e-6, 5e-7)).toBe('–1.5E-6');
  expect(axisNumber(0, 2)).toBe('');
});
