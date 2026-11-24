import {
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { Question, Topic } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Separator } from '@/components/ui/Separator';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { AddToBankItem } from '@/features/itemBanks/AddToBankItem';
import type { UploadQuestionAsset } from '@/features/questions/BlockEditor';
import { GapChip, MenuItem } from '@/features/questions/editorFields';
import { issueMessages, questionIssues } from '@/features/questions/issues';
import { MatchingGrid } from '@/features/questions/MatchingGrid';
import {
  QuestionCard,
  QuestionCardView,
} from '@/features/questions/QuestionCard';
import { ChoiceMarker, CorrectTag } from '@/features/questions/QuestionView';
import type { FigureRoom } from '@/features/questions/questionEdits';
import { TextView } from '@/features/questions/TextView';
import { TopicField, withTopics } from '@/features/questions/TopicField';
import {
  gapNumbers,
  isAuthoredPart,
  type LearnerPart,
  multipleAnswers,
  type QuestionPart,
} from '@/features/questions/types';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { UploadDrawnSample } from './drawing/DrawnSample';
import { RowMark } from './QuizSplit';

/** The nearest box that scrolls `element` (a note's scroll area). */
function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let at = element?.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (overflowY === 'auto' || overflowY === 'scroll') return at;
  }
  return null;
}

/** A workspace quiz's topics, for its questions' own topics, and the quiz's
 * topic, which a question without its own follows. */
export type QuestionTopics = { quizTopic?: Topic; topics: Topic[] };

/** A list row as the open card's: `lead` (a marker, a number), the text
 * where its input's is, `end` after it, then the remove button's room. */
function KeyRow({
  end,
  lead,
  removable = true,
  text,
}: {
  end?: ReactNode;
  lead: ReactNode;
  /** The open card's row has a remove button (not True/False's). */
  removable?: boolean;
  text: string;
}) {
  return (
    <div className="flex min-h-11 items-center gap-3">
      {lead}
      {removable ? (
        // The input's box (40px, a 1px underline): its text sits as typed.
        <span className="flex min-h-10 min-w-0 items-center border-transparent border-b px-0.5">
          <TextView text={text} />
        </span>
      ) : (
        <TextView className="min-w-0 px-0.5" text={text} />
      )}
      {end}
      {/* The remove button's room, so text wraps as the editor's; "Correct"
          sits at the far right instead and moves on open (Epo 2026-11-15). */}
      {removable && !end && (
        <span aria-hidden className="size-(--toolbar-button) shrink-0" />
      )}
    </div>
  );
}

/** Accepted answers as the open card's pills, room kept for each pill's ×
 * and the Add an answer input, so they wrap as the editor's do. */
function KeyPills({ values }: { values: string[] }) {
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-2 border-line border-b pb-1.5">
      {values.filter(Boolean).map((value, i) => (
        <span
          className="inline-flex h-7.5 max-w-full items-center gap-0.5 rounded-lg bg-page pl-2.5 text-[13.5px]"
          key={i}
        >
          <span className="min-w-0 truncate">{value}</span>
          <span aria-hidden className="size-6 shrink-0" />
        </span>
      ))}
      <span aria-hidden className="h-7.5 min-w-32 flex-1" />
    </div>
  );
}

/** A list's heading and rows, its Add row's room kept: what follows it stays
 * put when the open card adds that row. */
function KeyList({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div>
      <h4 className="mb-1 font-bold">{title}</h4>
      {children}
      <div aria-hidden className="min-h-11" />
    </div>
  );
}

/** A part's answer in a closed card as its open card draws it, without the
 * controls (Epo 2026-11-15, "Closed follow the editor"): opening one moves
 * nothing. With keys still to come (`pending`), what the content already
 * holds draws in place, so their coming shifts little (Epo 2026-11-15): choice
 * and True / False rows unmarked, a short answer's empty pills and unit, a
 * gaps part's blanks from its text; the rest waits. */
