import { describe, expect, it } from 'vitest';
import { parseMarkedText, stripMarks } from './parseMarkedText';

describe('question text marks', () => {
  it('reads bold, italic and underline markers', () => {
    expect(parseMarkedText('a **b** *c* __d__')).toEqual([
      { type: 'text', value: 'a ' },
      { bold: true, type: 'text', value: 'b' },
      { type: 'text', value: ' ' },
      { italic: true, type: 'text', value: 'c' },
      { type: 'text', value: ' ' },
      { type: 'text', underline: true, value: 'd' },
    ]);
  });

  it('nests marks', () => {
    expect(parseMarkedText('***both*** __**x**__')).toEqual([
      { bold: true, italic: true, type: 'text', value: 'both' },
      { type: 'text', value: ' ' },
      { bold: true, type: 'text', underline: true, value: 'x' },
    ]);
    expect(parseMarkedText('**the *very* best**')).toEqual([
      { bold: true, type: 'text', value: 'the ' },
      { bold: true, italic: true, type: 'text', value: 'very' },
      { bold: true, type: 'text', value: ' best' },
    ]);
    // Inside a word, by the rule of three.
    expect(parseMarkedText('**ab*cd*ef**')).toEqual([
      { bold: true, type: 'text', value: 'ab' },
      { bold: true, italic: true, type: 'text', value: 'cd' },
      { bold: true, type: 'text', value: 'ef' },
    ]);
  });

  it('marks a formula inside a pair', () => {
    expect(parseMarkedText('**$x^2$ term**')).toEqual([
      { bold: true, type: 'inline', value: 'x^2' },
      { bold: true, type: 'text', value: ' term' },
    ]);
  });

  it('marks CJK text', () => {
    expect(parseMarkedText('這是**重點**。')).toEqual([
      { type: 'text', value: '這是' },
      { bold: true, type: 'text', value: '重點' },
      { type: 'text', value: '。' },
    ]);
  });

  it('keeps loose markers, blanks, formulas and escapes as written', () => {
    for (const text of [
      '2 * 3 * 4',
      'a*b',
      '(1) ______ and ______',
      '** not bold **',
      '****',
    ])
      expect(parseMarkedText(text)).toEqual([{ type: 'text', value: text }]);
    expect(parseMarkedText('$a*b*c$ and $x_1 + y_2$')).toEqual([
      { type: 'inline', value: 'a*b*c' },
      { type: 'text', value: ' and ' },
      { type: 'inline', value: 'x_1 + y_2' },
    ]);
    expect(parseMarkedText('\\*not italic\\* \\_\\_or this\\_\\_')).toEqual([
      { type: 'text', value: '*not italic* __or this__' },
    ]);
  });

  it('underlines inside a word, as bold marks', () => {
    expect(parseMarkedText('the__key__word, 中文__重點__中文')).toEqual([
      { type: 'text', value: 'the' },
      { type: 'text', underline: true, value: 'key' },
      { type: 'text', value: 'word, 中文' },
      { type: 'text', underline: true, value: '重點' },
      { type: 'text', value: '中文' },
    ]);
  });

  it('reads a doubled backslash before a marker as a backslash', () => {
    expect(parseMarkedText('C:\\\\**word** \\\\\\*')).toEqual([
      { type: 'text', value: 'C:\\' },
      { bold: true, type: 'text', value: 'word' },
      { type: 'text', value: ' \\*' },
    ]);
  });

  it('strips markers for plain text, formulas as written', () => {
    expect(stripMarks('**Find** $x_1$ in *2 * 3*')).toBe('Find $x_1$ in 2 * 3');
  });
});
