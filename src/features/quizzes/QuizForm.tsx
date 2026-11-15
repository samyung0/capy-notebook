import { lazy, Suspense, useState } from 'react';
import type * as Y from 'yjs';
import { uploadEditorAsset } from '@/api/editorAssets';
import type { Question } from '@/api/types';
import { recoveryBanner, SaveBanner } from '@/components/banners/SaveBanner';
import { Skeleton } from '@/components/ui/feedback';
import type { ItemRoomStatus } from '@/features/collaboration/itemRoom';
import {
  LiveStatus,
  UndoButtons,
} from '@/features/collaboration/LiveItemControls';
import type { UndoTarget } from '@/features/collaboration/undo';
import type { UploadQuestionAsset } from '@/features/questions/BlockEditor';
import { duplicateQuestion } from '@/features/questions/questionEdits';
import { blankQuestion } from '@/features/questions/types';
import { validateQuestion } from '@/features/questions/validation';
import { quizSampleUpload } from './drawing/DrawnSample';
import { moveQuestion, removeQuestion, writeQuestion } from './liveQuiz';
import { type QuizRooms, useQuizQuestions } from './liveQuizRooms';
import { QuizQuestionList } from './QuizPage';

const QuestionPane = lazy(() =>
  import('./QuestionPane').then((module) => ({
    default: module.QuestionPane,
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

/** A note's quiz in Edit (Epo 2026-11-15, in place of the question dialog):
 * the quiz page's cards in the note, the open one editing in place, Undo,
 * Redo and the live state above them. Every change writes to the quiz's
 * documents at once; removing the last question removes the block. */
export function QuizForm({
  content,
  keys,
  onEmpty,
  questions,
  quizId,
  status,
  undo,
}: {
  content: Y.Doc;
  keys: Y.Doc;
  /** Removing the last question removes the embed block. */
  onEmpty?: () => void;
  questions: Question[];
  quizId: string;
  status: ItemRoomStatus;
  undo: UndoTarget | null;
}) {
  const [picked, setPicked] = useState<string>();
  // A question just added, whose text opens in its editor.
  const [fresh, setFresh] = useState<string>();
  // A new question goes right after `index`, as Google Forms adds one.
  const place = (question: Question, index: number) => {
    writeQuestion(content, keys, question);
    moveQuestion(content, question.id, index + 1);
    setPicked(question.id);
  };
  const add = (index: number) => {
    const added = blankQuestion();
    setFresh(added.id);
    place(added, index);
  };
  return (
    // The tour opens its first question.
    <div className="grid gap-3" data-note-quiz="">
      <div className="flex items-center justify-end gap-2">
        {undo && <UndoButtons manager={undo} />}
        <LiveStatus status={status} />
      </div>
      <Suspense fallback={<Skeleton className="h-64" />}>
        <QuestionPane
          embedded
          fresh={fresh}
          onAdd={add}
          onDuplicate={(question, index) =>
            place(duplicateQuestion(question), index)
          }
          onMove={(id, index) => moveQuestion(content, id, index)}
          onOpen={setPicked}
          onRemove={(id) => {
            if (questions.length <= 1 && onEmpty) return onEmpty();
            const index = questions.findIndex((q) => q.id === id);
            const next = questions[index + 1] ?? questions[index - 1];
            removeQuestion(content, keys, id);
            if (id === picked) setPicked(next?.id);
          }}
          picked={picked}
          questions={questions}
          uploadAsset={quizImageUpload(quizId)}
          uploadSample={quizSampleUpload(quizId)}
          write={(next) => writeQuestion(content, keys, next)}
        />
      </Suspense>
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
    refused: !!(recovery.content?.refused || recovery.keys?.refused),
  });
  return (
    <div className="grid gap-6">
      <SaveBanner onReload={recovery.reload} state={state} />
      <QuizQuestionList disabled questions={questions} showAnswerKey />
    </div>
  );
}
