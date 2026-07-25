import { useEffect, useState } from 'react';
import type { Question } from '@/api/types';
import { Button, Input, SimpleDialog, Text } from '@/components/ui';
import { parseQuizFenceBody } from '@/features/materials/blocks';
import {
  createBlankQuestion,
  isCompleteQuestion,
  QuizForm,
} from '@/features/quizzes/QuizForm';
import { quizFenceBody } from './shared';

/** Popup to author a typed ```quiz block inline in a note. */
export function QuizDialog({
  open,
  initialCode,
  onSave,
  onClose,
}: {
  open: boolean;
  initialCode?: string;
  onSave: (code: string) => void;
  onClose: () => void;
}) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [timeLimit, setTimeLimit] = useState<string>('');

  useEffect(() => {
    if (!open) return;
    const parsed = initialCode
      ? parseQuizFenceBody(initialCode)
      : { questions: [], timeLimitMin: undefined };
    setQuestions(
      parsed.questions.length
        ? structuredClone(parsed.questions)
        : [createBlankQuestion()]
    );
    setTimeLimit(
      parsed.timeLimitMin == null ? '' : String(parsed.timeLimitMin)
    );
  }, [open, initialCode]);

  const canSave = questions.length > 0 && questions.every(isCompleteQuestion);

  function save() {
    const tl = Number.parseInt(timeLimit, 10);
    onSave(
      quizFenceBody({
        questions,
        timeLimitMin: Number.isFinite(tl) && tl > 0 ? tl : undefined,
      })
    );
  }

  return (
    <SimpleDialog
      footer={
        <>
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={save}>
            {initialCode ? 'Save' : 'Insert'}
          </Button>
        </>
      }
      onClose={onClose}
      open={open}
      title="Quiz"
    >
      <div className="flex max-h-[62vh] flex-col gap-4 overflow-auto pr-1">
        <label className="flex items-center gap-2">
          <Text tone="muted" variant="label">
            Time limit (min, optional)
          </Text>
          <Input
            className="w-24"
            onChange={(e) => setTimeLimit(e.target.value)}
            type="number"
            value={timeLimit}
          />
        </label>
        <QuizForm
          name=""
          onNameChange={() => {}}
          onQuestionsChange={setQuestions}
          questions={questions}
          showName={false}
        />
        {!canSave && (
          <Text tone="muted" variant="meta">
            Complete every question and mark its correct answer before saving.
          </Text>
        )}
      </div>
    </SimpleDialog>
  );
}
