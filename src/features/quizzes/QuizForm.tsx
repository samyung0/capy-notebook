import { lazy, Suspense, useState } from 'react';
import type { Question } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { blankQuestion } from '@/features/questions/types';
import { validateQuestion } from '@/features/questions/validation';
import { m } from '@/i18n';
import { QuizQuestionList } from './QuizPage';

const QuestionDialog = lazy(() =>
  import('@/features/questions/QuestionDialog').then((module) => ({
    default: module.QuestionDialog,
  }))
);

export const createBlankQuestion = blankQuestion;
export function isCompleteQuestion(question: Question): boolean {
  try {
    validateQuestion(question);
    return true;
  } catch {
    return false;
  }
}
/** The quiz editor's question list: each question as learners see it, with
 * Remove and Edit under it, then Add question. */
export function QuizForm({
  name,
  questions,
  onQuestionsChange,
}: {
  name: string;
  questions: Question[];
  onQuestionsChange: (questions: Question[]) => void;
}) {
  const [editing, setEditing] = useState<Question | null>(null);
  return (
    <div className="grid gap-10">
      <QuizQuestionList
        disabled
        questions={questions}
        renderAfter={(question) => (
          <div className="flex justify-end gap-0.5 sm:gap-1.5">
            <Button
              className="h-7 gap-1 rounded-input px-2.5 text-xs sm:h-7.5 sm:gap-1.75 sm:px-4 sm:text-sm"
              iconLeft="trash"
              iconLeftClassName="size-3.5 sm:size-3.75"
              onClick={() =>
                onQuestionsChange(questions.filter((q) => q.id !== question.id))
              }
              size="sm"
              type="button"
              variant="danger-light"
            >
              {m.action_remove()}
            </Button>
            <Button
              className="h-7 gap-1 rounded-input px-2.5 text-xs sm:h-7.5 sm:gap-1.75 sm:px-4 sm:text-sm"
              iconLeft="pencil"
              iconLeftClassName="size-3.5 sm:size-3.75"
              onClick={() => setEditing(question)}
              size="sm"
              type="button"
              variant="ghost-hover"
            >
              {m.action_edit()}
            </Button>
          </div>
        )}
      />
      <Button
        className="rounded-input"
        fullWidth
        iconLeft="plus"
        onClick={() => setEditing(blankQuestion())}
        type="button"
        variant="outline"
      >
        {m.quiz_add_question()}
      </Button>
      {editing && (
        <Suspense fallback={null}>
          <QuestionDialog
            context={name}
            onClose={() => setEditing(null)}
            onSave={(next) => {
              const existing = questions.some((q) => q.id === next.id);
              onQuestionsChange(
                existing
                  ? questions.map((q) => (q.id === next.id ? next : q))
                  : [...questions, next]
              );
              setEditing(null);
            }}
            open
            question={editing}
            questionNumber={
              questions.some((q) => q.id === editing.id)
                ? questions.findIndex((q) => q.id === editing.id) + 1
                : questions.length + 1
            }
          />
        </Suspense>
      )}
    </div>
  );
}
