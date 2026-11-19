import { describe, expect, it } from 'vitest';
import { parseMathText } from './parseMathText';

describe('question math text', () => {
  it('preserves escaped dollars and incomplete delimiters', () => {
    expect(parseMathText('Cost \\$5 and $unfinished')).toEqual([
      { type: 'text', value: 'Cost $5 and $unfinished' },
    ]);
  });
  it('reads a doubled backslash before a dollar as a backslash', () => {
    expect(parseMathText('a\\\\$x$ b\\\\\\$5')).toEqual([
      { type: 'text', value: 'a\\' },
      { type: 'inline', value: 'x' },
      { type: 'text', value: ' b\\$5' },
    ]);
  });
  it('keeps inline and display formulas distinct', () => {
    expect(parseMathText('Let $x=2$.\n\n$$x^2=4$$')).toEqual([
      { type: 'text', value: 'Let ' },
      { type: 'inline', value: 'x=2' },
      { type: 'text', value: '.\n\n' },
      { type: 'display', value: 'x^2=4' },
    ]);
  });
});
