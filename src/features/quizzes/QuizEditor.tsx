import {
  lazy,
  type ReactNode,
  type RefObject,
  Suspense,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import * as Y from 'yjs';
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
  modelMarked,
  questionMarks,
} from '@/features/questions/types';
import { m } from '@/i18n';
import {
  moveQuestion,
  questionState,
  removeQuestion,
  removeUnchangedQuestion,
  seedQuiz,
  withEmptyKeys,
  writeQuestion,
} from './liveQuiz';
import { useQuizQuestions, useQuizRooms } from './liveQuizRooms';
import { QuestionRunner } from './QuestionRunner';
import { QuizRecovery, quizImageUpload } from './QuizForm';
import { QuizSplit, useQuizPick } from './QuizSplit';

const QuestionPane = lazy(() =>
  import('./QuestionPane').then((module) => ({
    default: module.QuestionPane,
  }))
);

/** The quiz's AI-marked (open and drawing) parts against the cap. */
export function aiMarkedCount(questions: Question[]): string {
  const open = questions
    .flatMap((question) => question.parts)
    .filter((part) => modelMarked(part.answer.type)).length;
  return m.quiz_ai_marked_count({ count: open, max: QUIZ_OPEN_PARTS_MAX });
}

/** The question added and not written to yet, and what it held when added. */
type BlankQuestion = { id: string; state: string };

/** The quiz as a page (Epo 2026-11-02, board X2): the plain question list on
 * the left, the open question's fields on the right, each change written to
 * the quiz's documents at once. Phones have room for one: the list, then the
 * question with a way back to it. A question added and left blank goes, when
 * another opens or the page goes (`QuizEditor`). */
function QuizEditorBody({
  blank,
  content,
  keys,
  keysPending,
  opening,
  pick,
  questions,
  quizId,
  sources,
  status,
  title,
  undo,
}: {
  blank: RefObject<BlankQuestion | null>;
  content: Y.Doc;
  keys: Y.Doc;
  keysPending?: boolean;
  /** The paint before the rooms sync (`QuizOpeningPaint`). */
  opening?: boolean;
  /** Kept by the page, so the question open in the paint stays open after it. */
  pick: ReturnType<typeof useQuizPick>;
  questions: Question[];
  quizId: string;
  sources: ReactNode;
  status: ItemRoomStatus;
  title: string;
  undo: UndoTarget | null;
}) {
  const { onQuestion, picked, setOnQuestion, setPicked } = pick;
  const index = Math.max(
    0,
    questions.findIndex((question) => question.id === picked)
  );
  const question = questions[index];
  const open = (id: string) => {
    if (blank.current && blank.current.id !== id) {
      removeUnchangedQuestion(content, keys, blank.current);
      blank.current = null;
    }
    pick.open(id);
  };
  return (
    <QuizSplit
      action={
        <ToolbarButton
          disabled={opening}
          label={m.quiz_add_question()}
          onClick={() => {
            const added = blankQuestion();
            writeQuestion(content, keys, added);
            open(added.id);
            blank.current = {
              id: added.id,
              state: questionState(content, keys, added.id),
            };
          }}
        >
          <Icon name="plus" />
        </ToolbarButton>
      }
      current={question?.id}
      foot={
        <>
          {/* A whole past paper is seen to fit (Epo 2026-11-03). */}
          <p className="t-meta text-fg-muted">{aiMarkedCount(questions)}</p>
          {sources}
        </>
      }
      onBack={() => setOnQuestion(false)}
      onOpen={open}
      onQuestion={onQuestion}
      questions={questions}
      rowEnd={(item) => (
        <>
          {!opening && issueMessages(questionIssues(item)).length > 0 && (
            <span
              aria-label={m.quiz_editor_has_issue()}
              className="inline-flex text-tint-warning-fg"
              role="img"
            >
              <Icon className="size-4" name="alert" />
            </span>
          )}
          {questionMarks(item)}
        </>
      )}
    >
      {question && (
        <Suspense fallback={<Skeleton className="m-4 h-64" />}>
          <div className="contents" inert={opening}>
            <QuestionPane
              canMoveDown={index < questions.length - 1}
              canMoveUp={index > 0}
              context={title}
              key={question.id}
              keysPending={keysPending}
              number={index + 1}
              onMove={(direction) =>
                moveQuestion(content, question.id, index + direction)
              }
              onRemove={() => {
                const next = questions[index + 1] ?? questions[index - 1];
                removeQuestion(content, keys, question.id);
                blank.current = null;
                setPicked(next?.id ?? null);
              }}
              opening={opening}
              question={question}
              status={status}
              undo={undo}
              uploadAsset={quizImageUpload(quizId)}
              write={(next) => {
                blank.current = null;
                writeQuestion(content, keys, next);
              }}
            />
          </div>
        </Suspense>
      )}
    </QuizSplit>
  );
}

const NO_ANSWERS = {};

/** The questions as they read, in the quiz's layout: a room that turned read-only
 * or refused, and anyone who only views the quiz. */
export function QuizReadSplit({
  banner,
  paneClassName,
  questions,
  showAnswerKey,
  sources,
  target,
}: {
  banner?: ReactNode;
  paneClassName?: string;
  questions: (Question | LearnerQuestion)[];
  showAnswerKey?: boolean;
  sources?: ReactNode;
  target?: string;
}) {
  const { onQuestion, open, picked, setOnQuestion } = useQuizPick(target);
  const index = Math.max(
    0,
    questions.findIndex((question) => question.id === picked)
  );
  const question = questions[index];
  return (
    <div className="flex h-full min-h-0 flex-col">
      {banner}
      <QuizSplit
        current={question?.id}
        foot={sources}
        onBack={() => setOnQuestion(false)}
        onOpen={open}
        onQuestion={onQuestion}
        paneClassName={paneClassName}
        questions={questions}
        rowEnd={questionMarks}
      >
        {question && (
          <div
            className="mx-auto grid max-w-205 gap-4 px-4 py-6 sm:px-10"
            data-question-id={question.id}
            key={question.id}
          >
            <QuestionRunner
              answers={NO_ANSWERS}
              disabled
              question={question}
              questionNumber={index + 1}
              showAnswerKey={showAnswerKey}
            />
          </div>
        )}
      </QuizSplit>
    </div>
  );
}

