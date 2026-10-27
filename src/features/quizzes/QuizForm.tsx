import { lazy, Suspense, useState } from 'react';
import type * as Y from 'yjs';
import { uploadEditorAsset } from '@/api/editorAssets';
import type { Question } from '@/api/types';
import { recoveryBanner, SaveBanner } from '@/components/banners/SaveBanner';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import type { ItemRoomStatus } from '@/features/collaboration/itemRoom';
import type { UndoTarget } from '@/features/collaboration/undo';
import type { UploadQuestionAsset } from '@/features/questions/BlockEditor';
import { IssueSummary } from '@/features/questions/IssueViews';
import { issueMessages, questionIssues } from '@/features/questions/issues';
import { blankQuestion } from '@/features/questions/types';
import { validateQuestion } from '@/features/questions/validation';
import { m } from '@/i18n';
import { removeQuestion, writeQuestion } from './liveQuiz';
import { type QuizRooms, useQuizQuestions } from './liveQuizRooms';
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
  return async (file, signal) => {
    // Compressed by the upload itself.
    const { assetId } = await uploadEditorAsset(quizId, file, 'image', {
      signal,
    });
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
  // The question waiting on the remove confirmation (main 621c3dd0).
  const [removing, setRemoving] = useState<string | null>(null);
  const remove = (id: string) => {
    if (questions.length <= 1 && onEmpty) return onEmpty();
    removeQuestion(content, keys, id);
  };
  // Edit (ghost-hover) and Remove (danger-light) on a row under each
  // question, at the right.
  const actions = (item: Question) => (
    <div className="flex justify-end">
      <Button
        className="h-7 gap-1 px-2.5 text-xs sm:h-7.5 sm:gap-1.75 sm:px-4 sm:text-sm"
        // The tour opens the first question's dialog through it.
        data-question-edit
        iconLeft="pencil"
        onClick={() => setEditing({ blank: false, id: item.id })}
        rounded="large"
        size="sm"
        type="button"
        variant="ghost-hover"
      >
        {m.action_edit()}
      </Button>
      <Button
        className="h-7 gap-1 px-2.5 text-xs sm:h-7.5 sm:gap-1.75 sm:px-4 sm:text-sm"
        iconLeft="trash"
        onClick={() => setRemoving(item.id)}
        rounded="large"
        size="sm"
        type="button"
        variant="danger-light"
      >
        {m.action_remove()}
      </Button>
    </div>
  );
  const close = () => {
    if (editing?.blank) removeQuestion(content, keys, editing.id);
    setEditing(null);
  };
  return (
    <div className="grid gap-10">
      <QuizQuestionList
        disabled
        questions={questions}
        renderAfter={(item) => (
          <>
            {/* Learners see every question as typed; only complete ones are
                projected and marked (D4, Epo 2026-10-10). */}
            <IssueSummary messages={issueMessages(questionIssues(item))} />
            {actions(item)}
          </>
        )}
      />
      <Button
        className="w-full max-w-xs justify-self-center"
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
      <ConfirmDialog
        body={m.quiz_remove_question_confirm_body()}
        confirmLabel={m.action_remove()}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) remove(removing);
        }}
        open={removing !== null}
        title={m.quiz_remove_question_confirm_title()}
      />
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

/** A quiz's stored edits that cannot join its rooms (refused, or left
 * behind by a room that moved on), read-only to copy until Reload, as a
 * note's are (Epo 2026-10-04). A document without such edits reads live. */
export function QuizRecovery({
  recovery,
  rooms,
}: {
  recovery: NonNullable<QuizRooms['recovery']>;
  rooms: QuizRooms;
}) {
  const questions = useQuizQuestions(
    recovery.content?.doc ?? rooms.content?.doc,
    recovery.keys?.doc ?? rooms.keys?.doc
  );
  const state = recoveryBanner({
    expired: !!(recovery.content?.expired || recovery.keys?.expired),
    refused: !!(recovery.content?.refused || recovery.keys?.refused),
  });
  return (
    <div className="grid gap-6">
      <SaveBanner onReload={recovery.reload} state={state} />
      <QuizQuestionList disabled questions={questions} showAnswerKey />
    </div>
  );
}
