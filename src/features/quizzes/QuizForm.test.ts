import { describe, expect, it } from 'vitest';
import { parseQuizFenceBody } from '@/features/materials/blocks';
import {
  createMaterialDocument,
  quizElementToBlock,
  quizNode,
} from '@/features/materials/document';
import { quizFenceBody } from '@/features/notes/blocks/shared';
import { exampleQuestions } from '@/features/questions/questionFixtures';
import { createBlankQuestion, isCompleteQuestion } from './QuizForm';

describe('shared question editing', () => {
  it('round-trips every answer through both document and markdown boundaries', () => {
    expect(exampleQuestions.every(isCompleteQuestion)).toBe(true);
    expect(isCompleteQuestion(createBlankQuestion())).toBe(false);
    const node = quizNode({ questions: exampleQuestions }, 'quiz');
    createMaterialDocument([node]);
    expect(quizElementToBlock(node).questions).toEqual(exampleQuestions);
    expect(
      parseQuizFenceBody(quizFenceBody({ questions: exampleQuestions }))
    ).toEqual({ questions: exampleQuestions });
    expect(parseQuizFenceBody('questions: []')).toEqual({ questions: [] });
    expect(() =>
      parseQuizFenceBody('questions: [{id: old, prompt: Old, type: short}]')
    ).toThrow();
  });
});
