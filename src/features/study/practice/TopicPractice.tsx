import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  invalidateStudy,
  useFinishReviewSession,
  useReviewResult,
  useStudyQuestionCount,
  useTopics,
  useWorkspaceReview,
} from '@/api/hooks';
import type {
  ReviewAnswer,
  ReviewItem,
  ReviewMode,
  ReviewReason,
  ReviewSessionRef,
  ReviewStart,
} from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/Dialog';
import { SkeletonList, Spinner } from '@/components/ui/feedback';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { markGettingStarted } from '@/features/guide/gettingStarted';
import {
  RemovedAssetsContext,
  useRemovedAssets,
} from '@/features/materials/MediaAssetView';
import { answerLabels } from '@/features/questions/editorFields';
import { TextView } from '@/features/questions/TextView';
import type {
  LearnerQuestion,
  Question,
  QuestionBlock,
  TextBlock,
} from '@/features/questions/types';
import type { Answers } from '@/features/quizzes/grade';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { unexpectedErrorId } from '@/lib/errors';
import { CheckedQuestion, QuestionItem } from '../ReviewQuestion';
import {
  countChoices,
  defaultCount,
  groupLabel,
  minutesLabel,
  questionsLabel,
  REASON,
  TIMER_MINUTES,
  timeLeft,
} from './practiceText';

/** A topic session's start, as the Practice page's URL holds it. */
export type PracticeStart = {
  group: 'topic' | 'others' | 'workspace';
  topicId?: string;
  reviewMode?: ReviewMode;
};

/** The page's padding: the boards' 28px 36px, the phone gutter below sm. */
export function PracticeFrame({ children }: { children: ReactNode }) {
  return (
    // One column leaves room under the page for the floating chat button.
    <div className="min-h-0 flex-1 overflow-auto px-4 pt-5 pb-24 sm:px-6 lg:px-9 lg:pt-7 lg:pb-10">
      {children}
    </div>
  );
}

const keyOf = (it: { materialId: string; itemId: string }) =>
  `${it.materialId}/${it.itemId}`;

const blockText = (blocks: QuestionBlock[] = []) =>
  blocks.find((b): b is TextBlock => b.type === 'text' && b.text.trim() !== '')
    ?.text;

/** A question's first line: its stem's, else its first part's. */
function questionLine(q?: Question | LearnerQuestion) {
  if (!q) return '';
  return (
    blockText(q.stem) ??
    q.parts.map((p) => blockText(p.blocks)).find(Boolean) ??
    ''
  );
}

export function ReasonChip({ reason }: { reason?: ReviewReason }) {
  if (!reason) return null;
  return (
    <span
      className={cn(
        'inline-flex h-5.5 shrink-0 items-center rounded-md px-1.75 font-semibold text-xs',
        REASON[reason].className
      )}
    >
      {REASON[reason].label()}
    </span>
  );
}

/** What a checked question recorded. */
type Checked = { answers: Answers; question: Question };

type Running = { ref: ReviewSessionRef; items: ReviewItem[] };

type Order = NonNullable<ReviewStart['order']>;
const ORDERS: { label: () => string; value: Order }[] = [
  { label: m.practice_order_recommended, value: 'recommended' },
  { label: m.practice_order_unattempted, value: 'unattempted' },
  { label: m.practice_order_incorrect, value: 'incorrect' },
];

