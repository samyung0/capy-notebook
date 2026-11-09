import { useQuiz } from '@/api/hooks';
import type { LearnerQuestion } from '@/features/questions/types';
import { useLiveQuizQuestions } from '@/features/quizzes/liveQuizReads';
import { m } from '@/i18n';

const NONE: LearnerQuestion[] = [];

/** The questions a quiz's room holds that it doesn't project: those with no
 * answers, which an assignment doesn't freeze (D4). */
export const questionsWithNoAnswers = (
  live: { id: string }[],
  stored: { id: string }[]
) => {
  const projected = new Set(stored.map((question) => question.id));
  return live.filter((question) => !projected.has(question.id)).length;
};

/** Beside publishing a quiz with questions that have no answers (Epo 2026-11-05,
 * "show a warning on publishing as assignment"): it doesn't block publishing. */
export function NoAnswersWarning({ quizId }: { quizId: string }) {
  const { data } = useQuiz(quizId, { errorBoundary: false, fresh: true });
  const stored = data?.questions ?? NONE;
  const live = useLiveQuizQuestions(quizId, stored, !!data);
  const count = questionsWithNoAnswers(live, stored);
  if (count === 0) return null;
  return (
    <p className="t-meta font-semibold text-tint-warning-fg">
      {count === 1
        ? m.assignment_quiz_no_answers_one()
        : m.assignment_quiz_no_answers({ count })}
    </p>
  );
}
