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
import { blockIssues, issueMessages, questionIssues } from './issues';

const empty = { text: '  ', type: 'text' } as const;
const messages = (question: Question, bank = false) =>
  issueMessages(questionIssues(question, { bank }));
const open = () => {
  const question = exampleQuestions.find(
    (q) => q.parts[0].answer.type === 'open'
  );
  if (!question) throw new Error('no open example');
  return question;
};

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
  expect(messages(padded)).toEqual([]);
  const bare = { ...question, parts: [{ ...part, blocks: [empty] }] };
  expect(questionIssues(bare)).toEqual([
    {
      message: m.question_issue_text_question(),
      partId: part.id,
      row: { kind: 'block', location: { index: 0, partId: part.id } },
    },
  ]);
  // With several parts the part is named like an answer issue's part.
  const two = { ...bare, parts: [part, { ...bare.parts[0], id: 'b' }] };
  expect(messages(two)).toEqual([m.question_issue_text_part({ label: 'B' })]);
  expect(messages({ ...two, labels: 'numbers' })).toEqual([
    m.question_issue_text_part({ label: '2' }),
  ]);
});

it('drops blank answers, hints and marking items', () => {
  const short = exampleQuestion('short', {
    accepted: ['osmosis', ' '],
    type: 'short',
    unit: ' ',
  });
  expect(messages(short)).toEqual([]);
  expect(withoutBlanks(short).parts[0].answer).toEqual({
    accepted: ['osmosis'],
    type: 'short',
  });
  const gaps = exampleQuestion('gaps', {
    accepted: [['oil', ' ']],
    type: 'gaps',
  });
  gaps.parts[0].blocks = [{ text: 'Add (1) ______.', type: 'text' }];
  expect(messages(gaps)).toEqual([]);
  expect(withoutBlanks(gaps).parts[0].answer).toEqual({
    accepted: [['oil']],
    type: 'gaps',
  });
  // Blank marking items go and the part's marks are the rest's (Epo
  // 2026-10-15); a sample answer is optional.
  const base = open();
  const scheme: Question = {
    ...base,
    parts: [
      {
        ...base.parts[0],
        answer: {
          accepted: [],
          hints: ['', 'Think about surface area.'],
          type: 'open',
        },
        marks: 4,
        markscheme: [
          { marks: 3, text: 'Names the organelle.' },
          { marks: 1, text: ' ' },
        ],
      },
    ],
  };
  expect(messages(scheme)).toEqual([]);
  expect(withoutBlanks(scheme).parts[0]).toMatchObject({
    answer: { accepted: [], hints: ['Think about surface area.'] },
    marks: 3,
    markscheme: [{ marks: 3, text: 'Names the organelle.' }],
  });
  // No item left: nothing to grade.
  const none = structuredClone(scheme);
  none.parts[0].markscheme = [{ marks: 1, text: '' }];
  expect(messages(none)).toEqual([m.question_issue_open_scheme()]);
  // No accepted answer left leaves a short part incomplete.
  expect(
    messages(exampleQuestion('none', { accepted: [' '], type: 'short' }))
  ).toEqual([m.question_issue_short_accepted()]);
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
  expect(messages(filled)).toEqual([]);
});

it('caps an open part past the marks limit and names the mismatch', () => {
  const question = open();
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
  expect(messages(over)).toEqual([
    m.question_issue_open_total({ max: limits.QUESTION_MARKS_MAX }),
  ]);
});

it('words each issue, names parts and points at rows and titles', () => {
  const [mcq] = exampleQuestions;
  const pie: QuestionBlock = {
    kind: 'pie',
    labels: ['x'],
    series: [{ name: 'S', values: [0] }],
    title: 'Share',
    type: 'chart',
  };
  const question: Question = {
    ...mcq,
    parts: [
      {
        ...mcq.parts[0],
        answer: { correct: [], options: ['Nucleus', ' '], type: 'mcq' },
        id: 'a',
      },
      {
        ...mcq.parts[0],
        answer: { accepted: ['two'], type: 'short', unit: 'kg' },
        id: 'b',
      },
      {
        ...mcq.parts[0],
        answer: { items: ['first'], type: 'ordering' },
        blocks: [empty, pie],
        id: 'c',
        solution: [],
      },
    ],
    // A rule the dialog cannot break: a line plot of one point.
    stem: [
      {
        series: [{ name: 'S', points: [[0, 1]] }],
        title: 'Plot',
        type: 'plot',
        xTitle: 'x',
        yTitle: 'y',
      },
    ],
  };
  expect(questionIssues(question)).toEqual([
    { message: m.question_issue_generic(), row: stemRow(0) },
    {
      message: m.question_issue_part({
        label: 'A',
        message: m.question_issue_mcq_correct(),
      }),
      partId: 'a',
      row: { kind: 'part', partId: 'a' },
    },
    {
      message: m.question_issue_part({
        label: 'A',
        message: m.question_issue_mcq_option_empty({ letter: 'B' }),
      }),
      partId: 'a',
      row: { kind: 'part', partId: 'a' },
    },
    {
      message: m.question_issue_part({
        label: 'B',
        message: m.question_issue_short_unit(),
      }),
      partId: 'b',
      row: { kind: 'part', partId: 'b' },
    },
    // The pie chart is the part's second block, after a blank one.
    {
      message: m.question_issue_pie(),
      partId: 'c',
      row: { kind: 'block', location: { index: 1, partId: 'c' } },
    },
    {
      message: m.question_issue_part({
        label: 'C',
        message: m.question_issue_ordering_items(),
      }),
      partId: 'c',
      row: { kind: 'part', partId: 'c' },
    },
  ]);
  // The rules after the schema: a bank part needs a worked solution.
  const valid = structuredClone(question);
  valid.stem = [];
  valid.parts = [valid.parts[2]];
  valid.parts[0].answer = { items: ['first', 'second'], type: 'ordering' };
  valid.parts[0].blocks = [{ text: 'Order them.', type: 'text' }];
  expect(messages(valid, true)).toEqual([
    m.question_validation_bank_solution(),
  ]);
  // A graph names its own error.
  const graph: Question = {
    ...mcq,
    stem: [
      {
        board: { axis: true, bbox: [5, 5, -5, -5], grid: false },
        elements: [],
        height: 400,
        image: { svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' },
        type: 'graph',
        width: 600,
      },
    ],
  };
  expect(messages(graph)).toEqual([
    m.question_issue_graph({ message: m.question_validation_graph_bounds() }),
  ]);
  // More than one sample answer is an agent-only shape.
  const samples = structuredClone(open());
  samples.parts[0].answer = { accepted: ['a', 'b'], hints: [], type: 'open' };
  expect(messages(samples)).toEqual([m.question_issue_generic()]);
});

function stemRow(index: number) {
  return { kind: 'block', location: { index } } as const;
}

it('names what a merge of two editors’ charts left in a note chart', () => {
  const chart = {
    kind: 'bar',
    labels: ['A'],
    series: [{ name: 'S', values: [1, 2] }],
    title: 'T',
    type: 'chart',
  } as QuestionBlock;
  expect(blockIssues(chart)).toEqual([m.question_validation_series_values()]);
  const series = Array.from({ length: 7 }, (_, i) => ({
    name: `S${i}`,
    values: [i],
  }));
  expect(blockIssues({ ...chart, series } as QuestionBlock)).toEqual([
    m.question_ui_chart_series_over({
      max: limits.QUESTION_CHART_SERIES_MAX,
    }),
  ]);
});
