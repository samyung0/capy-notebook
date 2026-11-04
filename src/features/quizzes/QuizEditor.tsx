import { type ReactNode, useContext, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { QUIZ_OPEN_PARTS_MAX } from '@/api/limits.generated';
import type { Question } from '@/api/types';
import { FileBanner } from '@/components/banners/FileBanner';
import { isOutdatedBanner, SaveBanner } from '@/components/banners/SaveBanner';
import { CollaborationHold } from '@/features/collaboration/CollaborationHold';
import type { RoomCopy } from '@/features/collaboration/deviceCopy';
import { itemEditingStopped } from '@/features/collaboration/itemRoom';
import {
  itemSaveState,
  UndoButtons,
} from '@/features/collaboration/LiveItemControls';
import {
  type PresenceConnection,
  useReportPresence,
} from '@/features/collaboration/presence';
import { FileActionsTarget } from '@/features/files/fileModeContext';
import type { NoteEditorStatus } from '@/features/notes/editorMode';
import type { LearnerQuestion } from '@/features/questions/types';
import { m } from '@/i18n';
import { useQuizQuestions, useQuizRooms } from './liveQuizRooms';
import { QuizForm, QuizRecovery } from './QuizForm';
import { QuizQuestionList } from './QuizPage';

/** The quiz's questions and its AI-marked (open) parts against the cap, so
 * a whole past paper is seen to fit (Epo 2026-11-03). */
export function quizCounts(questions: Question[]): string {
  const open = questions
    .flatMap((question) => question.parts)
    .filter((part) => part.answer.type === 'open').length;
  return [
    m.question_ui_question_count({ count: questions.length }),
    m.quiz_ai_marked_count({ count: open, max: QUIZ_OPEN_PARTS_MAX }),
  ].join(' · ');
}

/**
 * A quiz edited on its material page, live (Epo 2026-10-10): questions edit
 * the quiz's content and keys documents as they are typed, with no Save or
 * Reset. The rooms' state goes to the header's save status like a note's,
 * Undo and Redo sit in the header beside View, unsent edits stay on this
 * device (an offline banner; refused or left behind, they show read-only to
 * copy until Reload), and a room turned read-only shows the questions to
 * read. A note's embed edits through its own rooms (AppEmbed).
 */
export function QuizEditor({
  quizId,
  title,
  action,
  copy,
  onPresenceChange,
  onStatusChange,
  stored,
  target,
}: {
  /** The device copy its rooms start from. */
  copy: RoomCopy;
  /** The questions as its read holds them, painted until the rooms sync. */
  stored: LearnerQuestion[];
  quizId: string;
  /** A question to scroll to, e.g. from a review summary. */
  target?: string;
  title: string;
  /** Sits right of the title. */
  action?: ReactNode;
  /** The room's other editors, for the header's avatar group. */
  onPresenceChange?: (connections: PresenceConnection[] | null) => void;
  onStatusChange?: (status: NoteEditorStatus | null) => void;
}) {
  const rooms = useQuizRooms(quizId, { copy, edit: true });
  const questions = useQuizQuestions(rooms.content?.doc, rooms.keys?.doc);
  const headerActions = useContext(FileActionsTarget);
  useEffect(() => {
    const saveState = rooms.recovery
      ? 'error'
      : itemSaveState(rooms.status, rooms.offline, rooms.sending);
    onStatusChange?.(saveState ? { saveState, slowed: rooms.slowed } : null);
  }, [
    rooms.status,
    rooms.recovery,
    rooms.offline,
    rooms.sending,
    rooms.slowed,
    onStatusChange,
  ]);
  useEffect(() => () => onStatusChange?.(null), [onStatusChange]);
  useReportPresence(onPresenceChange, rooms.presence);
  // Once its question shows, and again as the editor replaces the paint: its
  // Edit rows move it.
  const scrolledTo = useRef<string | null>(null);
  const place = `${target}:${!!(rooms.ready && rooms.content && rooms.keys)}`;
  useEffect(() => {
    if (!target || scrolledTo.current === place) return;
    const question = document.querySelector(
      `[data-question-id="${CSS.escape(target)}"]`
    );
    if (!question) return;
    scrolledTo.current = place;
    question.scrollIntoView({ block: 'start' });
  });

  if (rooms.status === 'unavailable')
    return <p role="alert">{m.material_ref_unavailable()}</p>;
  // Until they sync (Epo 2026-11-04): what the device copy holds, else what the
  // read holds; the Edit and Remove rows join them.
  const painted = (
    <div className="grid gap-6">
      {isOutdatedBanner(rooms.offline) && <SaveBanner state="outdated" />}
      <QuizQuestionList<Question | LearnerQuestion>
        disabled
        questions={questions.length ? questions : stored}
      />
    </div>
  );
  return (
    <div className="flex flex-col gap-7">
      {rooms.undo &&
        headerActions &&
        !itemEditingStopped(rooms) &&
        createPortal(
          <UndoButtons header manager={rooms.undo} />,
          headerActions
        )}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-4">
          <h1 className="t-large-card-title min-w-0 flex-1">{title}</h1>
          {action}
        </div>
        {rooms.ready && (
          <p className="t-meta text-fg-muted">{quizCounts(questions)}</p>
        )}
      </div>
      {rooms.recovery ? (
        <QuizRecovery recovery={rooms.recovery} rooms={rooms} />
      ) : rooms.ready ? (
        rooms.access !== 'write' || itemEditingStopped(rooms) ? (
          <div className="grid gap-6">
            {rooms.readOnlyCode === 'unsupported_block' && (
              <FileBanner message={m.editor_unsupported_block_strip()} />
            )}
            {rooms.offline && <SaveBanner state={rooms.offline} />}
            <QuizQuestionList
              disabled
              questions={questions}
              showAnswerKey={rooms.access === 'write'}
            />
          </div>
        ) : rooms.content && rooms.keys ? (
          <div className="grid gap-6">
            {rooms.offline && <SaveBanner state={rooms.offline} />}
            <CollaborationHold>
              <QuizForm
                content={rooms.content.doc}
                keys={rooms.keys.doc}
                name={title}
                questions={questions}
                quizId={quizId}
                status={rooms.status}
                undo={rooms.undo}
              />
            </CollaborationHold>
          </div>
        ) : (
          painted
        )
      ) : (
        painted
      )}
    </div>
  );
}
