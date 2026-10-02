import { queryOptions } from '@tanstack/react-query';
import { ApiError, type ApiErrorBody, api } from './client';
import type {
  AnonymousFlashcards,
  AnonymousQuiz,
  GradedPart,
  GradeQuizResp,
} from './types';

/**
 * Signed-out reads and grading of shared standalone quizzes and flashcard sets;
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
    const body = (await response
      .json()
      .catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(
      response.status,
      response.statusText,
      body?.message,
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

/** The image URL a signed-out page renders for one of a quiz's assets. */
export const anonymousAssetUrl = (token: string, assetId: string) =>
  `/p/quizzes/${token}/assets/${assetId}`;

export async function gradeAnonymousQuiz(
  token: string,
  answers: Record<string, string>,
  localId: string | undefined
): Promise<Record<string, GradedPart>> {
  const { parts } = await publicJson<GradeQuizResp>(
    `/api/public/quizzes/${token}/grade`,
    {
      body: JSON.stringify({ answers, localId }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    }
  );
  return parts;
}

export async function gradeQuiz(
  quizId: string,
  answers: Record<string, string>
): Promise<Record<string, GradedPart>> {
  const { parts } = await api.post<GradeQuizResp>(`/quizzes/${quizId}/grade`, {
    answers,
  });
  return parts;
}

/** The daily anonymous grading cap; the visitor can sign in to keep going. */
export const isAnonymousGradingLimit = (err: unknown) =>
  err instanceof ApiError && err.code === 'anonymous_grading_limit';