export function PartKey({
  part,
  pending,
}: {
  part: QuestionPart | LearnerPart;
  pending?: boolean;
}) {
  if (!isAuthoredPart(part)) return null;
  const key = part.answer;
  if (pending && !['boolean', 'gaps', 'mcq', 'short'].includes(key.type))
    return null;
  switch (key.type) {
    case 'mcq':
      return (
        <div>
          {key.options.map((option, i) => (
            <KeyRow
              end={
                key.correct.includes(i) && <CorrectTag className="ml-auto" />
              }
              key={i}
              lead={
                <ChoiceMarker
                  checked={key.correct.includes(i)}
                  multiple={multipleAnswers(key)}
                />
              }
              text={option}
            />
          ))}
        </div>
      );
    case 'boolean':
      return (
        <div>
          {[true, false].map((value) => (
            <KeyRow
              end={
                !pending &&
                key.correct === value && <CorrectTag className="ml-auto" />
              }
              key={String(value)}
              lead={
                <ChoiceMarker
                  checked={!pending && key.correct === value}
                  multiple={false}
                />
              }
              removable={false}
              text={value ? m.question_ui_true() : m.question_ui_false()}
            />
          ))}
        </div>
      );
    case 'matching':
      return (
        <div className="flex flex-col gap-3.5">
          <div className="grid @min-[36rem]:grid-cols-2 gap-x-7 gap-y-3">
            <KeyList title={m.question_ui_rows()}>
              {key.pairs.map((pair, i) => (
                <KeyRow
                  key={i}
                  lead={<span className="w-4.5 shrink-0">{i + 1}.</span>}
                  text={pair.left}
                />
              ))}
            </KeyList>
            <KeyList title={m.question_ui_columns()}>
              {key.options.map((option, i) => (
                <KeyRow
                  key={i}
                  lead={<ChoiceMarker checked={false} multiple={false} />}
                  text={option}
                />
              ))}
            </KeyList>
          </div>
          <div>
            <h4 className="mb-1.5 font-bold">
              {m.question_ui_correct_answers()}
            </h4>
            <MatchingGrid
              columns={key.options}
              correct={key.pairs.map((pair) => pair.right)}
              label={m.question_ui_correct_answers()}
              rows={key.pairs.map((pair) => pair.left)}
            />
          </div>
        </div>
      );
    case 'ordering':
      return (
        <div>
          {key.items.map((item, i) => (
            <KeyRow
              key={i}
              lead={<span className="w-4.5 shrink-0">{i + 1}.</span>}
              text={item}
            />
          ))}
        </div>
      );
    case 'short':
      return (
        <div className="flex flex-col gap-2">
          <span className="t-meta font-semibold text-fg-secondary">
            {m.question_ui_accepted_answers()}
          </span>
          <KeyPills values={key.accepted} />
          <div className="mt-1.5 flex items-center gap-2.5">
            <span className="t-meta font-semibold text-fg-secondary">
              {m.question_ui_unit_optional()}
            </span>
            <span className="flex h-9 w-30 items-center border-line border-b px-0.5">
              {key.unit}
            </span>
          </div>
        </div>
      );
    case 'gaps': {
      // Before its keys, its blanks as its text numbers them.
      const lists = pending
        ? gapNumbers(part.blocks).map(() => [])
        : key.accepted;
      if (lists.length === 0)
        return (
          <p className="text-fg-muted text-sm">{m.question_ui_gaps_hint()}</p>
        );
      return (
        <div className="flex flex-col gap-2.5">
          {lists.map((list, i) => (
            <div className="flex items-center gap-2.5" key={i}>
              <GapChip number={i + 1} />
              <div className="min-w-0 flex-1">
                <KeyPills values={list} />
              </div>
            </div>
          ))}
        </div>
      );
    }
    case 'open':
    case 'canvas':
      return (
        <KeyList title={m.question_ui_marking_scheme()}>
          {(part.markscheme ?? []).map((item, i) => (
            <div
              className="grid min-h-11 grid-cols-[1.375rem_minmax(0,1fr)_3.25rem_auto] items-start gap-2.5 py-0.5"
              key={i}
            >
              <span className="pt-2 leading-[1.7]">{i + 1}.</span>
              {/* As the open card's point draws it: no shift on opening. */}
              <span className="border-transparent border-b py-2 leading-[1.7]">
                <TextView marks text={item.text} />
              </span>
              {/* Where the marks select's value sits. */}
              <span className="mt-1 flex h-8 items-center justify-center">
                {item.marks}
              </span>
              <span
                aria-hidden
                className="mt-[calc((40px-var(--toolbar-button))/2)] size-(--toolbar-button) shrink-0"
              />
            </div>
          ))}
        </KeyList>
      );
  }
}

