import type { Question, QuestionAnswer } from './types';

/** Authored examples shared by the local demo and format tests. */
export const exampleAnswers: QuestionAnswer[] = [
  {
    correct: [1],
    options: ['Nucleus', 'Mitochondria', 'Ribosome'],
    type: 'mcq',
  },
  {
    correct: [0, 2],
    options: ['Nucleus', 'Ribosome', 'Mitochondria'],
    type: 'multi',
  },
  { correct: true, type: 'boolean' },
  { accepted: ['osmosis'], type: 'short' },
  {
    options: ['Stores DNA', 'Makes ATP', 'Unused choice'],
    pairs: [
      { left: 'Nucleus', right: 0 },
      { left: 'Mitochondria', right: 1 },
    ],
    type: 'matching',
  },
  { items: ['Ribosome', 'Rough ER', 'Golgi apparatus'], type: 'ordering' },
  {
    accepted: ['Folds increase the surface area available for ATP production.'],
    hints: [],
    type: 'open',
  },
];
export function exampleQuestion(
  id: string,
  answer: QuestionAnswer = exampleAnswers[0]
): Question {
  return {
    id,
    labels: 'letters',
    layout: 'paper',
    parts: [
      {
        answer,
        blocks: [{ text: 'Which organelle produces ATP?', type: 'text' }],
        id: `${id}-part`,
        markscheme: ['Identifies mitochondria as the site of ATP production.'],
        solution: [
          {
            text: 'Mitochondria produce ATP through cellular respiration.',
            type: 'text',
          },
        ],
      },
    ],
    stem: [],
  };
}
export const exampleQuestions = exampleAnswers.map((answer, index) =>
  exampleQuestion(`example-${index + 1}`, answer)
);
