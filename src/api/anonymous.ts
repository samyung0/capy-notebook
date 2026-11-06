import { answersForCheck } from '@/features/quizzes/drawing/drawingValue';
import type { Answers } from '@/features/quizzes/grade';
import { ApiError, parseErrorBody } from './client';
import type { GradeAnonymousQuizReq, GradedQuestion } from './types';

/**
 * Images and checks of shared standalone quizzes, flashcard sets and notes, the
 * same for every visitor; `token` is the `{id}.{signature}` from the link. The
 * site Worker renders the pages themselves; images go through its `/p/` routes,
 * which verify the token and cache at the edge. A check calls the API directly
 * so its rate limit sees the visitor's address.
 */
async function publicJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { Accept: 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    // Machine codes such as question_no_answers arrive in errors[].message.
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

/** Checks one question of a shared quiz; the result carries its key, so the
 * page shows it and keeps it in this browser. An answered open part comes back
 * Not marked. */
export const gradeAnonymousQuiz = (
  token: string,
  body: GradeAnonymousQuizReq
) =>
  publicJson<GradedQuestion>(`/api/public/quizzes/${token}/grade`, {
    body: JSON.stringify(withDrawingsSent(body)),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });

/** The same for a quiz embedded in a shared note, through the note's link (the
 * quiz has none of its own); it stores nothing. */
export const gradeAnonymousNoteQuiz = (
  token: string,
  quizId: string,
  body: GradeAnonymousQuizReq
) =>
  publicJson<GradedQuestion>(
    `/api/public/notes/${token}/quizzes/${quizId}/grade`,
    {
      body: JSON.stringify(withDrawingsSent(body)),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    }
  );

/** A drawing goes as its board and image; a shared page never marks it. */
const withDrawingsSent = (body: GradeAnonymousQuizReq) => ({
  ...body,
  answers: answersForCheck(body.answers as Answers),
});
