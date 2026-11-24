import {
  lazy,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import * as Y from 'yjs';
import { useTopics } from '@/api/hooks';
import { QUIZ_OPEN_PARTS_MAX } from '@/api/limits.generated';
import type { Question } from '@/api/types';
import { FileBanner } from '@/components/banners/FileBanner';
import { isOutdatedBanner, SaveBanner } from '@/components/banners/SaveBanner';
import { Skeleton } from '@/components/ui/feedback';
import { userToast } from '@/components/ui/userToast';
import { CollaborationHold } from '@/features/collaboration/CollaborationHold';
import type { RoomCopy } from '@/features/collaboration/deviceCopy';
import {
  itemEditingStopped,
  useReportReadOnly,
} from '@/features/collaboration/itemRoom';
import {
  itemSaveState,
  UndoButtons,
} from '@/features/collaboration/LiveItemControls';
import {
  type PresenceConnection,
  useReportPresence,
} from '@/features/collaboration/presence';
import { FileActionsTarget } from '@/features/files/fileModeContext';
import type { ReadOnlyCode } from '@/features/notes/collaborationEvents';
import type { NoteEditorStatus } from '@/features/notes/editorMode';
import { duplicateQuestion } from '@/features/questions/questionEdits';
import {
  blankQuestion,
  type LearnerQuestion,
  modelMarked,
  questionMarks,
} from '@/features/questions/types';
import { quizCapsIssue, quizCounts } from '@/features/questions/validation';
import { m } from '@/i18n';
import { quizSampleUpload } from './drawing/DrawnSample';
import {
  editQuestion,
  figureRoom,
  insertQuestions,
  moveQuestion,
  readQuestions,
  removeQuestion,
  seedQuiz,
  withEmptyKeys,
} from './liveQuiz';
import { useQuizQuestions, useQuizRooms } from './liveQuizRooms';
import type { QuestionTopics } from './QuestionPane';
import { QuestionRail } from './QuestionRail';
import { QuestionRunner } from './QuestionRunner';
import { QuizRecovery, quizImageUpload } from './QuizForm';
import { QuizSplit, useQuizPick } from './QuizSplit';

const QuestionPane = lazy(() =>
  import('./QuestionPane').then((module) => ({
    default: module.QuestionPane,
  }))
);
const BankQuestionsDialog = lazy(() =>
  import('@/features/itemBanks/BankPicker').then((module) => ({
    default: module.BankQuestionsDialog,
  }))
);

/** The quiz's AI-marked (open and drawing) parts against the cap. */
export function aiMarkedCount(questions: Question[]): string {
  const open = questions
    .flatMap((question) => question.parts)
    .filter((part) => modelMarked(part.answer.type)).length;
  return m.quiz_ai_marked_count({ count: open, max: QUIZ_OPEN_PARTS_MAX });
}

/** From the bank, opened once: its questions go in after `after` (a
 * question's id; null for the end). */
type BankOpen = { after: string | null; open: boolean };

/** The quiz as a page (Epo 2026-11-15, board Main): the plain question list
 * on the left, the questions as cards on the right, the open one editing in
 * place and each change written to the quiz's documents at once. Phones show
 * the cards alone. No card opens with the page (Epo 2026-11-15): what the
 * keys add as they come shifts nothing open. */
function QuizEditorBody({
  content,
  head,
  keys,
  keysPending,
  opening,
  pick,
  questions,
  quizId,
  sources,
  topics,
  workspaceId,
}: {
  content: Y.Doc;
  head?: ReactNode;
  keys: Y.Doc;
  keysPending?: boolean;
  /** The paint before the rooms sync (`QuizOpeningPaint`). */
  opening?: boolean;
  /** Kept by the page, so the question open in the paint stays open after it. */
  pick: ReturnType<typeof useQuizPick>;
  questions: Question[];
  quizId: string;
  sources: ReactNode;
  topics?: QuestionTopics;
  /** The quiz's workspace ('' for none), for From the bank's banks. */
  workspaceId: string;
}) {
  const { picked, setPicked } = pick;
  const figures = useMemo(() => figureRoom({ content, keys }), [content, keys]);
  const [bank, setBank] = useState<BankOpen | null>(null);
  const current = questions.find((question) => question.id === picked);
  // A question just added, whose text opens in its editor.
  const [fresh, setFresh] = useState<string>();
  const open = (id: string) => pick.open(id);
  // A write past the quiz's caps, read now, does not go and says so.
  const write = (question: Question) => {
    const issue = editQuestion(content, keys, question);
    if (issue) userToast({ title: issue, variant: 'error' });
    return !issue;
  };
  // A new question goes right after `index`, as Google Forms adds one.
  const place = (question: Question, index: number) => {
    if (!write(question)) return;
    moveQuestion(content, question.id, index + 1);
    open(question.id);
  };
  // The copies go in where the dialog opened, read again now: someone else
  // may have changed the quiz meanwhile. Past the quiz's caps, none goes.
  // A new question after `index`, opened; it stays, as each + in Google Forms
  // adds a card (Epo 2026-11-15).
  const addQuestion = (index: number) => {
    const added = blankQuestion();
    setFresh(added.id);
    place(added, index);
  };
  const addFromBank = (copies: Question[]) => {
    const now = readQuestions(content, keys);
    const issue = quizCapsIssue(
      quizCounts(now),
      quizCounts([...now, ...copies])
    );
    if (issue) {
      userToast({ title: issue, variant: 'error' });
      return;
    }
    const at = now.findIndex((question) => question.id === bank?.after);
    insertQuestions(content, keys, copies, at < 0 ? now.length - 1 : at);
    setBank((current) => current && { ...current, open: false });
    open(copies[0].id);
  };
  const foot = (
    <>
      {/* A whole past paper is seen to fit (Epo 2026-11-03). */}
      <p className="t-meta text-fg-muted">{aiMarkedCount(questions)}</p>
      {sources}
    </>
  );
  // The rail's + and From the bank add after the open question, else at the
  // end, as the floating bar does (Epo 2026-11-16).
  const openIndex = questions.findIndex(
    (question) => question.id === current?.id
  );
  const after = openIndex < 0 ? questions.length - 1 : openIndex;
  return (
    // The rail, not the list, while editing (Epo 2026-11-15, Canvas's Build
    // page): the cards have the room beside the file tree.
    <div className="flex min-h-0 flex-1">
      <QuestionRail
        current={current?.id}
        onAdd={() => addQuestion(after)}
        onBank={() =>
          setBank({ after: questions[after]?.id ?? null, open: true })
        }
        onMove={(id, index) => moveQuestion(content, id, index)}
        onOpen={open}
        opening={opening}
        questions={questions}
      />
      <div className="min-h-0 min-w-0 flex-1" data-quiz-pane="">
        <Suspense fallback={<Skeleton className="m-4 h-64" />}>
          <QuestionPane
            figures={figures}
            foot={foot}
            fresh={fresh}
            head={head}
            keysPending={keysPending}
            onAdd={addQuestion}
            onBank={(index) =>
              setBank({ after: questions[index]?.id ?? null, open: true })
            }
            onDuplicate={(question, index) =>
              place(duplicateQuestion(question), index)
            }
            onMove={(id, index) => moveQuestion(content, id, index)}
            onOpen={open}
            onRemove={(id) => {
              const index = questions.findIndex((q) => q.id === id);
              const next = questions[index + 1] ?? questions[index - 1];
              removeQuestion(content, keys, id);
              if (id === current?.id) setPicked(next?.id ?? null);
            }}
            opening={opening}
            picked={current?.id}
            questions={questions}
            quizId={quizId}
            scrollTop={pick.scrollTop}
            topics={topics}
            uploadAsset={quizImageUpload(quizId)}
            uploadSample={quizSampleUpload(quizId)}
            write={write}
          />
          {bank && (
            <BankQuestionsDialog
              existing={questions}
              onAdd={addFromBank}
              onClose={() => setBank({ ...bank, open: false })}
              open={bank.open}
              quizId={quizId}
              workspaceId={workspaceId}
            />
          )}
        </Suspense>
      </div>
    </div>
  );
}

/** A quiz's title with Practice at its pane's top right, as a set's
 * (`PaintedCards`; Epo 2026-11-16): the page's h1. */
export function QuizPaneTitle({
  action,
  title,
}: {
  action: ReactNode;
  title: string;
}) {
  return (
    <div className="flex items-center gap-4">
      <h1 className="t-large-card-title min-w-0 flex-1">{title}</h1>
      {action}
    </div>
  );
}

const NO_ANSWERS = {};

/** The questions as they read, in the quiz's layout: a room that turned read-only
 * or refused, and anyone who only views the quiz. */
export function QuizReadSplit({
  banner,
  head,
  paneClassName,
  questions,
  showAnswerKey,
  sources,
  target,
}: {
  banner?: ReactNode;
  /** Above the open question: the quiz's title and Practice. */
  head?: ReactNode;
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
        phoneHead={head}
        questions={questions}
        rowEnd={questionMarks}
      >
        {question && (
          <div
            className="mx-auto grid max-w-205 gap-4 px-4 py-6 sm:px-10"
            data-question-id={question.id}
            key={question.id}
          >
            {head}
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
  head,
  keysSeed,
  pick,
  quizId,
  sources,
  stored,
  topics,
}: {
  contentSeed: Y.Doc | null;
  head?: ReactNode;
  keysSeed: Y.Doc | null;
  pick: ReturnType<typeof useQuizPick>;
  quizId: string;
  sources: ReactNode;
  stored: LearnerQuestion[];
  topics?: QuestionTopics;
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
  return (
    <div className="flex h-full min-h-0 flex-col" data-quiz-opening="">
      <QuizEditorBody
        content={docs.content}
        head={head}
        keys={docs.keys}
        keysPending={!keysSeed}
        opening
        pick={pick}
        questions={shown}
        quizId={quizId}
        sources={sources}
        topics={topics}
        workspaceId=""
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
  practice,
  copy,
  onPresenceChange,
  onReadOnly,
  onStatusChange,
  sources,
  stored,
  target,
  topicId,
  workspaceId,
}: {
  /** Its rooms turned read-only (a demotion, a frozen account): the page
   * reads it under its strip, as a set's or a diagram's editor reports it. */
  onReadOnly?: (code?: ReadOnlyCode) => void;
  /** The quiz's workspace ('' for none) and its topic, for its questions'
   * own topics (Epo 2026-11-15). */
  workspaceId?: string;
  topicId?: string | null;
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
  /** Practice, at the questions' top right beside the title, as a set's
   * (Epo 2026-11-16). */
  practice?: ReactNode;
  /** Under the question list, or at the end of the column. */
  sources?: ReactNode;
  /** The room's other editors, for the header's avatar group. */
  onPresenceChange?: (connections: PresenceConnection[] | null) => void;
  onStatusChange?: (status: NoteEditorStatus | null) => void;
}) {
  const rooms = useQuizRooms(quizId, { copy, edit: true });
  const pick = useQuizPick(target);
  const questions = useQuizQuestions(rooms.content?.doc, rooms.keys?.doc);
  // Optional: without topics (loading or failed) the Topic field hides.
  const { data: workspaceTopics } = useTopics(workspaceId ?? '', {
    errorBoundary: false,
  });
  const topics: QuestionTopics | undefined = workspaceTopics && {
    quizTopic: workspaceTopics.find((topic) => topic.id === topicId),
    topics: workspaceTopics,
  };
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
  // Lowered after its rooms could write here: the page reads it under its
  // strip. One opened read-only shows no cue (D1).
  const wrote = useReportReadOnly(rooms, quizId, onReadOnly);
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

  // Its room refused this person: the page stays as it is, read-only.
  const refused = rooms.status === 'unavailable';
  const head = practice && <QuizPaneTitle action={practice} title={title} />;
  return (
    <>
      {/* The header names it for the eye; the page's one h1 stays its title. */}
      {!head && <h1 className="sr-only">{title}</h1>}
      {headerActions &&
        createPortal(
          <>
            {rooms.undo && !refused && !itemEditingStopped(rooms) && (
              <UndoButtons header manager={rooms.undo} />
            )}
            {/* 4px past Redo's own 7px inset: about the 10px between the
                header's buttons (Epo 2026-11-16). */}
            {action && <span className="sm:ml-1">{action}</span>}
          </>,
          headerActions
        )}
      {rooms.recovery ? (
        <div className="h-full overflow-y-auto px-4 py-6 sm:px-10">
          <div className="mx-auto flex max-w-205 flex-col gap-6">
            {head}
            <QuizRecovery
              recovery={rooms.recovery}
              rooms={rooms}
              stored={stored}
            />
          </div>
        </div>
      ) : refused ? (
        <QuizReadSplit
          // Deleted, its edits not drawn yet: the recovery's strip follows.
          banner={
            !rooms.deleted && <FileBanner message={m.editor_access_lost()} />
          }
          head={head}
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
                rooms.access !== 'write' &&
                wrote && <FileBanner message={m.editor_read_only_strip()} />
              )}
              {rooms.offline && <SaveBanner state={rooms.offline} />}
            </>
          }
          head={head}
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
              content={rooms.content.doc}
              head={head}
              keys={rooms.keys.doc}
              pick={pick}
              questions={questions}
              quizId={quizId}
              sources={sources}
              topics={topics}
              workspaceId={workspaceId ?? ''}
            />
          </CollaborationHold>
        </div>
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          {isOutdatedBanner(rooms.offline) && <SaveBanner state="outdated" />}
          {copy.seed !== undefined && rooms.keysSeed !== undefined && (
            <QuizOpeningPaint
              contentSeed={copy.seed?.doc ?? null}
              head={head}
              keysSeed={copy.seed ? (rooms.keysSeed?.doc ?? null) : null}
              pick={pick}
              quizId={quizId}
              sources={sources}
              stored={stored}
              topics={topics}
            />
          )}
        </div>
      )}
    </>
  );
}
