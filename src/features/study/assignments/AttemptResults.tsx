import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMarkAssignmentAnswer } from '@/api/hooks';
import type {
  Assignment,
  AssignmentAttempt,
  AssignmentGradedPart,
  AssignmentGradedQuestion,
} from '@/api/types';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { userToast } from '@/components/ui/userToast';
import { QuestionBlockView, TextView } from '@/features/questions/QuestionView';
import type { Question, QuestionBlock } from '@/features/questions/types';
import { questionMarks } from '@/features/questions/types';
import { formatPoints } from '@/features/quizzes/grade';
import { QuestionRunner } from '@/features/quizzes/QuestionRunner';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';
import { questionLine } from '../practice/practiceText';
import { PracticeFrame } from '../practice/studyPage';
import { BackToAssignments } from './AssignmentAttemptPage';
import {
  dayLabel,
  markSteps,
  markText,
  OUTCOME_LABEL,
  OUTCOME_SQUARE,
  type Outcome,
  percentText,
  questionOutcome,
} from './assignmentText';
import { useAssignmentStart } from './useAssignmentStart';

const OUTCOME_CHIP: Record<Outcome, string> = {
  partly: 'bg-tint-warning text-tint-warning-fg',
  right: 'bg-tint-success text-tint-success-fg',
  waiting: 'bg-page-hover text-fg-secondary',
  wrong: 'bg-tint-error text-tint-error-fg',
};

const CHIP =
  'inline-flex h-5.5 items-center rounded-md px-1.75 font-semibold text-xs';

/** Full, Partly or None against a marking point. */
function ItemChip({ awarded, marks }: { awarded: number; marks: number }) {
  const outcome: Outcome =
    awarded >= marks ? 'right' : awarded > 0 ? 'partly' : 'wrong';
  return (
    <span className={cn(CHIP, OUTCOME_CHIP[outcome])}>
      {awarded >= marks
        ? m.assignment_item_full()
        : awarded > 0
          ? m.practice_outcome_partly()
          : m.assignment_item_none()}
    </span>
  );
}

/** Results (A5): the mark top right, then right, partly and wrong with
 * Practise again, then every question, opening to its answer. The class's staff
 * reach the same layout from the report's Members tab (G3m) and can change any
 * mark there. */
export function AttemptResults({
  assignment,
  attempt,
}: {
  assignment: Assignment;
  attempt: AssignmentAttempt;
}) {
  const staff = !!assignment.manage;
  const { dialog, start, starting } = useAssignmentStart(
    assignment.workspaceId
  );
  const questions = attempt.questions as AssignmentGradedQuestion[];
  const [opened, setOpened] = useState<string[]>(() => {
    const first = questions.find((q) => questionOutcome(q) === 'waiting');
    return first ? [first.id] : [];
  });
  const counts: Record<Outcome, number> = {
    partly: 0,
    right: 0,
    waiting: 0,
    wrong: 0,
  };
  for (const q of questions) counts[questionOutcome(q)]++;
  const decided = attempt.total - attempt.waitingMarks;
  const when = attempt.submittedAt ? dayLabel(attempt.submittedAt) : '';
  const practice = assignment.practiceQuizId;
  const left =
    !staff &&
    !assignment.closedAt &&
    assignment.mine &&
    assignment.attempts - assignment.mine.attemptsUsed > 0;
  return (
    <PracticeFrame>
      <div className="flex w-full flex-col">
        <BackToAssignments
          label={staff ? m.assignment_tab_members() : undefined}
          search={
            staff
              ? {
                  assignment: assignment.id,
                  study: 'assignments' as const,
                  tab: 'members' as const,
                }
              : undefined
          }
        />
        <div className="mt-3 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="t-page-title">{attempt.title}</h1>
            <p className="t-meta mt-0.5 flex flex-wrap items-center gap-x-2 text-fg-muted">
              {staff && (
                <span className="font-semibold text-fg-secondary">
                  {attempt.userName}
                </span>
              )}
              {m.assignment_submitted_on({ date: when })}
              {attempt.late && (
                <span className="font-semibold text-tint-warning-fg">
                  {m.assignment_late()}
                </span>
              )}
              {attempt.autoSubmitted && (
                <span>{m.assignment_auto_submitted()}</span>
              )}
            </p>
          </div>
          <p className="flex shrink-0 items-baseline gap-1.5 whitespace-nowrap">
            <span className="font-extrabold text-[1.875rem] leading-none tracking-[-0.02rem] sm:text-[2.125rem]">
              {markText(attempt.correct, decided)}
            </span>
            {decided > 0 && (
              <span className="t-meta font-semibold text-fg-muted">
                {percentText(attempt.correct / decided)}
              </span>
            )}
          </p>
        </div>
        <div className="mt-5.5 flex flex-wrap items-center gap-2">
          {(['right', 'partly', 'wrong', 'waiting'] as const).map(
            (outcome) =>
              counts[outcome] > 0 && (
                <span className={cn(CHIP, OUTCOME_CHIP[outcome])} key={outcome}>
                  {`${counts[outcome]} ${OUTCOME_LABEL[outcome]().toLowerCase()}`}
                </span>
              )
          )}
          <div className="ml-auto flex items-center gap-2">
            {left && (
              <Button
                disabled={starting}
                onClick={() => start(assignment)}
                variant="outline"
              >
                {m.assignment_attempt_again()}
              </Button>
            )}
            {practice && !staff && (
              <Button asChild iconLeft="ai" variant="outline">
                <Link
                  params={{ quizId: practice }}
                  to="/quizzes/$quizId/attempt"
                >
                  {m.practice_again()}
                </Link>
              </Button>
            )}
          </div>
        </div>
        {attempt.waitingAnswers > 0 && !staff && (
          <p className="t-meta mt-3 text-fg-secondary">
            {attempt.waitingAnswers === 1
              ? m.assignment_waiting_one({ name: assignment.postedBy })
              : m.assignment_waiting({
                  count: attempt.waitingAnswers,
                  name: assignment.postedBy,
                })}
          </p>
        )}
        {dialog}
        <ol className="mt-4 border-divider border-t">
          {questions.map((question, i) => (
            <ResultRow
              assignment={assignment}
              attempt={attempt}
              key={question.id}
              number={i + 1}
              onToggle={() =>
                setOpened((list) =>
                  list.includes(question.id)
                    ? list.filter((id) => id !== question.id)
                    : [...list, question.id]
                )
              }
              open={opened.includes(question.id)}
              question={question}
              staff={staff}
            />
          ))}
        </ol>
      </div>
    </PracticeFrame>
  );
}

