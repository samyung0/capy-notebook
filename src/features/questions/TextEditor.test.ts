import type { Descendant, Value } from 'platejs';
import { expect, it } from 'vitest';
import { gapIds, mathTextToValue, valueToMathText } from './mathTextValue';

it('retains display equations, inline equations and escaped dollars when edited', () => {
  const source = 'Cost \\$5. Let $x=2$.\n\n$$x^2=4$$\n\nThen $x+1=3$.';
  const value = mathTextToValue(source);
  expect(valueToMathText(value)).toBe(source);
  expect(value.some((node) => node.type === 'equation')).toBe(true);
});

it('reads display formulas on consecutive lines as no paragraph between them', () => {
  const value = mathTextToValue('**Method**\n\n$$a=1$$\n$$b=2$$');
  expect(value.map((node) => node.type)).toEqual(['p', 'equation', 'equation']);
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

it('keeps text without markers as written, marker characters included', () => {
  for (const source of [
    'Work out 2 * 3 * 4 and a*b.',
    'Name the ______ here.',
    'Let $a*b*c$ and $x_1$.\n\nThen \\$5.',
  ])
    expect(valueToMathText(mathTextToValue(source))).toBe(source);
});

it('reads markers as marks and writes marks back as markers', () => {
  const source = '**Bold** *italic* __under__ ***both*** **the $x$ term**';
  const value = mathTextToValue(source);
  expect(value[0].children).toContainEqual({ bold: true, text: 'Bold' });
  expect(value[0].children).toContainEqual({ text: 'under', underline: true });
  expect(valueToMathText(value)).toBe(source);
});

it('writes a mark tight, its spaces outside the markers', () => {
  expect(
    valueToMathText([
      {
        children: [
          { text: 'Find ' },
          { bold: true, text: 'all the ' },
          { bold: true, italic: true, text: 'real' },
          { bold: true, text: ' roots ' },
          { text: 'now' },
        ],
        type: 'p',
      },
    ])
  ).toBe('Find **all the *real* roots** now');
});

const paragraph = (...children: Descendant[]): Value => [
  { children, type: 'p' },
];

it('escapes only typed marker characters that would read as markers', () => {
  const value = paragraph(
    { text: 'Type *this* and ______ ' },
    { bold: true, text: 'now' }
  );
  const text = valueToMathText(value);
  expect(text).toBe('Type \\*this\\* and ______ **now**');
  expect(valueToMathText(mathTextToValue(text))).toBe(text);
});

it('keeps a typed backslash before a mark or formula', () => {
  for (const value of [
    paragraph({ text: 'C:\\' }, { bold: true, text: 'word' }, { text: ' end' }),
    paragraph({ text: 'a\\' }, { italic: true, text: 'b' }),
    paragraph(
      { text: 'x\\' },
      { children: [{ text: '' }], texExpression: 'y', type: 'inline_equation' },
      { text: ' \\$ and \\*' }
    ),
  ]) {
    const text = valueToMathText(value);
    expect(valueToMathText(mathTextToValue(text))).toBe(text);
  }
  const text = valueToMathText(
    paragraph({ text: 'C:\\' }, { bold: true, text: 'word' })
  );
  expect(text).toBe('C:\\\\**word**');
  expect(mathTextToValue(text)[0].children).toEqual([
    { text: '' },
    { text: 'C:\\' },
    { bold: true, text: 'word' },
  ]);
  for (const source of ['C:\\\\**word** end', 'a\\\\$x$ \\\\* and a\\b'])
    expect(valueToMathText(mathTextToValue(source))).toBe(source);
});

it('writes an underline inside a word', () => {
  expect(
    valueToMathText(
      paragraph(
        { text: 'snake' },
        { text: 'case', underline: true },
        { text: 'name' }
      )
    )
  ).toBe('snake__case__name');
  expect(
    valueToMathText(
      paragraph({ text: '中文' }, { text: '重點', underline: true })
    )
  ).toBe('中文__重點__');
});

it('writes nothing for an empty formula, joining the text around it', () => {
  const value: Value = [
    { children: [{ text: 'Before' }], type: 'p' },
    { children: [{ text: '' }], texExpression: '', type: 'equation' },
    {
      children: [
        { text: 'After ' },
        {
          children: [{ text: '' }],
          texExpression: '',
          type: 'inline_equation',
        },
        { text: '' },
      ],
      type: 'p',
    },
  ];
  expect(valueToMathText(value)).toBe('Before\nAfter ');
});
