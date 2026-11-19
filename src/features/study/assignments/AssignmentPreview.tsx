import { type ReactNode, useEffect, useState } from 'react';
import { useQuiz } from '@/api/hooks';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import type { LearnerQuestion, Question } from '@/features/questions/types';
import { type Answers, emptyAnswer } from '@/features/quizzes/grade';
import { useLiveQuizQuestions } from '@/features/quizzes/liveQuizReads';
import { QuizSplit } from '@/features/quizzes/QuizSplit';
import { m } from '@/i18n';
import { answered, TAKE_PANE, TakeQuestion } from './AssignmentTake';
import { NumberStrip, QuestionNumbers } from './QuestionNumbers';

/** Preview (Epo 2026-11-15, a header button since the graded quiz's tabs
 * became Questions | Responses | Settings, and beside a practice quiz's
 * Study): what members get, in a large dialog, full screen on phones. */
export function PreviewDialog({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <SimpleDialog
      cardClassName="h-full"
      cardScrollContainerClassName="max-sm:pb-0 sm:overflow-hidden"
      className="flex h-[88dvh] flex-col gap-0"
      onClose={onClose}
      open
      title={m.assignment_preview()}
      width={1200}
    >
      {/* The split runs to the card's edges, under a line below the title. */}
      <div className="-mx-4 -mb-5 flex min-h-0 flex-1 flex-col border-divider border-t sm:-mx-5.5 sm:-mb-6.5">
        {children}
      </div>
    </SimpleDialog>
  );
}

/** A quiz file's Preview, loaded as it opens (a practice quiz's header). */
export function QuizPreviewDialog({
  onClose,
  quizId,
}: {
  onClose: () => void;
  quizId: string;
}) {
  return (
    <PreviewDialog onClose={onClose}>
      <QuizFilePreview quizId={quizId} />
    </PreviewDialog>
  );
}

/**
 * A graded quiz as its members answer it, for its staff (Epo 2026-11-13 A):
 * the question numbers and one question at a time, laid out as the member's
 * page. Answers stay here; there is no clock, Bookmark or Submit, and nothing
 * is saved.
 */
export function AssignmentPreview({
  questions,
}: {
  questions: (Question | LearnerQuestion)[];
}) {
  const [answers, setAnswers] = useState<Answers>({});
  const [index, setIndex] = useState(0);
  const question = questions[index];
  // An ordering part always shows an order, so showing it is answering it.
  useEffect(() => {
    if (!question) return;
    setAnswers((current) => {
      const seeded = question.parts.filter(
        (part) => part.answer.type === 'ordering' && !current[part.id]
      );
      if (!seeded.length) return current;
      return {
        ...current,
        ...Object.fromEntries(
          seeded.map((part) => [part.id, emptyAnswer(part)])
        ),
      };
    });
  }, [question]);
  const isAnswered = (q: Question | LearnerQuestion) =>
    q.parts.some((part) => answered(answers[part.id]));
  const isComplete = (q: Question | LearnerQuestion) =>
    q.parts.every((part) => answered(answers[part.id]));
  const go = (next: number) => setIndex(next);
  const open = (id: string) => go(questions.findIndex((q) => q.id === id));
  const items = questions.map((q) => ({
    id: q.id,
    state: isComplete(q)
      ? ('complete' as const)
      : isAnswered(q)
        ? ('answered' as const)
        : ('empty' as const),
  }));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <QuizSplit
        current={question?.id}
        // The dialog runs the list to its bottom edge (Epo 2026-11-19).
        listClassName="pb-6"
        numbers={
          <QuestionNumbers current={question?.id} items={items} onOpen={open} />
        }
        onBack={() => undefined}
        onOpen={open}
        onQuestion
        phoneStrip={
          <NumberStrip current={question?.id} items={items} onOpen={open} />
        }
        questions={questions}
      >
        <div className={TAKE_PANE}>
          {question && (
            <TakeQuestion
              answers={answers}
              key={question.id}
              number={index + 1}
              onChange={(partId, value) =>
                setAnswers((current) => ({ ...current, [partId]: value }))
              }
              question={question}
            >
              <div className="mt-3 flex items-center justify-end gap-2">
                <Button
                  disabled={index === 0}
                  iconLeft="arrowLeft"
                  onClick={() => go(index - 1)}
                  variant="outline"
                >
                  {m.action_previous()}
                </Button>
                <Button
                  disabled={index === questions.length - 1}
                  iconRight="arrowRight"
                  onClick={() => go(index + 1)}
                >
                  {m.action_next()}
                </Button>
              </div>
            </TakeQuestion>
          )}
        </div>
      </QuizSplit>
    </div>
  );
}

const NONE: LearnerQuestion[] = [];

/** A quiz file as members would get it (a draft's on Publish, a practice
 * quiz's on Study), read as the quiz page reads it (the stored questions,
 * then the live room's), and only the questions with answers, which
 * publishing freezes (D4). */
export function QuizFilePreview({ quizId }: { quizId: string }) {
  const { data } = useQuiz(quizId, { errorBoundary: false, fresh: true });
  const stored = data?.questions ?? NONE;
  const live = useLiveQuizQuestions(quizId, stored, !!data);
  const kept = new Set(stored.map((question) => question.id));
  return (
    <AssignmentPreview
      questions={live.filter((question) => kept.has(question.id))}
    />
  );
}
