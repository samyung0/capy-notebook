import { expect, it } from 'vitest';
import * as limits from '@/api/limits.generated';
import {
  exampleQuestion,
  exampleQuestions,
} from '@/features/questions/questionFixtures';
import {
  type Question,
  type QuestionBlock,
  schemeMarks,
  withoutBlanks,
} from '@/features/questions/types';
import { m } from '@/i18n';
import { incompleteLine } from './incomplete';

const empty = { text: '  ', type: 'text' } as const;

it('ignores empty text blocks but needs a body', () => {
  const [question] = exampleQuestions;
  const [part] = question.parts;
  const padded: Question = {
    ...question,
    parts: [
      {
        ...part,
        blocks: [...part.blocks, empty],
        solution: [...part.solution, empty],
      },
    ],
    stem: [empty],
  };
  expect(incompleteLine(padded)).toBeNull();
  expect(
    incompleteLine({ ...question, parts: [{ ...part, blocks: [empty] }] })
  ).not.toBeNull();
});

it('drops a blank unit, blank hints and blank accepted answers', () => {
  const short = exampleQuestion('short', {
    accepted: ['osmosis', ' '],
    type: 'short',
    unit: ' ',
  });
  const open = exampleQuestion('open', {
    accepted: ['', 'Folds add surface area.'],
    hints: ['', 'Think about surface area.', ' '],
    type: 'open',
  });
  expect(incompleteLine(short)).toBeNull();
  expect(incompleteLine(open)).toBeNull();
  expect(withoutBlanks(short).parts[0].answer).toEqual({
    accepted: ['osmosis'],
    type: 'short',
  });
  expect(withoutBlanks(open).parts[0].answer).toMatchObject({
    accepted: ['Folds add surface area.'],
    hints: ['Think about surface area.'],
  });
  // No accepted answer left leaves the part incomplete.
  expect(
    incompleteLine(exampleQuestion('none', { accepted: [' '], type: 'short' }))
  ).not.toBeNull();
});

it('fills short table rows and chart series, and drops blank descriptions', () => {
  const blocks: QuestionBlock[] = [
    { header: true, rows: [['a'], ['1', '2']], type: 'table' },
    {
      kind: 'bar',
      labels: ['x', 'y', 'z'],
      series: [{ name: 'S', values: [Number.NaN, 2] }],
      title: '',
      type: 'chart',
    },
    {
      description: ' ',
      height: 20,
      image: { assetId: 'asset_1' },
      type: 'image',
      width: 20,
    },
  ];
  const [question] = exampleQuestions;
  const filled = { ...question, stem: blocks };
  expect(withoutBlanks(filled).stem).toEqual([
    {
      header: true,
      rows: [
        ['a', ''],
        ['1', '2'],
      ],
      type: 'table',
    },
    { ...blocks[1], series: [{ name: 'S', values: [null, 2, null] }] },
    { height: 20, image: { assetId: 'asset_1' }, type: 'image', width: 20 },
  ]);
  expect(incompleteLine(filled)).toBeNull();
});

it('caps an open part past the marks limit and names the mismatch', () => {
  const question = exampleQuestions.find(
    (q) => q.parts[0].answer.type === 'open'
  );
  if (!question) throw new Error('no open example');
  const markscheme = [
    { marks: 15, text: 'Names the organelle.' },
    { marks: 10, text: 'Explains the folds.' },
  ];
  const marks = schemeMarks(markscheme);
  expect(marks).toBe(limits.QUESTION_MARKS_MAX);
  const over: Question = {
    ...question,
    parts: [{ ...question.parts[0], marks, markscheme }],
  };
  expect(incompleteLine(over)).toBe(
    m.quiz_incomplete({ reason: m.question_validation_markscheme_total() })
  );
});
