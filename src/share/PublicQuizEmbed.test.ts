import { beforeEach, expect, it, vi } from 'vitest';

/* A quiz embedded in a shared note takes the signed-in check only once the
   session is known to be signed in; otherwise it takes the captcha route
   (Q311). */

const { anonymous, session, take } = vi.hoisted(() => ({
  anonymous: { checkSharedNoteQuiz: vi.fn(), gradeAnonymousNoteQuiz: vi.fn() },
  session: { sessionNow: vi.fn<() => boolean | undefined>() },
  take: vi.fn(async () => 'turnstile-token'),
}));
vi.mock('@/api/anonymous', () => anonymous);
vi.mock('./session', () => session);
vi.mock('@/lib/localDb', () => ({ anonymousId: async () => 'local-1' }));

const { gradeEmbeddedQuiz } = await import('./PublicQuizEmbed');

beforeEach(() => vi.clearAllMocks());

it('grades a signed-in visitor through the signed-in check, with no captcha', async () => {
  session.sessionNow.mockReturnValue(true);
  await gradeEmbeddedQuiz('note.tok', 'qz_1', 'q1', { a: 'b' }, take);
  expect(anonymous.checkSharedNoteQuiz).toHaveBeenCalledWith(
    'note.tok',
    'qz_1',
    { answers: { a: 'b' }, questionId: 'q1' }
  );
  expect(anonymous.gradeAnonymousNoteQuiz).not.toHaveBeenCalled();
  expect(take).not.toHaveBeenCalled();
});

it('takes the captcha route while signed out or not yet settled', async () => {
  for (const state of [false, undefined]) {
    vi.clearAllMocks();
    session.sessionNow.mockReturnValue(state);
    await gradeEmbeddedQuiz('note.tok', 'qz_1', 'q1', { a: 'b' }, take);
    expect(anonymous.gradeAnonymousNoteQuiz).toHaveBeenCalledWith(
      'note.tok',
      'qz_1',
      {
        answers: { a: 'b' },
        localId: 'local-1',
        questionId: 'q1',
        turnstileToken: 'turnstile-token',
      }
    );
    expect(anonymous.checkSharedNoteQuiz).not.toHaveBeenCalled();
  }
});
