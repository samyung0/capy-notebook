import { afterEach, expect, it, vi } from 'vitest';
import { gradeAnonymousQuiz, isAnonymousGradingLimit } from './anonymous';

afterEach(() => vi.unstubAllGlobals());

it('reads the daily grading cap from the error body', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            detail: 'sign in to keep grading open answers today',
            errors: [{ message: 'anonymous_grading_limit' }],
            status: 429,
          }),
          { status: 429 }
        )
    )
  );
  const error = await gradeAnonymousQuiz('qz.sig', { answers: {} }).catch(
    (err: unknown) => err
  );
  expect(isAnonymousGradingLimit(error)).toBe(true);
});