function ResultRow({
  assignment,
  attempt,
  number,
  onToggle,
  open,
  question,
  staff,
}: {
  assignment: Assignment;
  attempt: AssignmentAttempt;
  number: number;
  onToggle: () => void;
  open: boolean;
  question: AssignmentGradedQuestion;
  staff: boolean;
}) {
  const outcome = questionOutcome(question);
  const awarded = question.parts.reduce((n, p) => n + (p.awarded ?? 0), 0);
  const marks = questionMarks(question as Question);
  return (
    <li className="border-divider border-b">
      <button
        aria-expanded={open}
        className="grid min-h-8 w-full grid-cols-[10px_30px_minmax(0,1fr)_auto_20px] items-center gap-2 py-1 text-left outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset sm:grid-cols-[92px_34px_minmax(0,1fr)_60px_20px] sm:gap-2.5"
        onClick={onToggle}
        type="button"
      >
        <span className="t-meta flex items-center gap-1.75 font-semibold text-fg-secondary">
          <span
            className={cn(
              'size-2.5 shrink-0 rounded-xs',
              OUTCOME_SQUARE[outcome]
            )}
          />
          <span className="truncate max-sm:sr-only">
            {OUTCOME_LABEL[outcome]()}
          </span>
        </span>
        <span className="t-meta font-bold text-fg-muted">{`Q${number}`}</span>
        <span className={cn('truncate', open && 'font-bold')}>
          <TextView
            className="whitespace-nowrap"
            text={questionLine(question as Question)}
          />
        </span>
        <span className="whitespace-nowrap text-right font-bold">
          {outcome === 'waiting' ? (
            <span className="t-meta font-semibold text-fg-muted">
              {`– / ${formatPoints(marks)}`}
            </span>
          ) : (
            <>
              {formatPoints(awarded)}{' '}
              <span className="font-semibold text-fg-muted">
                / {formatPoints(marks)}
              </span>
            </>
          )}
        </span>
        <Icon
          className={cn(
            'justify-self-end text-fg-muted transition-transform',
            open && 'rotate-180'
          )}
          name="chevronDown"
          size={16}
        />
      </button>
      {open && (
        <ResultBody
          assignment={assignment}
          attempt={attempt}
          question={question}
          staff={staff}
        />
      )}
    </li>
  );
}

