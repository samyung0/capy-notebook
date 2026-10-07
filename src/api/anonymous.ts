import { queryOptions } from '@tanstack/react-query';
import { ApiError, parseErrorBody } from './client';
import type {
  AnonymousFlashcards,
  AnonymousNote,
  AnonymousQuiz,
  GradeAnonymousQuizReq,
  GradedQuiz,
  Question,
} from './types';

/**
 * Signed-out reads and grading of shared standalone quizzes, flashcard sets
 * and notes;
 * `token` is the `{id}.{signature}` from the link. Reads go through the site
 * Worker's `/p/` routes, which verify the token and cache at the edge. Grading
 * calls the API directly so it sees the visitor's IP for its per-IP caps.
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

export const anonymousQuizQuery = (token: string) =>
  queryOptions({
    queryFn: () => publicJson<AnonymousQuiz>(`/p/quizzes/${token}`),
    queryKey: ['anonymous', 'quiz', token] as const,
  });

export const anonymousFlashcardsQuery = (token: string) =>
  queryOptions({
    queryFn: () => publicJson<AnonymousFlashcards>(`/p/flashcards/${token}`),
    queryKey: ['anonymous', 'flashcards', token] as const,
  });

export const anonymousNoteQuery = (token: string) =>
  queryOptions({
    queryFn: () => publicJson<AnonymousNote>(`/p/notes/${token}`),
    queryKey: ['anonymous', 'note', token] as const,
  });

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
