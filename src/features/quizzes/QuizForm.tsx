import { lazy, Suspense, useState } from 'react';
import type { Question } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { QuestionView } from '@/features/questions/QuestionView';
import { blankQuestion } from '@/features/questions/types';
import { validateQuestion } from '@/features/questions/validation';
import { m } from '@/i18n';

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
export function QuizForm({
  name,
  questions,
  onNameChange,
  onQuestionsChange,
  showName = true,
}: {
  name: string;
  questions: Question[];
  onNameChange: (name: string) => void;
  onQuestionsChange: (questions: Question[]) => void;
  showName?: boolean;
}) {
  const [editing, setEditing] = useState<Question | null>(null);
  return (
    <div className="flex flex-col gap-6">
      {showName && (
        <Input
          aria-label={m.common_name()}
          onChange={(event) => onNameChange(event.target.value)}
          value={name}
        />
      )}
      {questions.map((question, index) => (
        <section className="border-divider border-b pb-6" key={question.id}>
          <div className="mb-3 flex justify-end gap-2">
            <Button
              onClick={() =>
                onQuestionsChange(questions.filter((q) => q.id !== question.id))
              }
              size="sm"
              type="button"
              variant="ghost"
            >
              {m.action_remove()}
            </Button>
            <Button
              iconLeft="pencil"
              onClick={() => setEditing(question)}
              size="sm"
              type="button"
              variant="ghost"
            >
              {m.action_edit()}
            </Button>
          </div>
          <QuestionView question={question} questionNumber={index + 1} />
        </section>
      ))}
      <Button
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
            questionCount={
              questions.length +
              (questions.some((q) => q.id === editing.id) ? 0 : 1)
            }
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
