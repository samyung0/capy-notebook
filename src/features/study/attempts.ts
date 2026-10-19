import type { Attempt } from '@/api/types';
import { formatPoints } from '@/features/quizzes/grade';
import { getLocale, m } from '@/i18n';

/** "Oct 17, 2026 · 12 min · Biology 101": when, how long, where. */
export function attemptMeta(attempt: Attempt) {
  return [
    new Date(attempt.takenAt).toLocaleDateString(getLocale(), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }),
    attempt.startedAt && attemptMinutes(attempt),
    attempt.workspaceName,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Minutes from start to the last answer, at least one. */
export function attemptMinutes(attempt: Attempt) {
  const ms =
    Date.parse(attempt.takenAt) -
    Date.parse(attempt.startedAt ?? attempt.takenAt);
  return m.result_minutes({ count: Math.max(1, Math.round(ms / 60_000)) });
}

/** Where an attempt's result opens. */
export const resultLink = (a: Pick<Attempt, 'id' | 'kind'>) =>
  a.kind === 'flashcards'
    ? ({
        params: { attemptId: a.id },
        to: '/flashcards/attempts/$attemptId',
      } as const)
    : ({
        params: { attemptId: a.id },
        to: '/quizzes/attempts/$attemptId',
      } as const);

/** "9 / 10" marks, or "14 / 18 good" cards. */
export const scoreText = (a: Pick<Attempt, 'correct' | 'kind' | 'total'>) =>
  a.kind === 'flashcards'
    ? m.flashcards_score({ correct: a.correct, total: a.total })
    : `${formatPoints(a.correct)} / ${formatPoints(a.total)}`;
