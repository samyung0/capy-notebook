import { type ReactNode, useContext, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { FileBanner } from '@/components/banners/FileBanner';
import { isOutdatedBanner, SaveBanner } from '@/components/banners/SaveBanner';
import { Skeleton } from '@/components/ui/feedback';
import { CollaborationHold } from '@/features/collaboration/CollaborationHold';
import { itemEditingStopped } from '@/features/collaboration/itemRoom';
import {
  itemSaveState,
  UndoButtons,
} from '@/features/collaboration/LiveItemControls';
import { FileActionsTarget } from '@/features/files/fileModeContext';
import type { NoteEditorStatus } from '@/features/notes/editorMode';
import { m } from '@/i18n';
import { useQuizQuestions, useQuizRooms } from './liveQuizRooms';
import { QuizForm, QuizRecovery } from './QuizForm';
import { QuizQuestionList } from './QuizPage';

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
  onStatusChange,
}: {
  quizId: string;
  title: string;
  /** Sits right of the title. */
  action?: ReactNode;
  onStatusChange?: (status: NoteEditorStatus | null) => void;
}) {
  const rooms = useQuizRooms(quizId, { edit: true });
  const questions = useQuizQuestions(rooms.content?.doc, rooms.keys?.doc);
  const headerActions = useContext(FileActionsTarget);
  useEffect(() => {
    const saveState = rooms.recovery
      ? 'error'
      : itemSaveState(rooms.status, rooms.offline);
    onStatusChange?.(saveState ? { saveState } : null);
  }, [rooms.status, rooms.recovery, rooms.offline, onStatusChange]);
  useEffect(() => () => onStatusChange?.(null), [onStatusChange]);

  if (rooms.status === 'unavailable')
    return <p role="alert">{m.material_ref_unavailable()}</p>;
  return (
    <div className="flex flex-col gap-7">
      {rooms.undo &&
        headerActions &&
        !itemEditingStopped(rooms.offline) &&
        createPortal(
          <UndoButtons header manager={rooms.undo} />,
          headerActions
        )}
      <div className="flex items-baseline gap-4">
        <h1 className="t-large-card-title min-w-0 flex-1">{title}</h1>
        {action}
      </div>
      {rooms.recovery ? (
        <QuizRecovery recovery={rooms.recovery} rooms={rooms} />
      ) : rooms.ready ? (
        rooms.access !== 'write' || itemEditingStopped(rooms.offline) ? (
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
          <Skeleton className="h-64 w-full" />
        )
      ) : isOutdatedBanner(rooms.offline) ? (
        // Refused as outdated before it synced: nothing of the rooms to show.
        <SaveBanner state="outdated" />
      ) : rooms.status === 'offline' ? (
        // Opened offline (or the server failed): it joins once back.
        <QueryPausedState />
      ) : (
        <Skeleton className="h-64 w-full" />
      )}
    </div>
  );
}