/** The opening (Epo 2026-11-06, A): the editor's own page from the first paint.
 * Its list works and its question takes no input until the rooms sync. It draws
 * the device's copy, keys and all, else the read, showing no key it doesn't know. */
function QuizOpeningPaint({
  contentSeed,
  keysSeed,
  pick,
  quizId,
  sources,
  stored,
  title,
}: {
  contentSeed: Y.Doc | null;
  keysSeed: Y.Doc | null;
  pick: ReturnType<typeof useQuizPick>;
  quizId: string;
  sources: ReactNode;
  stored: LearnerQuestion[];
  title: string;
}) {
  const [docs] = useState(() => {
    const content = contentSeed ?? new Y.Doc();
    const keys = keysSeed ?? new Y.Doc();
    if (!contentSeed)
      for (const question of stored)
        try {
          seedQuiz(content, keys, [withEmptyKeys(question)]);
        } catch {
          // A type this version can't draw: the rooms' page says so.
        }
    return { content, keys };
  });
  useEffect(
    () => () => {
      if (!contentSeed) docs.content.destroy();
      if (!keysSeed) docs.keys.destroy();
    },
    [contentSeed, docs, keysSeed]
  );
  const shown = useQuizQuestions(docs.content, docs.keys);
  const blank = useRef<BlankQuestion | null>(null);
  return (
    <div className="flex h-full min-h-0 flex-col" data-quiz-opening="">
      <QuizEditorBody
        blank={blank}
        content={docs.content}
        keys={docs.keys}
        keysPending={!keysSeed}
        opening
        pick={pick}
        questions={shown}
        quizId={quizId}
        sources={sources}
        status="syncing"
        title={title}
        undo={null}
      />
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
  const pick = useQuizPick(target);
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
  // Leaving the page takes a blank added question with it. A layout effect's
  // cleanup, because the rooms' documents go in their passive cleanups; and only
  // while this page can write, since a read-only room refuses the edit.
  const blank = useRef<BlankQuestion | null>(null);
  const leave = useRef(() => {});
  leave.current = () => {
    const { access, content, keys, ready, recovery } = rooms;
    if (!(blank.current && content && keys && ready)) return;
    if (access !== 'write' || recovery || itemEditingStopped(rooms)) return;
    removeUnchangedQuestion(content.doc, keys.doc, blank.current);
  };
  useLayoutEffect(() => () => leave.current(), []);
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

  // Its room refused this person: the page stays as it is, read-only.
  const refused = rooms.status === 'unavailable';
  return (
    <>
      {/* The header names it for the eye; the page's one h1 stays its title. */}
      <h1 className="sr-only">{title}</h1>
      {headerActions &&
        createPortal(
          <>
            {rooms.undo && !refused && !itemEditingStopped(rooms) && (
              <UndoButtons header manager={rooms.undo} />
            )}
            {action && <span className="ml-2">{action}</span>}
          </>,
          headerActions
        )}
      {rooms.recovery ? (
        <div className="h-full overflow-y-auto px-4 py-6 sm:px-10">
          <div className="mx-auto flex max-w-205 flex-col gap-6">
            <QuizRecovery recovery={rooms.recovery} rooms={rooms} />
          </div>
        </div>
      ) : refused ? (
        <QuizReadSplit
          banner={<FileBanner message={m.editor_access_lost()} />}
          questions={questions.length ? questions : stored}
          sources={sources}
          target={target}
        />
      ) : rooms.ready &&
        (rooms.access !== 'write' || itemEditingStopped(rooms)) ? (
        <QuizReadSplit
          banner={
            <>
              {rooms.readOnlyCode === 'unsupported_block' ? (
                <FileBanner message={m.editor_unsupported_block_strip()} />
              ) : (
                rooms.access !== 'write' && (
                  <FileBanner message={m.editor_read_only_strip()} />
                )
              )}
              {rooms.offline && <SaveBanner state={rooms.offline} />}
            </>
          }
          questions={questions}
          showAnswerKey={rooms.access === 'write'}
          sources={sources}
          target={target}
        />
      ) : rooms.ready && rooms.content && rooms.keys ? (
        <div className="flex h-full min-h-0 flex-col">
          {rooms.offline && <SaveBanner state={rooms.offline} />}
          <CollaborationHold className="flex min-h-0 flex-1 flex-col">
            <QuizEditorBody
              blank={blank}
              content={rooms.content.doc}
              keys={rooms.keys.doc}
              pick={pick}
              questions={questions}
              quizId={quizId}
              sources={sources}
              status={rooms.status}
              title={title}
              undo={rooms.undo}
            />
          </CollaborationHold>
        </div>
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          {isOutdatedBanner(rooms.offline) && <SaveBanner state="outdated" />}
          {copy.seed !== undefined && rooms.keysSeed !== undefined && (
            <QuizOpeningPaint
              contentSeed={copy.seed?.doc ?? null}
              keysSeed={copy.seed ? (rooms.keysSeed?.doc ?? null) : null}
              pick={pick}
              quizId={quizId}
              sources={sources}
              stored={stored}
              title={title}
            />
          )}
        </div>
      )}
    </>
  );
}
