import { describe, expect, it } from 'vitest';
import { parseMathText } from './parseMathText';

describe('question math text', () => {
  it('preserves escaped dollars and incomplete delimiters', () => {
    expect(parseMathText('Cost \\$5 and $unfinished')).toEqual([
      { type: 'text', value: 'Cost $5 and $unfinished' },
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