/** A question with issues, marked where its list row is out of view. */
function IssueMark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex text-tint-warning-fg', className)}>
      <RowMark label={m.quiz_editor_has_issue()}>
        <Icon className="size-4" name="alert" />
      </RowMark>
    </span>
  );
}

/** A card not open: as members see it with the key marked, phones too (Epo
 * 2026-11-19); a click opens it. Memoized on the question's object, which stays the
 * same until it changes (`useQuizQuestions`), so typing in the open card
 * leaves the others be. */
const ClosedCard = memo(function ClosedCard({
  embedded,
  keysPending,
  number,
  onOpen,
  opening,
  question,
}: {
  keysPending?: boolean;
  number: number;
  onOpen: (id: string, part?: string) => void;
  opening?: boolean;
  /** In a note: no card outline (Epo 2026-11-15). */
  embedded?: boolean;
  question: Question;
}) {
  const issue = !opening && questionIssues(question).length > 0;
  return (
    <section
      aria-label={m.quiz_editor_question({ number })}
      className={cn(
        'relative scroll-mt-3 scroll-mb-20',
        embedded
          ? 'py-3.5'
          : 'rounded-xl border border-line bg-surface px-3 py-3.5 sm:px-6 sm:py-5'
      )}
      data-question-id={question.id}
    >
      <QuestionCardView
        answer={(part) => <PartKey part={part} pending={keysPending} />}
        issue={issue && <IssueMark />}
        keysPending={keysPending}
        number={number}
        question={question}
      />
      {/* The whole card opens it. */}
      <button
        aria-label={m.question_ui_edit_question_number({ number })}
        className="absolute inset-0 cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-action"
        onClick={(event) => {
          // The part under the pointer opens with the card.
          const part = document
            .elementsFromPoint(event.clientX, event.clientY)
            .find(
              (element): element is HTMLElement =>
                element instanceof HTMLElement &&
                !!element.dataset.partId &&
                event.currentTarget.parentElement?.contains(element) === true
            )?.dataset.partId;
          onOpen(question.id, part);
        }}
        type="button"
      />
    </section>
  );
});

/**
 * A quiz's questions as Google Forms cards (Epo 2026-11-15, boards Main and
 * Phone), beside the numbers rail (`QuestionRail`): the open card edits in place
 * (`QuestionCard`), with Duplicate, Delete and ⋮ (Add to bank, Move up, Move
 * down) at its footer's end and Add question and From the bank floating
 * beside it, a bar at the bottom where there is no room; the others read as members see them with
 * the correct answer marked, a click opening them. Phones show the others as
 * one line each. The sources and AI-marked count sit under the cards. Every change writes the quiz's documents at once.
 * `embedded`, a note's quiz (Epo 2026-11-15, in place of the question
 * dialog): the cards in the note's flow, scrolled by the note, Add question
 * under them.
 */
