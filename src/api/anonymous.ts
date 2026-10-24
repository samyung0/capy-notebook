import { m } from '@/i18n';
import { ApiError, api, parseErrorBody } from './client';
import type { GradeAnonymousQuizReq, GradedQuiz, Question } from './types';

/**
 * Signed-out images and grading of shared standalone quizzes, flashcard sets
 * and notes; `token` is the `{id}.{signature}` from the link. The site Worker
 * renders the pages themselves; images go through its `/p/` routes, which
 * verify the token and cache at the edge. Grading calls the API directly so it
 * sees the visitor's IP for its per-IP caps.
 */
async function publicJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { Accept: 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    // Machine codes such as anonymous_grading_limit arrive in errors[].message.
    const body = parseErrorBody(await response.json().catch(() => null));
    throw new ApiError(
      response.status,
      response.statusText,
      body?.message ?? body?.detail,
      body
    );
  }
  return (await response.json()) as T;
}

/** The image URL a signed-out page renders for one of a quiz's assets. */
export const anonymousAssetUrl = (token: string, assetId: string) =>
  `/p/quizzes/${token}/assets/${assetId}`;

/** The same for a shared flashcard set's card images. */
export const anonymousFlashcardAssetUrl = (token: string, assetId: string) =>
  `/p/flashcards/${token}/assets/${assetId}`;

/** The same for a shared note's images. */
export const anonymousNoteAssetUrl = (token: string, assetId: string) =>
  `/p/notes/${token}/assets/${assetId}`;

/** Grades every part of a signed-out attempt; the result carries each
 * question's key, so the page shows it and keeps it in this browser. */
export async function gradeAnonymousQuiz(
  token: string,
  body: GradeAnonymousQuizReq
): Promise<{ questions: Question[]; awarded: number; max: number }> {
  const graded = await publicJson<GradedQuiz>(
    `/api/public/quizzes/${token}/grade`,
    {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    }
  );
  return {
    awarded: graded.correct,
    max: graded.total,
    questions: graded.questions,
  };
}

/** The daily anonymous grading cap; the visitor can sign in to keep going. */
export const isAnonymousGradingLimit = (err: unknown) =>
  err instanceof ApiError && err.code === 'anonymous_grading_limit';

/** A signed-out check's Turnstile refusal, shown inline under Check. */
export function captchaCopy(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return;
  if (err.code === 'captcha_failed') return m.quiz_captcha_failed();
  if (err.code === 'captcha_unavailable') return m.quiz_captcha_unavailable();
}

/** A signed-in visitor's check of a quiz embedded in a shared note, through
 * the note's link: graded under the user's daily grading parts with no
 * captcha, storing nothing (Q311). */
export async function checkSharedNoteQuiz(
  token: string,
  quizId: string,
  answers: GradeAnonymousQuizReq['answers']
): Promise<{ questions: Question[]; awarded: number; max: number }> {
  const graded = await api.post<GradedQuiz>(
    `/shared/notes/${token}/quizzes/${quizId}/check`,
    { answers }
  );
  return {
    awarded: graded.correct,
    max: graded.total,
    questions: graded.questions,
  };
}

/** Grades an attempt at a quiz embedded in a shared note, through the note's
 * link (the quiz has none of its own); it stores nothing. */
export async function gradeAnonymousNoteQuiz(
  token: string,
  quizId: string,
  body: GradeAnonymousQuizReq
): Promise<{ questions: Question[]; awarded: number; max: number }> {
  const graded = await publicJson<GradedQuiz>(
    `/api/public/notes/${token}/quizzes/${quizId}/grade`,
    {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    }
  );
  return {
    awarded: graded.correct,
    max: graded.total,
    questions: graded.questions,
  };
}
