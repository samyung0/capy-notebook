import type { Question, RateReviewItemReq } from '@/api/types';
import type { Answers } from '@/features/quizzes/grade';
import {
  type GradeOpenParts,
  gradeAttemptQuestions,
} from '@/features/quizzes/scoreAttempt';
import { m } from '@/i18n';
import type { SrsRating } from '@/lib/srs';

export const RATING_LABEL: Record<SrsRating, () => string> = {
  again: m.srs_again,
  easy: m.srs_easy,
  good: m.srs_good,
  hard: m.srs_hard,
};
export const RATING_STYLE: Record<SrsRating, string> = {
  again: 'border-tint-error text-tint-error-fg hover:bg-tint-error',
  easy: 'border-tint-success text-tint-success-fg hover:bg-tint-success',
  good: 'border-tint-accent-1 text-tint-accent-1-fg hover:bg-tint-accent-1',
  hard: 'border-tint-warning text-tint-warning-fg hover:bg-tint-warning',
};

/** A review session's ratings: each posts in the background, and `saved`
 * resolves once every one has settled, so the next batch is chosen from them. */
export function ratingQueue(
  post: (body: RateReviewItemReq) => Promise<unknown>,
  failed: () => void
) {
  let pending: Promise<unknown>[] = [];
  return {
    rate(body: RateReviewItemReq) {
      pending.push(post(body).catch(failed));
    },
    async saved() {
      const ratings = pending;
      pending = [];
      await Promise.all(ratings);
    },
  };
}

/** Grades a review question the quiz page's way; its score is the awarded
 * share of its marks. */
export async function gradeReviewQuestion(
  question: Question,
  answers: Answers,
  gradeOpen: GradeOpenParts
): Promise<{ graded: Question; score: number }> {
  const result = await gradeAttemptQuestions([question], answers, gradeOpen);
  return {
    graded: result.questions[0] ?? question,
    score: result.max > 0 ? result.awarded / result.max : 0,
  };
}