export function QuestionPane({
  embedded,
  figures,
  foot,
  head,
  fresh,
  keysPending,
  onAdd,
  onBank,
  onDuplicate,
  onMove,
  onOpen,
  onRemove,
  opening,
  picked,
  questions,
  quizId,
  scrollTop,
  topics,
  uploadAsset,
  uploadSample,
  write,
}: {
  /** In a note: no scroller or floating bars of its own. */
  embedded?: boolean;
  /** The quiz's figures, written by their room entries. */
  figures: FigureRoom;
  /** Under the cards: the AI-marked count and the sources. */
  foot?: ReactNode;
  /** Above the cards: the quiz's title and Practice (`QuizPaneTitle`). */
  head?: ReactNode;
  /** A question just added: its text opens in its editor. */
  fresh?: string;
  /** The read's questions, whose keys are still to come. */
  keysPending?: boolean;
  /** Adds a question after the one at `index`. */
  onAdd: (index: number) => void;
  /** Opens From the bank, whose questions go in after the one at `index`. */
  onBank?: (index: number) => void;
  onDuplicate: (question: Question, index: number) => void;
  onMove: (id: string, index: number) => void;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
  /** Painted before its rooms sync: nothing to warn about yet. */
  opening?: boolean;
  picked: string | undefined;
  questions: Question[];
  quizId: string;
  /** The cards' scroll, kept by the page across the opening paint's swap. */
  scrollTop?: RefObject<number>;
  /** A workspace quiz's topics: none, no Topic field. */
  topics?: QuestionTopics;
  uploadAsset: UploadQuestionAsset;
  uploadSample: UploadDrawnSample;
  /** False when the write did not go (`editQuestion`). */
  write: (question: Question) => boolean;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  const openIndex = questions.findIndex((question) => question.id === picked);
  const scroller = useRef<HTMLDivElement>(null);
  // What scrolls the cards: the pane, else (in a note) the note.
  const scrollBox = () =>
    embedded ? scrollParent(scroller.current) : scroller.current;
  const cardTop = (id: string) =>
    scroller.current
      ?.querySelector(`[data-question-id="${CSS.escape(id)}"]`)
      ?.getBoundingClientRect().top;
  // A card clicked open stays where it was clicked, though the card closing
  // above it shrinks (no jump to the top).
  const clicked = useRef<{ id: string; top: number } | null>(null);
  // Closed cards keep one `onOpen`, so their memo holds.
  const openLatest = useRef(onOpen);
  openLatest.current = onOpen;
  // The part a click on a closed card landed on, open in its open card.
  const [clickedPart, setClickedPart] = useState<string>();
  const openCard = useCallback((id: string, part?: string) => {
    const top = cardTop(id);
    clicked.current = top === undefined ? null : { id, top };
    setClickedPart(part);
    openLatest.current(id);
  }, []);
  // Where the opening paint was scrolled to, as the live cards take its place.
  useLayoutEffect(() => {
    if (scrollTop && scroller.current && !embedded)
      scroller.current.scrollTop = scrollTop.current;
  }, []);
  // The card a rail click, Add or Duplicate opened comes to the top.
  useLayoutEffect(() => {
    if (!picked) return;
    const from = clicked.current;
    clicked.current = null;
    const top = cardTop(picked);
    const box = scrollBox();
    if (from?.id === picked && top !== undefined && box) {
      box.scrollTop += top - from.top;
      return;
    }
    scroller.current
      ?.querySelector(`[data-question-id="${CSS.escape(picked)}"]`)
      // In a note the card comes into view, the note around it staying put.
      ?.scrollIntoView?.({ block: embedded ? 'nearest' : 'start' });
  }, [picked]);
  // What the bar adds goes after the open card, else at the end.
  const after = openIndex < 0 ? questions.length - 1 : openIndex;
  const addBar = (className: string) => (
    <div
      aria-label={m.quiz_editor_add_bar()}
      className={cn(
        'flex rounded-[10px] border border-line bg-surface p-1.5 shadow-pop',
        className
      )}
      role="toolbar"
    >
      <ToolbarButton
        disabled={opening}
        label={m.quiz_add_question()}
        onClick={() => onAdd(after)}
      >
        <Icon name="plusCircle" />
      </ToolbarButton>
      {onBank && (
        <ToolbarButton
          disabled={opening}
          label={m.practice_tab_bank()}
          onClick={() => onBank(after)}
        >
          <Icon name="fileImport" />
        </ToolbarButton>
      )}
    </div>
  );
  const card = (question: Question, index: number): ReactNode => {
    const number = index + 1;
    const label = m.quiz_editor_question({ number });
    if (question.id !== picked)
      return (
        <ClosedCard
          embedded={embedded}
          key={question.id}
          keysPending={keysPending}
          number={number}
          onOpen={openCard}
          opening={opening}
          question={question}
        />
      );
    // What it counts toward: its own topics, else the quiz's.
    const own =
      topics?.topics.filter((item) => question.topicIds?.includes(item.id)) ??
      [];
    const counted =
      own.length > 0 ? own : topics?.quizTopic ? [topics.quizTopic] : [];
    return (
      <section
        aria-label={label}
        className={cn(
          'relative scroll-mt-3 scroll-mb-20',
          // In a note, no card outline (Epo 2026-11-15): the open one shows
          // by its controls.
          embedded
            ? 'py-3.5'
            : 'rounded-xl border-2 border-action-accent bg-surface px-2.75 py-3.25 sm:px-5.75 sm:py-4.75'
        )}
        data-question-id={question.id}
        // The tour outlines it.
        data-question-open=""
        key={question.id}
      >
        <QuestionCard
          actions={
            <>
              <ToolbarButton
                label={m.question_ui_duplicate()}
                onClick={() => onDuplicate(question, index)}
              >
                <Icon name="copy" />
              </ToolbarButton>
              <ToolbarButton
                label={m.question_ui_delete()}
                onClick={() => setRemoving(question.id)}
              >
                <Icon name="trash" />
              </ToolbarButton>
            </>
          }
          autoFocus={question.id === fresh}
          figures={figures}
          issues={opening ? [] : issueMessages(questionIssues(question))}
          key={question.id}
          keysPending={keysPending}
          menu={(close) => (
            <>
              {/* A copy into this class's bank or My bank (mock QuizMenus). */}
              <AddToBankItem
                disabled={keysPending || questionIssues(question).length > 0}
                onDone={close}
                question={question}
                topics={counted}
              />
              <MenuItem
                disabled={index === 0}
                icon={<Icon name="arrowUp" />}
                label={m.question_ui_move_up()}
                onClick={() => onMove(question.id, index - 1)}
              />
              <MenuItem
                disabled={index === questions.length - 1}
                icon={<Icon name="arrowDown" />}
                label={m.question_ui_move_down()}
                onClick={() => onMove(question.id, index + 1)}
              />
              <Separator className="my-1" />
            </>
          )}
          menuLabel={m.quiz_editor_question_actions({ number })}
          number={number}
          openPart={clickedPart}
          question={question}
          quizId={quizId}
          topic={
            topics && topics.topics.length > 0 ? (
              <TopicField
                fallback={topics.quizTopic}
                onChange={(topicIds) => write(withTopics(question, topicIds))}
                topicIds={question.topicIds}
                topics={topics.topics}
              />
            ) : undefined
          }
          uploadAsset={uploadAsset}
          uploadSample={uploadSample}
          write={write}
        />
        {!embedded &&
          addBar(
            'absolute top-0 left-full ml-4 hidden flex-col gap-0.5 @min-[58rem]:flex'
          )}
      </section>
    );
  };
  const confirm = (
    <ConfirmDialog
      body={m.quiz_remove_question_confirm_body()}
      confirmLabel={m.action_remove()}
      onClose={() => setRemoving(null)}
      onConfirm={() => removing && onRemove(removing)}
      open={removing !== null}
      title={m.quiz_remove_question_confirm_title()}
    />
  );
  if (embedded)
    return (
      <div className="@container flex flex-col" ref={scroller}>
        {questions.map(card)}
        <Button
          className="mt-3 w-full max-w-xs self-center"
          disabled={opening}
          iconLeft="plus"
          onClick={() => onAdd(after)}
          rounded="large"
          type="button"
          variant="outline"
        >
          {m.quiz_add_question()}
        </Button>
        {confirm}
      </div>
    );
  return (
    // Its own scroller, so opening a card keeps the place (the pane would go
    // back to its top on each open).
    <div
      className="@container h-full overflow-y-auto bg-page"
      onScroll={(event) => {
        if (scrollTop) scrollTop.current = event.currentTarget.scrollTop;
      }}
      ref={scroller}
    >
      {/* Centred; the open card's add bar floats in the right margin. Before
          the rooms sync the cards wait (inert), the pane around them still
          scrolling. */}
      <div
        className="mx-auto flex max-w-190 flex-col gap-3 @min-[58rem]:px-0 px-2.5 pt-3 @min-[58rem]:pb-6 pb-24 sm:gap-3.5 sm:px-4 sm:pt-5"
        inert={opening}
      >
        {head}
        {questions.map(card)}
        {/* No open card to float beside: the bar sits in the column. */}
        {questions.length === 0 &&
          addBar('hidden w-fit gap-0.5 @min-[58rem]:flex')}
        {foot && <div className="flex flex-col gap-2 px-1 pt-1">{foot}</div>}
      </div>
      {/* Compact and centred, clear of the assistant button in the corner. */}
      {addBar('sticky bottom-5 mx-auto w-fit gap-0.5 p-1 @min-[58rem]:hidden')}
      {confirm}
    </div>
  );
}
