import { useMutation } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { api } from '@/api/client';
import type {
  CheckReviewItemReq,
  GradedQuestion,
  ReviewItem,
  ReviewSessionRef,
} from '@/api/types';
import { Button } from '@/components/ui/Button';
import { userToast } from '@/components/ui/userToast';
import type { Question } from '@/features/questions/types';
import type { Answers } from '@/features/quizzes/grade';
import { QuestionRunner } from '@/features/quizzes/QuestionRunner';
import { m } from '@/i18n';

/* One review question, shared by review sessions and the Study tab's Quick
   review: answered the quiz page's way, then shown checked, read only. */

/** A checked question: its result with the key, read only. `action` sits at
 * the row's end (Quick review's Done). */
export function CheckedQuestion({
  title,
  answers,
  question,
  action,
}: {
  title: string;
  answers: Answers;
  question?: Question;
  action?: ReactNode;
}) {
  return (
    <>
      {question && (
        <QuestionRunner answers={answers} disabled question={question} review />
      )}
      <div className="flex items-center justify-between gap-3">
        <span className="t-meta text-fg-muted">{m.review_from({ title })}</span>
        {action}
      </div>
    </>
  );
}

/** Check sends the answers; the server grades them, records the rating (in
 * `session` when there is one) and returns the question's key. */
export function QuestionItem({
  item,
  onChecked,
  session,
}: {
  item: ReviewItem;
  onChecked: (graded: GradedQuestion, answers: Answers) => void;
  session?: ReviewSessionRef;
}) {
  const [answers, setAnswers] = useState<Answers>({});
  const { isPending: grading, mutate: check } = useMutation({
    meta: { errorToast: false },
    mutationFn: () =>
      api.post<GradedQuestion>('/review/check', {
        answers,
        itemId: item.itemId,
        materialId: item.materialId,
        ...(session ? { session } : {}),
      } satisfies CheckReviewItemReq),
    onError: () =>
      userToast({
        id: 'review-grade-failed',
        title: m.review_grade_failed(),
        variant: 'error',
      }),
    onSuccess: (graded) => onChecked(graded, answers),
  });

  return (
    <>
      <QuestionRunner
        answers={answers}
        disabled={grading}
        onChange={(partId, value) =>
          setAnswers((a) => ({ ...a, [partId]: value }))
        }
        question={item.question!}
      />
      <div className="flex items-center justify-between gap-3">
        <span className="t-meta text-fg-muted">
          {m.review_from({ title: item.materialTitle })}
        </span>
        <Button disabled={grading} onClick={() => check()} rounded="large">
          {m.review_check()}
        </Button>
      </div>
    </>
  );
}
