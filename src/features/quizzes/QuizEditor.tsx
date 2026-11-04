import {
  lazy,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type * as Y from 'yjs';
import { QUIZ_OPEN_PARTS_MAX } from '@/api/limits.generated';
import type { Question } from '@/api/types';
import { FileBanner } from '@/components/banners/FileBanner';
import { isOutdatedBanner, SaveBanner } from '@/components/banners/SaveBanner';
import { Skeleton } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { CollaborationHold } from '@/features/collaboration/CollaborationHold';
import type { RoomCopy } from '@/features/collaboration/deviceCopy';
import {
  type ItemRoomStatus,
  itemEditingStopped,
} from '@/features/collaboration/itemRoom';
import {
  itemSaveState,
  UndoButtons,
} from '@/features/collaboration/LiveItemControls';
import {
  type PresenceConnection,
  useReportPresence,
} from '@/features/collaboration/presence';
import type { UndoTarget } from '@/features/collaboration/undo';
import { FileActionsTarget } from '@/features/files/fileModeContext';
import type { NoteEditorStatus } from '@/features/notes/editorMode';
import { issueMessages, questionIssues } from '@/features/questions/issues';
import {
  blankQuestion,
  type LearnerQuestion,
  questionMarks,
} from '@/features/questions/types';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { moveQuestion, removeQuestion, writeQuestion } from './liveQuiz';
import { useQuizQuestions, useQuizRooms } from './liveQuizRooms';
import { QuizRecovery, quizImageUpload } from './QuizForm';
import { QuizQuestionList } from './QuizPage';

const QuestionPane = lazy(() =>
  import('./QuestionPane').then((module) => ({
    default: module.QuestionPane,
  }))
);

/** The quiz's AI-marked (open) parts against the cap. */
export function aiMarkedCount(questions: Question[]): string {
  const open = questions
    .flatMap((question) => question.parts)
    .filter((part) => part.answer.type === 'open').length;
  return m.quiz_ai_marked_count({ count: open, max: QUIZ_OPEN_PARTS_MAX });
}

/** A question's row text: its first words as written. */
function questionSummary(question: Question): string {
  const blocks = [
    ...question.stem,
    ...(question.groups?.flatMap((group) => group.blocks) ?? []),
    ...question.parts.flatMap((part) => part.blocks),
  ];
  for (const block of blocks)
    if (block.type === 'text' && block.text.trim()) return block.text.trim();
  return m.quiz_editor_untitled();
}

/** The quiz as a page (Epo 2026-11-02, board X2): the plain question list on
 * the left, the open question's fields on the right, each change written to
 * the quiz's documents at once. Phones have room for one: the list, then the
 * question with a way back to it. A question added and left blank goes. */
function QuizEditorBody({
  content,
  keys,
  questions,
  quizId,
  sources,
  status,
  target,
  title,
  undo,
}: {
  content: Y.Doc;
  keys: Y.Doc;
  questions: Question[];
  quizId: string;
  sources: ReactNode;
  status: ItemRoomStatus;
  /** A question a link opens at (a review summary's). */
  target?: string;
  title: string;
  undo: UndoTarget | null;
}) {
  const [picked, setPicked] = useState<string | null>(target ?? null);
  // Set while the added question hasn't been written to.
  const [blank, setBlank] = useState<string | null>(null);
  const [phoneOnQuestion, setPhoneOnQuestion] = useState(!!target);
  const index = Math.max(
    0,
    questions.findIndex((question) => question.id === picked)
  );
  const question = questions[index];
  const open = (id: string) => {
    if (blank && blank !== id) removeQuestion(content, keys, blank);
    setBlank(null);
    setPicked(id);
    setPhoneOnQuestion(true);
  };
  return (
    <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] md:grid-cols-[300px_minmax(0,1fr)]">
      <nav
        aria-label={m.question_ui_questions()}
        className={cn(
          'flex min-h-0 flex-col gap-px overflow-y-auto p-2.5 md:border-divider md:border-r',
          phoneOnQuestion && 'max-md:hidden'
        )}
      >
        <div className="flex items-center px-1.5 pt-0.5 pb-1.5">
          <p className="min-w-0 font-bold text-[11px] text-fg-muted uppercase leading-none tracking-[.06rem]">
            {m.quiz_editor_questions({ count: questions.length })}
          </p>
          <span className="ml-auto" />
          <ToolbarButton
            label={m.quiz_add_question()}
            onClick={() => {
              const added = blankQuestion();
              writeQuestion(content, keys, added);
              open(added.id);
              setBlank(added.id);
            }}
          >
            <Icon name="plus" />
          </ToolbarButton>
        </div>
        {questions.map((item, i) => {
          const issues = issueMessages(questionIssues(item));
          const on = item.id === question?.id;
          return (
            <button
              aria-current={on || undefined}
              className={cn(
                'grid min-h-9 w-full cursor-pointer grid-cols-[22px_minmax(0,1fr)_auto_20px] items-center gap-2 rounded-lg px-2 py-1 text-left text-[13.5px] outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action',
                on && 'bg-page-hover hover:bg-page-hover'
              )}
              data-question-row={item.id}
              key={item.id}
              onClick={() => open(item.id)}
              type="button"
            >
              <span className="font-bold text-fg-secondary">{i + 1}</span>
              <span
                className={cn('truncate', issues.length === 0 && 'col-span-2')}
              >
                {questionSummary(item)}
              </span>
              {issues.length > 0 && (
                <span
                  aria-label={m.quiz_editor_has_issue()}
                  className="inline-flex text-tint-warning-fg"
                  role="img"
                >
                  <Icon className="size-4" name="alert" />
                </span>
              )}
              <span className="text-right text-fg-muted text-xs">
                {questionMarks(item)}
              </span>
            </button>
          );
        })}
        <div className="mt-auto flex flex-col gap-2 px-2 pt-3 pb-1">
          {/* A whole past paper is seen to fit (Epo 2026-11-03). */}
          <p className="t-meta text-fg-muted">{aiMarkedCount(questions)}</p>
          {sources}
        </div>
      </nav>
      <div
        className={cn(
          'min-h-0 min-w-0 overflow-y-auto',
          !phoneOnQuestion && 'max-md:hidden'
        )}
      >
        <button
          className="mx-4 mt-3 inline-flex cursor-pointer items-center gap-1.5 font-semibold text-fg-secondary underline md:hidden"
          onClick={() => setPhoneOnQuestion(false)}
          type="button"
        >
          <Icon name="navigationBack" size={16} />
          {m.quiz_editor_all_questions()}
        </button>
        {question && (
          <Suspense fallback={<Skeleton className="m-4 h-64" />}>
            <QuestionPane
              canMoveDown={index < questions.length - 1}
              canMoveUp={index > 0}
              context={title}
              key={question.id}
              number={index + 1}
              onMove={(direction) =>
                moveQuestion(content, question.id, index + direction)
              }
              onRemove={() => {
                const next = questions[index + 1] ?? questions[index - 1];
                removeQuestion(content, keys, question.id);
                setBlank(null);
                setPicked(next?.id ?? null);
              }}
              question={question}
              status={status}
              undo={undo}
              uploadAsset={quizImageUpload(quizId)}
              write={(next) => {
                setBlank(null);
                writeQuestion(content, keys, next);
              }}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

/**
 * A quiz edited on its material page, live (Epo 2026-10-10): questions edit
 * the quiz's content and keys documents as they are typed, with no Save or
 * Reset. The rooms' state goes to the header's save status like a note's,
 * Undo and Redo sit in the header with Study, unsent edits stay on this
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
  sources,
  stored,
  target,
}: {
  /** The device copy its rooms start from. */
  copy: RoomCopy;
  /** The questions as its read holds them, painted until the rooms sync. */
  stored: LearnerQuestion[];
  quizId: string;
  /** A question a link opens at, e.g. from a review summary. */
  target?: string;
  title: string;
  /** Beside Undo and Redo in the header. */
  action?: ReactNode;
  /** Under the question list, or at the end of the column. */
  sources?: ReactNode;
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
  // Once its question shows in the paint, and again as the page replaces it:
  // the page opens that question, its list row may be out of view.
  const scrolledTo = useRef<string | null>(null);
  const place = `${target}:${!!(rooms.ready && rooms.content && rooms.keys)}`;
  useEffect(() => {
    if (!target || scrolledTo.current === place) return;
    const id = CSS.escape(target);
    const question = document.querySelector(
      `[data-question-id="${id}"], [data-question-row="${id}"]`
    );
    if (!question) return;
    scrolledTo.current = place;
    question.scrollIntoView({ block: 'start' });
  });

  if (rooms.status === 'unavailable')
    return <p role="alert">{m.material_ref_unavailable()}</p>;
  // Everything but the live page: one column under the header's title.
  const column = (children: ReactNode) => (
    <div className="h-full overflow-y-auto px-4 py-6 sm:px-10">
      <div className="mx-auto flex max-w-205 flex-col gap-6">
        {children}
        <div className="mt-10 empty:hidden">{sources}</div>
      </div>
    </div>
  );
  return (
    <>
      {/* The header names it for the eye; the page's one h1 stays its title. */}
      <h1 className="sr-only">{title}</h1>
      {headerActions &&
        createPortal(
          <>
            {rooms.undo && !itemEditingStopped(rooms) && (
              <UndoButtons header manager={rooms.undo} />
            )}
            {action && <span className="ml-2">{action}</span>}
          </>,
          headerActions
        )}
      {rooms.recovery ? (
        column(<QuizRecovery recovery={rooms.recovery} rooms={rooms} />)
      ) : rooms.ready &&
        (rooms.access !== 'write' || itemEditingStopped(rooms)) ? (
        column(
          <>
            {rooms.readOnlyCode === 'unsupported_block' && (
              <FileBanner message={m.editor_unsupported_block_strip()} />
            )}
            {rooms.offline && <SaveBanner state={rooms.offline} />}
            <QuizQuestionList
              disabled
              questions={questions}
              showAnswerKey={rooms.access === 'write'}
            />
          </>
        )
      ) : rooms.ready && rooms.content && rooms.keys ? (
        <div className="flex h-full min-h-0 flex-col">
          {rooms.offline && <SaveBanner state={rooms.offline} />}
          <CollaborationHold className="flex min-h-0 flex-1 flex-col">
            <QuizEditorBody
              content={rooms.content.doc}
              keys={rooms.keys.doc}
              questions={questions}
              quizId={quizId}
              sources={sources}
              status={rooms.status}
              target={target}
              title={title}
              undo={rooms.undo}
            />
          </CollaborationHold>
        </div>
      ) : (
        // Until they sync (Epo 2026-11-04): what the device copy holds, else
        // what the read holds.
        column(
          <>
            {isOutdatedBanner(rooms.offline) && <SaveBanner state="outdated" />}
            <QuizQuestionList<Question | LearnerQuestion>
              disabled
              questions={questions.length ? questions : stored}
            />
          </>
        )
      )}
    </>
  );
}
