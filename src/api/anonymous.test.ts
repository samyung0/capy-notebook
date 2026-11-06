import { afterEach, expect, it, vi } from 'vitest';
import { gradeAnonymousQuiz } from './anonymous';
import { isNoAnswersError } from './client';

afterEach(() => vi.unstubAllGlobals());

it("reads a refused check's machine code from the error body", async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            detail: 'the question is not in this quiz',
            errors: [{ message: 'question_no_answers' }],
            status: 404,
          }),
          { status: 404 }
        )
    )
  );
  const error = await gradeAnonymousQuiz('qz.sig', {
    answers: {},
    questionId: 'q1',
  }).catch((err: unknown) => err);
  expect(isNoAnswersError(error)).toBe(true);
});
