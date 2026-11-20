import { expect, it, vi } from 'vitest';
import { showErrorToast } from '@/api/queryClient';
import type { GraphBlock, LearnerQuestion } from '@/features/questions/types';
import {
  boardCode,
  codeOf,
  graphCode,
  htmlSourceCode,
  katexCode,
  mathCode,
} from './blockCode';
import type { MaterialValue } from './document';

/* Preview loads what a note's blocks need before it draws (Epo 2026-11-20). */

vi.mock('@/api/queryClient', () => ({ showErrorToast: vi.fn() }));
vi.mock('@/features/notes/blocks/HtmlEmbedSourceDialog', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

const leaf = [{ text: '' }];
const graph = (elements: GraphBlock['elements']): GraphBlock => ({
  board: { axis: true, bbox: [-1, 1, 1, -1], grid: true },
  elements,
  height: 200,
  type: 'graph',
  width: 300,
});
const formulaGraph = graph([
  { coords: [0, 0], id: 'f', latex: 'y=x^2', type: 'formula' },
]);

it('needs what blocks draw with and what their buttons open', () => {
  const value: MaterialValue = [
    { children: leaf, html: '<p>Hi</p>', id: 'h', type: 'html_embed' },
    { block: formulaGraph, children: leaf, id: 'g', type: 'graph' },
    {
      children: [
        {
          children: [
            {
              children: [
                { text: 'Area ' },
                {
                  children: leaf,
                  texExpression: 'x^2',
                  type: 'inline_equation',
                },
                { text: '' },
              ],
              type: 'p',
            },
          ],
          type: 'column',
        },
      ],
      id: 'c',
      type: 'column_group',
    },
  ];
  expect(codeOf(value, () => undefined)).toEqual(
    new Set([htmlSourceCode, graphCode, katexCode, mathCode])
  );
});

const quizRef = (materialId: string, refKind = 'quiz') => ({
  children: leaf,
  id: materialId,
  materialId,
  refKind,
  type: 'material_ref',
});

// A pair of dollars is a formula in a question's text ("$5 or $6" draws "5 or"
// as one), so a lone one is the amount.
it("needs no MathLive for a dollar amount in a quiz's question", () => {
  const question: LearnerQuestion = {
    id: 'q',
    labels: 'letters',
    layout: 'paper',
    parts: [
      {
        answer: { options: ['$5', '$6'], type: 'mcq' },
        blocks: [{ text: 'A pen costs $5. Which is it?', type: 'text' }],
        id: 'q:a',
        marks: 1,
      },
    ],
    stem: [],
  };
  expect(codeOf([quizRef('quiz')], () => [question])).toEqual(new Set());
});

it("needs what an embedded quiz's questions hold, as the editor read them", () => {
  const question: LearnerQuestion = {
    id: 'q',
    labels: 'letters',
    layout: 'paper',
    parts: [
      {
        answer: { type: 'drawing' },
        blocks: [{ text: 'Sketch $y=x^2$.', type: 'text' }],
        id: 'q:a',
        marks: 2,
      },
    ],
    stem: [graph([])],
  };
  const value: MaterialValue = [
    quizRef('quiz'),
    quizRef('unread'),
    quizRef('cards', 'flashcards'),
  ];
  expect(
    codeOf(value, (id) => (id === 'quiz' ? [question] : undefined))
  ).toEqual(new Set([boardCode, graphCode, mathCode]));
});

it('marks code failed only for a load that was asked for, with one toast', async () => {
  await expect(htmlSourceCode.preload()).rejects.toThrow();
  expect(htmlSourceCode.settled).toBeUndefined();
  await expect(htmlSourceCode.load()).rejects.toThrow();
  await expect(htmlSourceCode.load()).rejects.toThrow();
  expect(htmlSourceCode.settled).toBe('failed');
  expect(showErrorToast).toHaveBeenCalledTimes(1);
});
