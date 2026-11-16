import { useEffect, useMemo, useState } from 'react';
import {
  useApproveAssignmentAIMarks,
  useAssignmentAttempt,
  useMarkAssignmentAnswer,
  useMarkAssignmentWithAI,
} from '@/api/hooks';
import type {
  Assignment,
  AssignmentAnswerRow,
  AssignmentGradedQuestion,
  AssignmentReport,
  PaperFile,
} from '@/api/types';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { userToast } from '@/components/ui/userToast';
import { AiWarning } from '@/features/questions/AiWarning';
import { stripMarks } from '@/features/questions/parseMarkedText';
import { TextView } from '@/features/questions/QuestionView';
import {
  modelMarked,
  type Question,
  questionMarks,
} from '@/features/questions/types';
import { ReviewedDrawing } from '@/features/quizzes/drawing/DrawingAnswer';
import { type Answer, formatPoints } from '@/features/quizzes/grade';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';
import { questionLine } from '../practice/practiceText';
import type { AssignmentsSearch } from './AssignmentsPage';
import { markSteps, markText } from './assignmentText';
import { PaperPages } from './LazyPaper';
import { MarkingNow } from './MarkingNow';

type Selected = { attemptId: string; questionId: string };
/** Which list a phone shows (P1). */
type Screen = 'questions' | 'members' | 'answer';
const same = (row: AssignmentAnswerRow, s: Selected | null) =>
  row.questionId === s?.questionId && row.attemptId === s?.attemptId;
const selection = ({ attemptId, questionId }: AssignmentAnswerRow) => ({
  attemptId,
  questionId,
});

/** Waiting answers first, then the marked ones, keeping the given order. */
const waitingFirst = (rows: AssignmentAnswerRow[]) => [
  ...rows.filter((r) => r.waiting),
  ...rows.filter((r) => !r.waiting),
];

const COUNT =
  'inline-grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-tint-accent-1 px-1.5 font-bold text-tint-accent-1-fg text-xs';
const NOT_GRADED =
  'inline-flex h-5.5 shrink-0 items-center rounded-md bg-tint-warning px-1.75 font-semibold text-tint-warning-fg text-xs';

/** Approve AI grades (Epo 2026-11-14, mock A + Overview, after Gradescope and
 * Crowdmark): a row for the whole assignment (what waits, Grade with AI for
 * the answers the AI couldn't grade, Overview, Next to approve), then the
 * questions (To approve with counts, Done), the chosen question's members and
 * the grading pane. Overview is the members × questions grid; a cell opens
 * that answer. `member` (from the Members tab's "2 to approve") keeps the
 * counts and Next to one member's answers. Rows the AI couldn't grade (no
 * credits, a file, an error) read Not graded; the pane says why. */