/** One of the start dialog's choices. */
function Choice({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: { label: string; value: string }[];
  value: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="t-meta font-semibold text-fg-secondary">{label}</span>
      <Select onValueChange={onChange} value={value}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Practise on a topic or the whole workspace (Epo 2026-11-03, board F1b;
 * start dialog 2026-11-04, board F1): the learner picks how many, which come
 * first and an optional timer, and Start fetches that batch, which is the
 * session, run one question at a time in the page's place. Questions only. The
 * first answer records it. */
export function TopicPractice({
  behind,
  onClose,
  onDone,
  start,
  workspaceId,
}: {
  /** The Practice page, under the start dialog. */
  behind: ReactNode;
  onClose: () => void;
  /** The session ended with answers: its result. */
  onDone: (sessionId: string) => void;
  start: PracticeStart;
  workspaceId: string;
}) {
  const { data: topics } = useTopics(workspaceId);
  const { data: held, isPending: counting } = useStudyQuestionCount(
    workspaceId,
    start.group,
    start.topicId
  );
  const total = held?.total ?? 0;
  const [picked, setPicked] = useState<number | null>(null);
  const [order, setOrder] = useState<Order>('recommended');
  const [minutes, setMinutes] = useState(0);
  const [begun, setBegun] = useState(false);
  const size = picked ?? defaultCount(total);
  const { data, error, isError, isFetching, refetch } = useWorkspaceReview(
    workspaceId,
    {
      count: size,
      group: start.group,
      items: 'quiz',
      mode: start.reviewMode,
      order: order === 'recommended' ? undefined : order,
      topicId: start.topicId,
    },
    { enabled: begun, errorBoundary: false }
  );
  // The batch fetched on Start: a later read would draw a different one.
  const [running, setRunning] = useState<Running | null>(null);
  const [endsAt, setEndsAt] = useState<number | null>(null);
  if (running === null && begun && data && !isFetching && !isError) {
    setRunning({
      items: data.items,
      ref: {
        evidence: data.evidence,
        group: data.group,
        id: crypto.randomUUID(),
        items: data.items.map(({ itemId, materialId, reason }) => ({
          itemId,
          materialId,
          reason,
        })),
        mode: data.mode,
        topicId: data.topicId,
        workspaceId,
      },
    });
    setEndsAt(minutes ? Date.now() + minutes * 60_000 : null);
  }
  const removed = useRemovedAssets(data?.removedAssetIds);
  const name = groupLabel(
    start.group,
    topics?.find((t) => t.id === start.topicId)?.name
  );
  const title =
    start.group === 'workspace'
      ? m.dashboard_workspace_review()
      : m.practice_session_title({ topic: name });

  if (running)
    return (
      <RemovedAssetsContext.Provider value={removed}>
        <Session
          endsAt={endsAt}
          onClose={onClose}
          onDone={onDone}
          running={running}
          title={title}
          workspaceId={workspaceId}
        />
      </RemovedAssetsContext.Provider>
    );
  const starting = begun && !isError;
  const startButton = (
    <Button
      disabled={!total || starting}
      onClick={() => (begun ? void refetch() : setBegun(true))}
    >
      {starting && <Spinner />}
      {m.review_start()}
    </Button>
  );
  return (
    <>
      {behind}
      <Dialog onOpenChange={(open) => !open && onClose()} open>
        {/* The title stays the content's first child: phones make it the
            sticky header row and drop the content's top padding for it. */}
        <DialogContent
          aria-describedby={undefined}
          cardScrollContainerClassName="sm:px-7 sm:pb-0"
          className="sm:max-w-[460px]"
        >
          <DialogTitle action={startButton} className="pb-0">
            {title}
          </DialogTitle>
          {total > 0 && (
            <p className="t-meta mt-0.5 font-semibold text-fg-muted">
              {`${questionsLabel(size)} · ${minutesLabel(size)}`}
            </p>
          )}
          {isError ? (
            <ErrorState
              action={
                <Button onClick={() => void refetch()} variant="outline">
                  {m.action_retry()}
                </Button>
              }
              className="my-8"
              errorId={unexpectedErrorId(error)}
              title={m.practice_session_failed()}
              variant="panel"
            />
          ) : !counting && total === 0 ? (
            <p className="t-meta my-8 text-fg-muted">{m.practice_nothing()}</p>
          ) : (
            <div className="mt-4 flex flex-col gap-4">
              <Choice
                label={m.practice_choose_questions()}
                onChange={(v) => setPicked(Number(v))}
                options={countChoices(total).map((n) => ({
                  label:
                    n === total
                      ? m.practice_all_questions({ count: n })
                      : String(n),
                  value: String(n),
                }))}
                value={String(size)}
              />
              <Choice
                label={m.practice_choose_mode()}
                onChange={(v) => setOrder(v as Order)}
                options={ORDERS.map((o) => ({
                  label: o.label(),
                  value: o.value,
                }))}
                value={order}
              />
              <Choice
                label={m.practice_choose_timer()}
                onChange={(v) => setMinutes(Number(v))}
                options={[
                  { label: m.practice_timer_off(), value: '0' },
                  ...TIMER_MINUTES.map((n) => ({
                    label: m.practice_timer_minutes({ count: n }),
                    value: String(n),
                  })),
                ]}
                value={String(minutes)}
              />
            </div>
          )}
          <DialogFooter className="mt-2.5 max-sm:hidden sm:-mx-7 sm:px-7 sm:pb-5">
            <Button onClick={onClose} variant="ghost">
              {m.action_cancel()}
            </Button>
            {startButton}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The running session (F1b): one question at a time, marked when checked,
 * with why it came; Next moves on, the last goes to the result, End session
 * stops early. */
function Session({
  endsAt,
  onClose,
  onDone,
  running,
  title,
  workspaceId,
}: {
  /** When an optional timer runs out; the session then ends. */
  endsAt: number | null;
  onClose: () => void;
  onDone: (sessionId: string) => void;
  running: Running;
  title: string;
  workspaceId: string;
}) {
  const qc = useQueryClient();
  const { mutateAsync: finish, isPending: finishing } =
    useFinishReviewSession();
  const [index, setIndex] = useState(0);
  const [checked, setChecked] = useState<Map<string, Checked>>(() => new Map());
  // Leaving refreshes Practice, progress and Learning once.
  useEffect(
    () => () => void invalidateStudy(qc, workspaceId),
    [qc, workspaceId]
  );
  const { items, ref } = running;
  const item = items[index];
  const record = item ? checked.get(keyOf(item)) : undefined;
  const type = item?.question?.parts[0]?.answer.type;

  async function end() {
    if (checked.size === 0) return onClose();
    await finish(ref.id);
    onDone(ref.id);
  }
  // The timer ends the session as End session does. A tick that sees none left
  // calls the latest end, which knows what has been checked.
  const [left, setLeft] = useState(() =>
    endsAt === null ? null : endsAt - Date.now()
  );
  const latestEnd = useRef(end);
  latestEnd.current = end;
  useEffect(() => {
    if (endsAt === null) return;
    const tick = setInterval(() => {
      const remaining = endsAt - Date.now();
      setLeft(remaining);
      if (remaining <= 0) {
        clearInterval(tick);
        void latestEnd.current();
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [endsAt]);
  function next() {
    if (index + 1 < items.length) setIndex(index + 1);
    // Every served item answered: the server finished the session.
    else onDone(ref.id);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto px-4 pt-4 pb-24 sm:px-6 lg:px-9 lg:pt-6 lg:pb-10">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 truncate font-bold">{title}</span>
        <span className="t-meta text-fg-muted">
          {m.practice_position({ position: index + 1, total: items.length })}
        </span>
        <span
          aria-hidden
          className="inline-block h-1 w-35 overflow-hidden rounded-full bg-divider"
        >
          <span
            className="block h-full bg-solid-accent-1"
            style={{ width: `${((index + 1) / items.length) * 100}%` }}
          />
        </span>
        {left !== null && (
          <span className="t-meta font-semibold text-fg-secondary">
            {timeLeft(left)}
          </span>
        )}
        <UnderlineLink
          className="ml-auto text-[13px]"
          disabled={finishing}
          noArrow
          onClick={() => void end()}
        >
          {m.practice_end()}
        </UnderlineLink>
      </div>
      {item && (
        <div
          className="motion-safe:motion-text-in mx-auto mt-8 flex w-full max-w-180 flex-col gap-3.5 sm:mt-14"
          key={keyOf(item)}
        >
          <div className="flex items-center gap-2">
            <span className="t-meta font-semibold text-fg-muted">
              {m.practice_question_meta({
                number: index + 1,
                type: type ? answerLabels[type]() : '',
              })}
            </span>
            <ReasonChip reason={item.reason} />
          </div>
          {record ? (
            <>
              <CheckedQuestion
                answers={record.answers}
                question={record.question}
              />
              <div className="mt-2.5 flex justify-end">
                <Button iconRight="arrowRight" onClick={next}>
                  {m.action_next()}
                </Button>
              </div>
            </>
          ) : (
            <QuestionItem
              item={item}
              onCheck={() => markGettingStarted('practice')}
              onChecked={(graded, answers) =>
                setChecked((map) =>
                  new Map(map).set(keyOf(item), {
                    answers,
                    question: graded.question as Question,
                  })
                )
              }
              session={ref}
              source={false}
            />
          )}
        </div>
      )}
    </div>
  );
}

type Outcome = 'right' | 'partly' | 'wrong';
const OUTCOME: Record<Outcome, { label: () => string; fill: string }> = {
  partly: { fill: 'bg-solid-warning', label: m.practice_outcome_partly },
  right: { fill: 'bg-solid-success', label: m.practice_outcome_right },
  wrong: { fill: 'bg-solid-error', label: m.practice_outcome_wrong },
};
function outcomeOf(a: ReviewAnswer): Outcome {
  const correct = a.correct ?? 0;
  if (correct >= (a.total ?? 0)) return 'right';
  return correct > 0 ? 'partly' : 'wrong';
}

/** Session done (F4): how many were right, every question with its result
 * and why it came, a link back to Practice and Practise again. */
export function PracticeResult({
  onAgain,
  onBack,
  sessionId,
}: {
  onAgain: (start: PracticeStart) => void;
  onBack: () => void;
  sessionId: string;
}) {
  const { data, error, isError, isPending, refetch } = useReviewResult(
    sessionId,
    { errorBoundary: false }
  );
  if (isPending)
    return (
      <PracticeFrame>
        <SkeletonList count={6} rowHeight={36} />
      </PracticeFrame>
    );
  if (isError)
    return (
      <PracticeFrame>
        <ErrorState
          action={
            <Button onClick={() => void refetch()} variant="outline">
              {m.action_retry()}
            </Button>
          }
          errorId={unexpectedErrorId(error)}
          title={m.practice_load_failed()}
          variant="panel"
        />
      </PracticeFrame>
    );
  const { session } = data;
  const questions = data.items.filter((it) => it.kind === 'question');
  const right = questions.filter((a) => outcomeOf(a) === 'right').length;
  const { group } = session;
  return (
    <PracticeFrame>
      <div className="flex w-full max-w-220 flex-col">
        <div className="flex flex-wrap items-center gap-x-3">
          <h1 className="t-page-title">
            {m.practice_session_title({
              topic: groupLabel(session.group, session.topicName),
            })}
          </h1>
          <span className="t-meta mt-1.5 text-fg-muted">
            {m.practice_done()}
          </span>
        </div>
        <p className="mt-4.5 font-extrabold text-[2.5rem] leading-[1.15] tracking-[-0.02rem]">
          {m.practice_right_of({ correct: right, total: questions.length })}
        </p>
        <h2 className="t-label mt-7 text-fg-muted uppercase">
          {m.practice_col_questions()}
        </h2>
        <ol className="mt-2">
          {questions.map((a, i) => {
            const outcome = outcomeOf(a);
            return (
              <li
                className="grid min-h-9 grid-cols-[16px_10px_minmax(0,1fr)_auto] items-center gap-2.5 border-divider border-b sm:grid-cols-[24px_72px_minmax(0,1fr)_auto] sm:gap-3"
                key={keyOf(a)}
              >
                <span className="t-meta font-bold text-fg-muted">{i + 1}</span>
                <span className="t-meta flex items-center gap-1.75 font-semibold text-fg-secondary">
                  <span
                    className={cn(
                      'size-2.5 shrink-0 rounded-xs',
                      OUTCOME[outcome].fill
                    )}
                  />
                  {/* Phones keep the square; the word goes to screen readers. */}
                  <span className="max-sm:sr-only">
                    {OUTCOME[outcome].label()}
                  </span>
                </span>
                <span className="truncate">
                  <TextView
                    className="whitespace-nowrap"
                    text={questionLine(a.question)}
                  />
                </span>
                <ReasonChip reason={a.reason} />
              </li>
            );
          })}
        </ol>
        <div className="mt-5.5 flex items-center gap-4">
          <UnderlineLink
            className="text-fg"
            iconLeft="navigationBack"
            noArrow
            onClick={onBack}
          >
            {m.study_panel_practice()}
          </UnderlineLink>
          <Button
            className="ml-auto"
            onClick={() =>
              onAgain({
                group,
                topicId: session.topicId,
              })
            }
            variant="outline"
          >
            {m.practice_again()}
          </Button>
        </div>
      </div>
    </PracticeFrame>
  );
}
