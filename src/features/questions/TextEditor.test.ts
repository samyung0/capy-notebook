import { expect, it } from 'vitest';
import { gapIds, mathTextToValue, valueToMathText } from './mathTextValue';

it('retains display equations, inline equations and escaped dollars when edited', () => {
  const source = 'Cost \\$5. Let $x=2$.\n\n$$x^2=4$$\n\nThen $x+1=3$.';
  const value = mathTextToValue(source);
  expect(valueToMathText(value)).toBe(source);
  expect(value.some((node) => node.type === 'equation')).toBe(true);
});

it('reads blanks as chips in a gaps part and writes them numbered from its start', () => {
  const value = mathTextToValue(
    'Water boils at (1) ______ and freezes at (2) ______.',
    {
      gaps: true,
    }
  );
  expect(gapIds(value)).toEqual(['g0', 'g1']);
  expect(valueToMathText(value, 3)).toBe(
    'Water boils at (3) ______ and freezes at (4) ______.'
  );
});
