import { expect, it } from 'vitest';
import { quizNode } from '@/features/materials/document';
import { QUESTION_TYPES } from '@/features/questions/types';
import {
  QUIZ_TEMPLATES,
  templatePreview,
  templateQuestions,
} from './quizTemplates';

// Epo 2026-11-11: a blank quiz, then one template per answer type.
it('offers a blank quiz and every answer type', () => {
  expect(QUIZ_TEMPLATES[0]).toBe('blank');
  expect([...QUIZ_TEMPLATES.slice(1)].sort()).toEqual(
    [...QUESTION_TYPES].sort()
  );
  expect(templateQuestions('blank')).toEqual([]);
});

// A stored quiz holds only complete questions: quizNode validates them.
it.each(QUESTION_TYPES)(
  'starts a %s quiz with one complete question',
  (type) => {
    const questions = templateQuestions(type);
    expect(questions).toHaveLength(1);
    expect(questions[0].parts[0].answer.type).toBe(type);
    expect(quizNode({ questions }).children).toHaveLength(1);
  }
);

it('pictures each template as a quiz card previews its question', () => {
  expect(templatePreview('blank')).toBeUndefined();
  expect(templatePreview('mcq')?.options).toHaveLength(3);
  expect(templatePreview('matching')?.prompts).toHaveLength(3);
  expect(templatePreview('ordering')?.itemCount).toBe(4);
  // Each blank of a gaps text is U+0001.
  expect(templatePreview('gaps')?.stem.split('\u0001')).toHaveLength(3);
});
