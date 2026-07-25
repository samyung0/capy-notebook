import { describe, expect, it } from 'vitest';
import type { ChoiceQuestion, Question } from '@/api/types';
import { parseQuizFenceBody } from '@/features/materials/blocks';
import { quizFenceBody } from '@/features/notes/blocks/shared';
import { createBlankQuestion, isCompleteQuestion } from './QuizForm';

const questions: Question[] = [
  {
    correct: [0],
    id: 'mcq',
    level: 'recall',
    options: [
      { explanation: 'Because it is.', value: 'Correct' },
      { explanation: 'Because it is not.', value: 'Wrong' },
    ],
    prompt: 'Pick one',
    type: 'mcq',
  },
  {
    correct: [0, 1],
    id: 'multi',
    level: 'application',
    options: [{ value: 'First' }, { value: 'Second' }],
    prompt: 'Pick several',
    type: 'multi',
  },
  {
    correct: false,
    id: 'boolean',
    level: 'recall',
    prompt: 'True or false?',
    type: 'boolean',
  },
  {
    accepted: [{ value: 'Accepted' }],
    id: 'fill',
    level: 'application',
    prompt: 'Fill this',
    type: 'fill',
  },
  {
    accepted: [{ value: 'Short answer' }],
    explanation: 'A concise explanation.',
    id: 'short',
    level: 'analysis',
    prompt: 'Explain briefly',
    type: 'short',
  },
  {
    id: 'ordering',
    items: [{ value: 'First' }, { value: 'Second' }],
    level: 'application',
    prompt: 'Order these',
    type: 'ordering',
  },
  {
    id: 'matching',
    level: 'analysis',
    pairs: [
      { left: 'A', right: 'One' },
      { left: 'B', right: 'Two' },
    ],
    prompt: 'Match these',
    type: 'matching',
  },
];

describe('QuizForm question helpers', () => {
  it('validates complete questions for every supported type', () => {
    const incompleteChoice = structuredClone(questions[0]) as ChoiceQuestion;
    incompleteChoice.correct = [];

    expect(questions.every(isCompleteQuestion)).toBe(true);
    expect(isCompleteQuestion(createBlankQuestion('mcq'))).toBe(false);
    expect(isCompleteQuestion(incompleteChoice)).toBe(false);
  });

  it('round-trips every question type without losing typed fields', () => {
    const parsed = parseQuizFenceBody(
      quizFenceBody({ questions, timeLimitMin: 20 })
    );

    expect(parsed).toEqual({ questions, timeLimitMin: 20 });
  });
});