/** Blocks a row's single line doesn't already show: images, tables, more text. */
function extraBlocks(question: AssignmentGradedQuestion): QuestionBlock[] {
  const blocks = [...question.stem];
  if (question.parts.length === 1) blocks.push(...question.parts[0].blocks);
  return blocks.slice(1).length > 0 || blocks.some((b) => b.type !== 'text')
    ? blocks
    : [];
}

function ResultBody({
  assignment,
  attempt,
  question,
  staff,
}: {
  assignment: Assignment;
  attempt: AssignmentAttempt;
  question: AssignmentGradedQuestion;
  staff: boolean;
}) {
  const { mutate, isPending } = useMarkAssignmentAnswer(
    assignment.workspaceId,
    assignment.id
  );
  const [items, setItems] = useState<Record<string, (number | null)[]>>(() =>
    Object.fromEntries(
      question.parts
        .filter((p) => p.answer.type === 'open')
        .map((p) => [
          p.id,
          (p.markscheme ?? []).map((_, i) =>
            p.pending ? null : (p.itemAwards?.[i] ?? 0)
          ),
        ])
    )
  );
  const [closed, setClosed] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      question.parts
        .filter((p) => p.answer.type !== 'open')
        .map((p) => [p.id, p.awarded ?? 0])
    )
  );
  const [comment, setComment] = useState(question.comment ?? '');
  const complete = Object.values(items).every((list) =>
    list.every((v) => v !== null)
  );
  const save = () =>
    mutate(
      {
        attemptId: attempt.id,
        mark: {
          comment: comment.trim(),
          parts: question.parts.map((part) =>
            part.answer.type === 'open'
              ? {
                  items: (items[part.id] ?? []).map((v) => v ?? 0),
                  partId: part.id,
                }
              : { mark: closed[part.id], partId: part.id }
          ),
          questionId: question.id,
        },
      },
      {
        onError: (error) =>
          userToast({
            title: errorCopy(error, m.assignment_mark_failed()),
            variant: 'error',
          }),
        onSuccess: () =>
          userToast({ title: m.assignment_mark_saved(), variant: 'success' }),
      }
    );
  const extra = extraBlocks(question);
  return (
    <div className="flex flex-col gap-3 pb-3 sm:pr-7.5 sm:pl-36.5">
      {extra.length > 0 && (
        <div className="grid gap-2">
          {extra.map((block, i) => (
            <QuestionBlockView block={block} key={i} />
          ))}
        </div>
      )}
      {question.parts.map((part) =>
        part.answer.type === 'open' ? (
          <OpenPart
            answer={attempt.answers[part.id]}
            editing={staff}
            items={items[part.id] ?? []}
            key={part.id}
            onItem={(i, value) =>
              setItems((all) => ({
                ...all,
                [part.id]: (all[part.id] ?? []).map((v, j) =>
                  j === i ? value : v
                ),
              }))
            }
            part={part}
            showKeys={attempt.showAnswers}
          />
        ) : (
          <ClosedPart
            answers={attempt.answers}
            editing={staff}
            key={part.id}
            mark={closed[part.id] ?? 0}
            onMark={(value) =>
              setClosed((all) => ({ ...all, [part.id]: value }))
            }
            part={part}
            question={question}
            showKeys={attempt.showAnswers}
          />
        )
      )}
      {staff ? (
        <div className="flex flex-col gap-2">
          <Input
            aria-label={m.assignment_comment_for({ name: attempt.userName })}
            onChange={(event) => setComment(event.target.value)}
            placeholder={m.assignment_comment_for({ name: attempt.userName })}
            value={comment}
          />
          <div className="flex justify-end">
            <Button disabled={isPending || !complete} onClick={save} size="sm">
              {m.assignment_save_marks()}
            </Button>
          </div>
        </div>
      ) : (
        question.comment && (
          <div className="flex items-center gap-2.5">
            <Avatar
              aria-hidden
              className="size-6.5 text-[10px]"
              name={question.commentByName ?? ''}
              src={question.commentByAvatarUrl || undefined}
            />
            <p className="min-w-0">
              <b className="font-bold">{question.commentByName}</b>
              {' · '}
              {question.comment}
            </p>
          </div>
        )
      )}
    </div>
  );
}

