import { expect, it } from 'vitest';
import { mathTextToValue, valueToMathText } from './mathTextValue';

it('retains display equations, inline equations and escaped dollars when edited', () => {
  const source = 'Cost \\$5. Let $x=2$.\n\n$$x^2=4$$\n\nThen $x+1=3$.';
  const value = mathTextToValue(source);
  expect(valueToMathText(value)).toBe(source);
  expect(value.some((node) => node.type === 'equation')).toBe(true);
});
