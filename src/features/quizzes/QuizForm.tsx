import { lazy, Suspense, useState } from 'react';
import type * as Y from 'yjs';
import { editorImageMaxBytes, uploadEditorAsset } from '@/api/editorAssets';
import type { Question } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import type { ItemRoomStatus } from '@/features/collaboration/itemRoom';
import type { UndoTarget } from '@/features/collaboration/undo';
import type { UploadQuestionAsset } from '@/features/questions/BlockEditor';
import { blankQuestion } from '@/features/questions/types';
import { validateQuestion } from '@/features/questions/validation';
import { m } from '@/i18n';
import { fitImage } from '@/lib/fitImage';
import { incompleteLine } from './incomplete';
import { removeQuestion, writeQuestion } from './liveQuiz';
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

/** A picked image uploads at once and goes into the question as its asset
 * (Epo 2026-10-10, D6); an abandoned pick goes to the hidden trash at the
 * next projection. */
export function quizImageUpload(quizId: string): UploadQuestionAsset {
  return async (file) => {
    const fitted = await fitImage(file, await editorImageMaxBytes(quizId));
    const { assetId } = await uploadEditorAsset(quizId, fitted, 'image');
    return { assetId };
  };
}

/** The live quiz editor's question list (Epo 2026-10-10): each question as
 * learners see it, with a line under an incomplete one saying what it lacks,
 * Edit and Remove, then Add question. Every change writes to the quiz's
 * documents at once; there is no Save. A question added and closed blank
 * goes. */
export function QuizForm({
  quizId,
  name,
  questions,
  content,
  keys,
  status,
  undo,
  onEmpty,
}: {
  quizId: string;
  name: string;
  questions: Question[];
  content: Y.Doc;
  keys: Y.Doc;
  status: ItemRoomStatus;
  undo: UndoTarget | null;
  /** Inside a note: removing the last question removes the embed block. */
  onEmpty?: () => void;
}) {
  const [editing, setEditing] = useState<{
    /** Added by this Add question and not written to since. */
    blank: boolean;
    id: string;
  } | null>(null);
  const question = editing && questions.find((q) => q.id === editing.id);
  const remove = (id: string) => {
    if (questions.length <= 1 && onEmpty) return onEmpty();
    removeQuestion(content, keys, id);
  };
  const close = () => {
    if (editing?.blank) removeQuestion(content, keys, editing.id);
    setEditing(null);
  };
  return (
    <div className="grid gap-10">
      <QuizQuestionList
        disabled
        questions={questions}
        renderAfter={(item) => {
          const incomplete = incompleteLine(item);
          return (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {incomplete && (
                <p
                  className="mr-auto flex items-start gap-1.5 text-sm text-tint-warning-fg"
                  role="status"
                >
                  <Icon className="mt-0.5 size-4 shrink-0" name="alert" />
                  {incomplete}
                </p>
              )}
              <Button
                className="h-7 gap-1 px-2.5 text-xs sm:h-7.5 sm:gap-1.75 sm:px-4 sm:text-sm"
                iconLeft="pencil"
                iconLeftClassName="size-3.5 sm:size-3.75"
                onClick={() => setEditing({ blank: false, id: item.id })}
                rounded="large"
                size="sm"
                type="button"
                variant="outline"
              >
                {m.action_edit()}
              </Button>
              <Button
                className="h-7 gap-1 px-2.5 text-xs sm:h-7.5 sm:gap-1.75 sm:px-4 sm:text-sm"
                iconLeft="trash"
                iconLeftClassName="size-3.5 sm:size-3.75"
                onClick={() => remove(item.id)}
                rounded="large"
                size="sm"
                type="button"
                variant="danger-outline"
              >
                {m.action_remove()}
              </Button>
            </div>
          );
        }}
      />
      <Button
        fullWidth
        iconLeft="plus"
        onClick={() => {
          const added = blankQuestion();
          writeQuestion(content, keys, added);
          setEditing({ blank: true, id: added.id });
        }}
        rounded="large"
        type="button"
        variant="outline"
      >
        {m.quiz_add_question()}
      </Button>
      {question && (
        <Suspense fallback={null}>
          <QuestionDialog
            context={name}
            live={{
              status,
              undo,
              write: (next) => {
                setEditing(
                  (current) => current && { ...current, blank: false }
                );
                writeQuestion(content, keys, next);
              },
            }}
            onClose={close}
            open
            question={question}
            questionNumber={
              questions.findIndex((q) => q.id === question.id) + 1
            }
            uploadAsset={quizImageUpload(quizId)}
          />
        </Suspense>
      )}
    </div>
  );
}