function MarkSelect({
  label,
  marks,
  onChange,
  value,
}: {
  label: string;
  marks: number;
  onChange: (value: number) => void;
  value: number | null;
}) {
  return (
    <Select
      onValueChange={(next) => onChange(Number(next))}
      value={value === null ? '' : String(value)}
    >
      <SelectTrigger aria-label={label} className="h-7 w-25 px-2.5">
        <SelectValue placeholder={`– / ${formatPoints(marks)}`} />
      </SelectTrigger>
      <SelectContent>
        {markSteps(marks).map((step) => (
          <SelectItem key={step} value={String(step)}>
            {markText(step, marks)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A written answer: the answer, the marking points with their marks, and the
 * worked solution folded away. */
function OpenPart({
  answer,
  editing,
  items,
  onItem,
  part,
  showKeys,
}: {
  answer: unknown;
  editing: boolean;
  items: (number | null)[];
  onItem: (index: number, value: number) => void;
  part: AssignmentGradedPart;
  showKeys: boolean;
}) {
  const text = typeof answer === 'string' ? answer : '';
  const scheme = part.markscheme ?? [];
  return (
    <>
      <div>
        <p className="t-label text-fg-muted uppercase">
          {m.assignment_your_answer()}
        </p>
        <div className="mt-1.5 whitespace-pre-wrap rounded-lg border border-line px-3 py-2">
          {text || (
            <span className="text-fg-muted">{m.assignment_not_answered()}</span>
          )}
        </div>
      </div>
      {part.pending && !editing && (
        <span
          className={cn(CHIP, OUTCOME_CHIP.waiting, 'self-start')}
          data-not-marked
        >
          {m.assignment_not_marked()}
        </span>
      )}
      {showKeys && scheme.length > 0 && (
        <div>
          <p className="t-label text-fg-muted uppercase">
            {m.assignment_marking_points()}
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {scheme.map((item, i) => (
              <li
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,1fr)_64px_100px]"
                key={i}
              >
                <TextView text={item.text} />
                <span className="max-sm:hidden">
                  {items[i] !== null && items[i] !== undefined && (
                    <ItemChip awarded={items[i]} marks={item.marks} />
                  )}
                </span>
                {editing ? (
                  <MarkSelect
                    label={item.text}
                    marks={item.marks}
                    onChange={(value) => onItem(i, value)}
                    value={items[i] ?? null}
                  />
                ) : (
                  <span className="justify-self-end whitespace-nowrap font-bold">
                    {items[i] === null || items[i] === undefined
                      ? `– / ${formatPoints(item.marks)}`
                      : markText(items[i], item.marks)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {showKeys && part.solution.length > 0 && (
        <WorkedSolution blocks={part.solution} />
      )}
    </>
  );
}

function WorkedSolution({ blocks }: { blocks: QuestionBlock[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-divider border-t">
      <button
        aria-expanded={open}
        className="flex h-7.5 w-full items-center justify-between font-semibold outline-none focus-visible:ring-2 focus-visible:ring-action"
        onClick={() => setOpen(!open)}
        type="button"
      >
        {m.question_ui_worked_solution()}
        <Icon
          className={cn(
            'text-fg-muted transition-transform',
            open && 'rotate-180'
          )}
          name="chevronDown"
          size={16}
        />
      </button>
      {open && (
        <div className="grid gap-2 pb-1">
          {blocks.map((block, i) => (
            <QuestionBlockView block={block} key={i} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A marked-by-rule part: as a quiz's checked question, or with no keys the
 * member's own answer alone; staff can change its mark. */
function ClosedPart({
  answers,
  editing,
  mark,
  onMark,
  part,
  question,
  showKeys,
}: {
  answers: AssignmentAttempt['answers'];
  editing: boolean;
  mark: number;
  onMark: (value: number) => void;
  part: AssignmentGradedPart;
  question: AssignmentGradedQuestion;
  showKeys: boolean;
}) {
  const single = question.parts.length === 1;
  const plainText = part.blocks.every((block) => block.type === 'text');
  const shown = {
    ...question,
    parts: [
      {
        ...part,
        // A single part's line already heads the row; a gaps part keeps its text.
        blocks:
          single && plainText && part.answer.type !== 'gaps' ? [] : part.blocks,
      },
    ],
    stem: [],
  } as unknown as Question;
  return (
    <div className="flex flex-col gap-2">
      <QuestionRunner
        answers={answers}
        disabled
        headerMarks={false}
        question={shown}
        review={showKeys}
      />
      {editing && (
        <div className="flex items-center justify-end gap-2">
          <span className="t-meta text-fg-muted">
            {m.assignment_change_mark()}
          </span>
          <MarkSelect
            label={m.assignment_change_mark()}
            marks={part.marks}
            onChange={onMark}
            value={mark}
          />
        </div>
      )}
    </div>
  );
}