export function ApproveTab({
  assignment,
  report,
  search,
}: {
  assignment: Assignment;
  report: AssignmentReport;
  search: AssignmentsSearch;
}) {
  const names = useMemo(
    () => new Map(report.members.map((row) => [row.userId, row])),
    [report.members]
  );
  // Graded by hand (A4): no AI grades to approve; the AI only reads papers.
  const manual = assignment.manage?.marking === 'manual';
  // A paper still to read waits on its closed questions too, which Grade with
  // AI reads (finding 2).
  const openQuestions = report.questions.filter(
    (q) =>
      q.question.parts.some((p) => modelMarked(p.answer.type)) ||
      report.answers.some(
        (row) => row.waiting && row.questionId === q.question.id
      )
  );
  const order = new Map(report.questions.map((q, i) => [q.question.id, i]));
  const numberOf = (id: string) => (order.get(id) ?? 0) + 1;
  const { isPending: marking, mutate: markWithAI } = useMarkAssignmentWithAI(
    assignment.id
  );
  const { isPending: approving, mutate: approveAll } =
    useApproveAssignmentAIMarks(assignment.workspaceId, assignment.id);
  const [member, setMember] = useState<string | undefined>(
    search.question ? undefined : search.member
  );
  const mine = (row: AssignmentAnswerRow) => !member || row.userId === member;
  // Every waiting answer in reading order: what Next and Approve move through.
  const waiting = report.answers
    .filter((row) => row.waiting && mine(row))
    .sort(
      (a, b) => (order.get(a.questionId) ?? 0) - (order.get(b.questionId) ?? 0)
    );
  const [question, setQuestion] = useState<string | undefined>(
    search.question ?? waiting[0]?.questionId ?? openQuestions[0]?.question.id
  );
  const rows = waitingFirst(
    report.answers.filter((row) => row.questionId === question)
  );
  const [selected, setSelected] = useState<Selected | null>(() => {
    const row = waiting.find(
      (r) => !search.question || r.questionId === search.question
    );
    return row ? selection(row) : rows[0] ? selection(rows[0]) : null;
  });
  const [overview, setOverview] = useState(false);
  const [screen, setScreen] = useState<Screen>('questions');
  const current = report.answers.find((row) => same(row, selected));
  // The list changed under the selection: take its first row.
  useEffect(() => {
    if (rows.length && !rows.some((row) => same(row, selected)))
      setSelected(selection(rows[0]));
  }, [rows, selected]);

  if (openQuestions.length === 0)
    return (
      <p className="t-meta mt-6 text-fg-muted">{m.assignment_no_open()}</p>
    );

  const open = (row: AssignmentAnswerRow) => {
    setQuestion(row.questionId);
    setSelected(selection(row));
  };
  const pickQuestion = (id: string) => {
    const list = waitingFirst(
      report.answers.filter((row) => row.questionId === id && mine(row))
    );
    setQuestion(id);
    setSelected(list[0] ? selection(list[0]) : null);
  };
  // The next waiting answer after this one, round to the start.
  const next = (() => {
    const i = waiting.findIndex((row) => same(row, selected));
    return [...waiting.slice(i + 1), ...waiting.slice(0, Math.max(i, 0))].find(
      (row) => !same(row, selected)
    );
  })();
  const toApprove = waiting.filter((row) => manual || row.aiMarked).length;
  const notGraded = manual ? 0 : waiting.filter((row) => !row.aiMarked).length;
  // Grade with AI runs every answer the AI couldn't grade, in every question;
  // under manual marking it is Read papers again, reading papers still to
  // read without grading, on each member's credits (Q725).
  const retry = manual
    ? report.papersToRead
    : report.answers.filter(
        (row) => row.waiting && !row.aiMarked && !row.handMarking
      ).length;
  const failed = (error: unknown) =>
    userToast({
      title: errorCopy(error, m.assignment_mark_failed()),
      variant: 'error',
    });
  const waitingIn = (id: string) =>
    waiting.filter((row) => row.questionId === id).length;
  const toDo = openQuestions.filter((q) => waitingIn(q.question.id) > 0);
  const done = openQuestions.filter((q) => waitingIn(q.question.id) === 0);
  // Approve all clears the chosen question's AI grades.
  const approvable = rows.some((row) => row.waiting && row.aiMarked);
  const questionOf = (id: string) =>
    report.questions.find((q) => q.question.id === id)?.question;
  const step = (delta: number) => {
    const i = rows.findIndex((row) => same(row, selected));
    const to = rows[i + delta];
    if (to) setSelected(selection(to));
  };
  // A member with two answers listed: a submission that doesn't count yet still
  // waits, so each says which it is.
  const repeated = (row: AssignmentAnswerRow) =>
    rows.some(
      (other) =>
        other !== row &&
        other.userId === row.userId &&
        other.questionId === row.questionId
    );
  const questionRow = (q: (typeof openQuestions)[number]) => {
    const count = waitingIn(q.question.id);
    const on = q.question.id === question;
    return (
      <li key={q.question.id}>
        <button
          aria-current={on || undefined}
          className={cn(
            '-mx-2.5 grid min-h-13 w-[calc(100%+1.25rem)] grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2.5 py-1.5 text-left outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action',
            on && 'md:bg-page-hover md:hover:bg-page-hover'
          )}
          data-question-row={q.question.id}
          onClick={() => {
            pickQuestion(q.question.id);
            goTo('members');
          }}
          type="button"
        >
          <span className="flex min-w-0 flex-col">
            <span className="t-meta text-fg-secondary">
              {`Q${numberOf(q.question.id)} · ${m.question_ui_marks({ count: questionMarks(q.question) })}`}
            </span>
            <TextView
              className={cn(
                'truncate whitespace-nowrap',
                count === 0 && 'text-fg-muted'
              )}
              marks
              text={questionLine(q.question)}
            />
          </span>
          {count > 0 ? (
            <span className={COUNT}>{count}</span>
          ) : (
            <Icon className="text-fg-muted" name="check" size={18} />
          )}
        </button>
      </li>
    );
  };
  // Phones go one screen at a time (P1): the questions, one question's
  // members, then one answer; tablets keep members | answer under a strip of
  // question chips (T1); from lg the three columns.
  const goTo = (to: Screen) => {
    setScreen(to);
    window.scrollTo?.(0, 0);
  };
  const position = rows.findIndex((row) => same(row, selected));
  const chip = (q: (typeof openQuestions)[number]) => {
    const count = waitingIn(q.question.id);
    const on = q.question.id === question;
    return (
      <button
        aria-current={on || undefined}
        className={cn(
          'inline-flex h-8.5 shrink-0 items-center gap-2 rounded-lg border px-2.75 font-semibold text-sm outline-none focus-visible:ring-2 focus-visible:ring-action',
          on
            ? 'border-fg bg-fg text-surface'
            : 'border-line bg-surface hover:bg-surface-hover-bg',
          !on && count === 0 && 'text-fg-secondary'
        )}
        data-question-chip={q.question.id}
        key={q.question.id}
        onClick={() => pickQuestion(q.question.id)}
        type="button"
      >
        {`Q${numberOf(q.question.id)}`}
        {count > 0 ? (
          <span className={cn(COUNT, on && 'bg-surface text-fg')}>{count}</span>
        ) : (
          <Icon name="check" size={16} />
        )}
      </button>
    );
  };
  return (
    <div
      className="flex min-h-0 flex-col"
      // Past the question list on a phone the page's own back link leads out,
      // so the workspace header and the report's head step aside (CSS).
      data-approve-drill={screen === 'questions' ? undefined : screen}
    >
      <div
        className={cn(
          'flex flex-wrap items-center gap-2 border-divider py-3 md:border-b',
          screen !== 'questions' && 'max-md:hidden'
        )}
      >
        <span className="t-meta text-fg-secondary">
          {m.assignment_to_approve({ count: toApprove })}
          {notGraded > 0 && (
            <>
              {' · '}
              <span className="font-semibold text-tint-warning-fg">
                {m.assignment_not_graded({ count: notGraded })}
              </span>
            </>
          )}
        </span>
        {report.marking ? (
          <span className="t-meta text-fg-secondary">
            {m.assignment_marking_progress({
              done: report.marking.done,
              total: report.marking.total,
            })}
          </span>
        ) : retry > 0 ? (
          <Button
            disabled={marking}
            onClick={() => markWithAI(undefined, { onError: failed })}
            size="sm"
            variant="outline"
          >
            {manual
              ? m.assignment_read_papers_again()
              : m.assignment_grade_count_with_ai({ count: retry })}
          </Button>
        ) : null}
        {member && (
          <span className="inline-flex h-7 items-center gap-1 rounded-md bg-page-hover pr-1 pl-2.5 font-semibold text-sm">
            {m.assignment_only_member({ name: names.get(member)?.name ?? '' })}
            <button
              aria-label={m.assignment_show_everyone()}
              className="grid size-5 place-items-center rounded text-fg-muted hover:text-fg"
              onClick={() => setMember(undefined)}
              type="button"
            >
              <Icon name="x" size={14} />
            </button>
          </span>
        )}
        <span className="flex-1 max-md:hidden" />
        <div className="grid gap-2 max-md:basis-full max-md:grid-cols-2 md:flex">
          <Button
            iconLeft="grid"
            onClick={() => setOverview(true)}
            size="sm"
            variant="outline"
          >
            {m.assignment_overview()}
          </Button>
          <Button
            className="md:hidden"
            disabled={!next && !current?.waiting}
            iconRight="arrowRight"
            onClick={() => {
              const first = waiting[0];
              if (first) open(first);
              goTo('answer');
            }}
            size="sm"
          >
            {m.assignment_start_approving()}
          </Button>
          <Button
            className="max-md:hidden"
            disabled={!next}
            iconRight="arrowRight"
            onClick={() => next && open(next)}
            size="sm"
            variant="outline"
          >
            {m.assignment_next_to_approve()}
          </Button>
        </div>
      </div>
      <div className="flex gap-2 overflow-x-auto border-divider border-b py-3 [scrollbar-width:none] max-md:hidden lg:hidden">
        {[...toDo, ...done].map(chip)}
      </div>
      <div className="flex min-h-0 flex-col md:grid md:grid-cols-[220px_minmax(0,1fr)] lg:grid-cols-[248px_250px_minmax(0,1fr)]">
        <div
          className={cn(
            'border-divider pt-1 md:max-lg:hidden lg:border-r lg:pr-5 lg:pb-6',
            screen !== 'questions' && 'max-md:hidden'
          )}
        >
          {toDo.length > 0 && (
            <>
              <p className="t-label pt-3 pb-1.5 text-fg-muted uppercase">
                {m.assignment_section_to_approve()}
              </p>
              <ul className="flex flex-col gap-0.5">{toDo.map(questionRow)}</ul>
            </>
          )}
          {done.length > 0 && (
            <>
              <p className="t-label pt-3 pb-1.5 text-fg-muted uppercase">
                {m.assignment_section_done()}
              </p>
              <ul className="flex flex-col gap-0.5">{done.map(questionRow)}</ul>
            </>
          )}
        </div>
        <div
          className={cn(
            'border-divider md:border-r md:pt-3 md:pr-5 md:pb-6 lg:px-5',
            screen !== 'members' && 'max-md:hidden'
          )}
        >
          <div className="flex flex-col items-start gap-3.5 md:hidden">
            <UnderlineLink
              className="text-fg"
              iconLeft="navigationBack"
              noArrow
              onClick={() => goTo('questions')}
            >
              {m.assignment_back_to_questions()}
            </UnderlineLink>
            {question && (
              <div>
                <p className="t-meta text-fg-secondary">
                  {`Q${numberOf(question)} · ${m.question_ui_marks({ count: questionMarks(questionOf(question) as Question) })}`}
                </p>
                <TextView
                  className="font-semibold"
                  marks
                  text={questionLine(questionOf(question))}
                />
              </div>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 pb-2 max-md:pt-4">
            <span className="t-meta text-fg-secondary">
              {m.assignment_to_approve({
                count: rows.filter(
                  (row) => row.waiting && (manual || row.aiMarked)
                ).length,
              })}
            </span>
            <span
              className={cn(manual && 'hidden')}
              title={approvable ? undefined : m.assignment_approve_all_waits()}
            >
              <Button
                disabled={!approvable || approving}
                onClick={() =>
                  question && approveAll(question, { onError: failed })
                }
                size="sm"
                variant="outline"
              >
                {m.assignment_approve_all()}
              </Button>
            </span>
          </div>
          <ul className="flex flex-col gap-0.5">
            {rows.map((row) => {
              const person = names.get(row.userId);
              const on = same(row, selected);
              return (
                <li key={`${row.questionId}/${row.attemptId}`}>
                  <button
                    aria-current={on || undefined}
                    className={cn(
                      '-mx-2.5 flex min-h-11 w-[calc(100%+1.25rem)] items-center gap-2.5 rounded-lg px-2.5 text-left font-semibold outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action',
                      on && 'md:bg-page-hover md:hover:bg-page-hover',
                      !row.waiting && 'text-fg-secondary'
                    )}
                    data-answer-row
                    onClick={() => {
                      setSelected(selection(row));
                      goTo('answer');
                    }}
                    type="button"
                  >
                    <Avatar
                      aria-hidden
                      className="size-6.5 shrink-0 text-[10px]"
                      name={person?.name ?? ''}
                      src={person?.avatarUrl || undefined}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {repeated(row)
                        ? `${person?.name} · ${m.assignment_attempt_number({ number: row.attemptNumber })}`
                        : person?.name}
                    </span>
                    {row.aiWarning && (
                      <Icon
                        className={cn(
                          'size-4.5 shrink-0',
                          row.aiWarning === 'error'
                            ? 'text-tint-error-fg'
                            : 'text-tint-warning-fg'
                        )}
                        name="alert"
                      />
                    )}
                    <AnswerState row={row} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <div
          className={cn(
            'min-w-0 md:py-4 md:pl-6 lg:pl-8',
            screen !== 'answer' && 'max-md:hidden'
          )}
        >
          <div className="mb-3.5 flex items-center justify-between gap-2 md:hidden">
            <UnderlineLink
              className="text-fg"
              iconLeft="navigationBack"
              noArrow
              onClick={() => goTo('members')}
            >
              {m.assignment_back_to_members({
                number: question ? numberOf(question) : 0,
              })}
            </UnderlineLink>
            {position >= 0 && (
              <span className="t-meta text-fg-secondary">
                {m.assignment_position({
                  number: position + 1,
                  total: rows.length,
                })}
              </span>
            )}
          </div>
          {current ? (
            <MarkPane
              assignment={assignment}
              avatar={names.get(current.userId)?.avatarUrl}
              canGoBack={position > 0}
              // Starts over from the AI's grades when they arrive.
              key={`${current.attemptId}/${current.questionId}/${current.aiMarked}`}
              name={names.get(current.userId)?.name ?? ''}
              // On to the next waiting answer, in the next question once
              // this one is cleared.
              onApproved={() => next && open(next)}
              onPrevious={() => step(-1)}
              row={current}
            />
          ) : (
            <p className="t-meta text-fg-muted">{m.assignment_no_answers()}</p>
          )}
        </div>
      </div>
      {overview && (
        <SimpleDialog
          onClose={() => setOverview(false)}
          open
          title={m.assignment_overview()}
          width={1040}
        >
          <OverviewGrid
            current={selected}
            names={names}
            numberOf={numberOf}
            onOpen={(row) => {
              open(row);
              setOverview(false);
              goTo('answer');
            }}
            questionOf={questionOf}
            questions={openQuestions.map((q) => q.question.id)}
            rows={report.answers}
          />
        </SimpleDialog>
      )}
    </div>
  );
}

/** An answer's state on its row: grading now, the AI's grade to approve, Not
 * graded (whatever stopped the AI) or Grade by hand, else its grade. */
function AnswerState({ row }: { row: AssignmentAnswerRow }) {
  if (row.marking) return <MarkingNow />;
  if (row.waiting && row.aiMarked)
    return (
      <span className="shrink-0 font-semibold text-fg-secondary">
        {m.assignment_ai_mark({ mark: markText(row.aiAwarded, row.marks) })}
      </span>
    );
  if (row.waiting)
    return (
      <span className={NOT_GRADED}>
        {/* A drawing saved with no grading image (Q695). */}
        {row.handMarking
          ? m.assignment_mark_by_hand()
          : m.assignment_not_graded_badge()}
      </span>
    );
  return (
    <span className="shrink-0 font-semibold text-fg-secondary">
      {markText(row.awarded, row.marks)}
    </span>
  );
}

/** Overview (Crowdmark's grid): members as rows, the questions to approve as
 * columns, each answer's state in its cell; a cell opens it. */
function OverviewGrid({
  current,
  names,
  numberOf,
  onOpen,
  questions,
  questionOf,
  rows,
}: {
  current: Selected | null;
  names: Map<string, { avatarUrl?: string; name: string }>;
  numberOf: (id: string) => number;
  onOpen: (row: AssignmentAnswerRow) => void;
  questions: string[];
  questionOf: (id: string) => Question | undefined;
  rows: AssignmentAnswerRow[];
}) {
  const people = [...new Set(rows.map((row) => row.userId))];
  const legend = [
    ['bg-tint-accent-1', m.assignment_section_to_approve()],
    ['bg-tint-warning', m.assignment_not_graded_badge()],
    ['border border-divider', m.assignment_overview_approved()],
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="t-meta flex flex-wrap gap-x-4 gap-y-1 text-fg-secondary">
        {legend.map(([swatch, label]) => (
          <span className="inline-flex items-center gap-1.5" key={label}>
            <span className={cn('size-3.5 rounded', swatch)} />
            {label}
          </span>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 bg-surface-bg py-1.5 pr-3 text-left font-semibold text-fg-secondary text-xs">
                {m.assignment_col_member()}
              </th>
              {questions.map((id) => (
                <th
                  className="px-1 py-1.5 text-center font-semibold text-fg-secondary text-xs"
                  key={id}
                  title={stripMarks(questionLine(questionOf(id)))}
                >
                  {`Q${numberOf(id)}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {people.map((userId) => {
              const person = names.get(userId);
              return (
                <tr className="border-divider border-t" key={userId}>
                  <td className="sticky left-0 bg-surface-bg py-1 pr-3">
                    <span className="flex items-center gap-2 whitespace-nowrap font-semibold">
                      <Avatar
                        aria-hidden
                        className="size-6 shrink-0 text-[10px]"
                        name={person?.name ?? ''}
                        src={person?.avatarUrl || undefined}
                      />
                      {person?.name}
                    </span>
                  </td>
                  {questions.map((id) => {
                    // A waiting answer before a counted one, as the lists show.
                    const row = waitingFirst(
                      rows.filter(
                        (r) => r.userId === userId && r.questionId === id
                      )
                    )[0];
                    return (
                      <td className="p-0.5" key={id}>
                        {row ? (
                          <button
                            aria-label={`Q${numberOf(id)} · ${person?.name ?? ''}`}
                            className={cn(
                              'flex h-8.5 w-full min-w-16 items-center justify-center rounded-md px-1.5 font-semibold text-xs outline-none hover:brightness-95 focus-visible:ring-2 focus-visible:ring-action',
                              row.waiting && row.aiMarked
                                ? 'bg-tint-accent-1 text-tint-accent-1-fg'
                                : row.waiting
                                  ? 'bg-tint-warning text-tint-warning-fg'
                                  : 'text-fg-secondary hover:bg-surface-hover-bg',
                              same(row, current) &&
                                'ring-2 ring-action ring-inset'
                            )}
                            data-overview-cell
                            onClick={() => onOpen(row)}
                            type="button"
                          >
                            {row.waiting && !row.aiMarked
                              ? m.assignment_not_graded_badge()
                              : markText(
                                  row.waiting ? row.aiAwarded : row.awarded,
                                  row.marks
                                )}
                          </button>
                        ) : (
                          <span className="block text-center text-fg-muted">
                            –
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** One member's answer to one question: the answer, its marking points with an
 * AI column (empty until the grading switch) and the owner's mark. */
function MarkPane({
  assignment,
  avatar,
  canGoBack,
  name,
  onApproved,
  onPrevious,
  row,
}: {
  assignment: Assignment;
  avatar?: string;
  canGoBack: boolean;
  name: string;
  onApproved: () => void;
  onPrevious: () => void;
  row: AssignmentAnswerRow;
}) {
  const { data: attempt, isPending } = useAssignmentAttempt(row.attemptId, {
    errorBoundary: false,
  });
  const question = attempt?.questions.find((q) => q.id === row.questionId) as
    | AssignmentGradedQuestion
    | undefined;
  if (isPending || !attempt || !question)
    return <SkeletonList count={5} rowHeight={40} />;
  return (
    <MarkForm
      answers={attempt.answers}
      assignment={assignment}
      attemptId={attempt.id}
      attemptNumber={row.attemptNumber}
      avatar={avatar}
      canGoBack={canGoBack}
      // Starts over from the AI's marks when its read brings them.
      key={question.parts.some((p) => p.aiAwards) ? 'ai' : 'none'}
      name={name}
      onApproved={onApproved}
      onPrevious={onPrevious}
      paperFiles={attempt.paper ? attempt.paperFiles : undefined}
      question={question}
      waiting={row.waiting}
    />
  );
}

function MarkForm({
  answers,
  assignment,
  attemptId,
  attemptNumber,
  avatar,
  canGoBack,
  name,
  onApproved,
  onPrevious,
  paperFiles,
  question,
  waiting,
}: {
  answers: Record<string, unknown>;
  assignment: Assignment;
  /** A paper's files: its parts show the pages they were read on (T1). */
  paperFiles?: PaperFile[];
  attemptId: string;
  attemptNumber: number;
  avatar?: string;
  canGoBack: boolean;
  name: string;
  onApproved: () => void;
  onPrevious: () => void;
  question: AssignmentGradedQuestion;
  waiting: boolean;
}) {
  const parts = question.parts.filter((p) => modelMarked(p.answer.type));
  const [items, setItems] = useState<Record<string, (number | null)[]>>(() =>
    Object.fromEntries(
      parts.map((p) => [
        p.id,
        (p.markscheme ?? []).map((_, i) =>
          p.pending ? (p.aiAwards?.[i] ?? null) : (p.itemAwards?.[i] ?? 0)
        ),
      ])
    )
  );
  const [comment, setComment] = useState(question.comment ?? '');
  const { mutate, isPending } = useMarkAssignmentAnswer(
    assignment.workspaceId,
    assignment.id
  );
  const flat = Object.values(items).flat();
  const complete = flat.every((v) => v !== null);
  const total = flat.reduce<number>((sum, v) => sum + (v ?? 0), 0);
  const marks = parts.reduce((sum, p) => sum + p.marks, 0);
  const first = name.split(' ')[0] ?? name;
  // Off this answer and its row at once; the owner's typing stays (Epo 2026-11-05).
  const clearWarning = () =>
    mutate(
      {
        attemptId,
        mark: {
          clearWarning: true,
          comment: '',
          parts: [],
          questionId: question.id,
        },
      },
      {
        onError: (error) =>
          userToast({
            title: errorCopy(error, m.assignment_mark_failed()),
            variant: 'error',
          }),
      }
    );
  const approve = () =>
    mutate(
      {
        attemptId,
        mark: {
          comment: comment.trim(),
          parts: parts.map((p) => ({
            items: (items[p.id] ?? []).map((v) => v ?? 0),
            partId: p.id,
          })),
          questionId: question.id,
        },
      },
      {
        onError: (error) =>
          userToast({
            title: errorCopy(error, m.assignment_mark_failed()),
            variant: 'error',
          }),
        onSuccess: onApproved,
      }
    );
  return (
    <div className="flex flex-col">
      <h2 className="font-semibold leading-snug">
        <TextView marks text={questionLine(question as Question)} />{' '}
        <span className="font-semibold text-fg-muted">
          {`(${marks === 1 ? m.question_ui_one_mark() : m.question_ui_marks({ count: marks })})`}
        </span>
      </h2>
      <div className="mt-4 flex items-center gap-2.5">
        <Avatar
          aria-hidden
          className="size-7 shrink-0 text-[11px]"
          name={name}
          src={avatar || undefined}
        />
        <span className="font-semibold">{name}</span>
        {assignment.attempts > 1 && (
          <span className="t-meta text-fg-muted">
            {m.assignment_attempt_number({ number: attemptNumber })}
          </span>
        )}
      </div>
      {parts.map((part) => {
        const text = answers[part.id];
        return (
          <div className="mt-3" key={part.id}>
            {paperFiles ? (
              <PaperAnswer
                attemptId={attemptId}
                files={paperFiles}
                name={first}
                pages={part.pages ?? []}
              />
            ) : part.answer.type === 'drawing' && text ? (
              // Drawn from its board, Open drawing for the whole board (R3).
              <ReviewedDrawing
                blocks={part.blocks}
                marks={m.question_ui_marks({ count: part.marks })}
                title={m.drawing_answer_question()}
                value={text as Answer}
              />
            ) : (
              <div className="border-line-strong border-l-3 py-0.5 pl-4">
                {typeof text === 'string' && text ? (
                  <TextView marks text={text} />
                ) : (
                  <span className="text-fg-muted">
                    {m.assignment_not_answered()}
                  </span>
                )}
              </div>
            )}
            {part.aiComment && (
              <AiWarning
                className="mt-3"
                flag={part.aiFlag}
                message={part.aiComment}
              />
            )}
            <div className="mt-5 grid grid-cols-[minmax(0,1fr)_100px] items-center sm:grid-cols-[minmax(0,1fr)_92px_100px]">
              <p className="pb-2 font-semibold">
                {m.assignment_marking_points_title()}
              </p>
              <p className="t-label pb-2 text-fg-muted uppercase max-sm:hidden">
                {m.assignment_col_ai()}
              </p>
              <p className="t-label pb-2 text-fg-muted uppercase">
                {m.assignment_col_grade()}
              </p>
              {(part.markscheme ?? []).map((item, i) => (
                <div className="contents" key={i}>
                  <div className="min-h-11 border-divider border-t py-2.5 pr-3">
                    <TextView text={item.text} />{' '}
                    <span className="text-fg-muted">{`(${item.marks})`}</span>
                  </div>
                  <div className="flex min-h-11 items-center border-divider border-t max-sm:hidden">
                    <span className="t-meta text-fg-muted">
                      {part.aiAwards
                        ? markText(part.aiAwards[i] ?? 0, item.marks)
                        : '–'}
                    </span>
                  </div>
                  <div className="flex min-h-11 items-center border-divider border-t">
                    <Select
                      onValueChange={(value) =>
                        setItems((all) => ({
                          ...all,
                          [part.id]: (all[part.id] ?? []).map((v, j) =>
                            j === i ? Number(value) : v
                          ),
                        }))
                      }
                      value={
                        items[part.id]?.[i] === null ||
                        items[part.id]?.[i] === undefined
                          ? ''
                          : String(items[part.id]?.[i])
                      }
                    >
                      <SelectTrigger
                        aria-label={item.text}
                        className="h-7 w-25 px-2.5"
                      >
                        <SelectValue placeholder={`– / ${item.marks}`} />
                      </SelectTrigger>
                      <SelectContent>
                        {markSteps(item.marks).map((step) => (
                          <SelectItem key={step} value={String(step)}>
                            {markText(step, item.marks)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      <p className="mt-4 border-divider border-t pt-3 text-fg-secondary">
        {parts.every((p) => p.aiAwards)
          ? m.assignment_ai_mark({
              mark: markText(
                parts
                  .flatMap((p) => p.aiAwards ?? [])
                  .reduce((a, b) => a + b, 0),
                marks
              ),
            })
          : parts.some((p) => p.aiError === 'credits')
            ? m.assignment_not_graded_credits()
            : parts.some((p) => p.aiError === 'file')
              ? m.assignment_not_graded_file()
              : parts.some((p) => p.aiError === 'error')
                ? m.assignment_not_graded_error()
                : m.assignment_ai_not_marked()}
        {' · '}
        <b className="font-bold text-fg">
          {m.assignment_mark_of({
            marks: formatPoints(marks),
            total: formatPoints(total),
          })}
        </b>
      </p>
      <Input
        aria-label={m.assignment_comment_for({ name: first })}
        className="mt-0"
        onChange={(event) => setComment(event.target.value)}
        placeholder={m.assignment_comment_for({ name: first })}
        value={comment}
        wrapperClassName="mt-4"
      />
      {/* A phone keeps Previous and Approve at the bottom of the screen (P1),
          above the chat button's room (PracticeFrame's pb-24), which its
          shadow fills so nothing scrolls under it. */}
      <div className="max-md:page-bleed max-md:page-px mt-4 flex justify-end gap-2 max-md:sticky max-md:bottom-0 max-md:border-divider max-md:border-t max-md:bg-surface max-md:py-3 max-md:shadow-[0_3rem_0_3rem_var(--color-surface)] max-md:[&>*:last-child]:flex-2 max-md:[&>*]:flex-1">
        {parts.some((p) => p.aiComment) && (
          // Pulled left by its padding, so its label lines up with the column.
          <Button
            className="mr-auto -ml-3.5 border-none sm:-ml-5"
            disabled={isPending}
            onClick={clearWarning}
            variant="danger-light"
          >
            {m.assignment_clear_warning()}
          </Button>
        )}
        <Button
          disabled={!canGoBack}
          iconLeft="arrowLeft"
          onClick={onPrevious}
          variant="outline"
        >
          {m.action_previous()}
        </Button>
        <Button disabled={!complete || isPending} onClick={approve}>
          {waiting ? m.assignment_approve() : m.action_save()}
        </Button>
      </div>
    </div>
  );
}

/** A paper's answer (T1): the pages it was read on, the whole paper a click
 * away; once the member deleted the paper, that it is gone (F2). */
function PaperAnswer({
  attemptId,
  files,
  name,
  pages,
}: {
  attemptId: string;
  files: PaperFile[];
  name: string;
  pages: number[];
}) {
  const [whole, setWhole] = useState(false);
  if (files.length === 0)
    return (
      <p className="flex items-center gap-3 rounded-lg border border-line border-dashed p-4 text-fg-secondary">
        <Icon className="shrink-0 text-fg-muted" name="fileText" size={22} />
        {m.assignment_paper_deleted({ name })}
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="t-meta text-fg-secondary">
          {pages.length === 0
            ? m.assignment_paper_no_pages()
            : pages.length === 1
              ? m.assignment_paper_page({ page: pages[0]! })
              : m.assignment_paper_pages({ pages: pages.join(', ') })}
        </span>
        <Button
          className="ml-auto"
          onClick={() => setWhole(!whole)}
          size="sm"
          variant="outline"
        >
          {whole
            ? m.assignment_paper_found_pages()
            : m.assignment_paper_whole()}
        </Button>
      </div>
      <PaperPages
        className="grid-cols-1 sm:grid-cols-2"
        files={files}
        of={{ attemptId }}
        only={whole ? undefined : pages}
        width={480}
      />
    </div>
  );
}
