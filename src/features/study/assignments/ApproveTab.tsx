import { useEffect, useMemo, useState } from 'react';
import { useAssignmentAttempt, useMarkAssignmentAnswer } from '@/api/hooks';
import type {
  Assignment,
  AssignmentAnswerRow,
  AssignmentGradedQuestion,
  AssignmentReport,
} from '@/api/types';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/feedback';
import { Input } from '@/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { userToast } from '@/components/ui/userToast';
import { TextView } from '@/features/questions/QuestionView';
import { type Question, questionMarks } from '@/features/questions/types';
import { formatPoints } from '@/features/quizzes/grade';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';
import { questionLine } from '../practice/practiceText';
import type { AssignmentsSearch } from './AssignmentsPage';
import { markSteps, markText } from './assignmentText';

type Selected = { attemptId: string; questionId: string };
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

/** Approve AI marks (boards A3, A3b; links §9): a question's answers member by
 * member, or with `member` one member's answers. Rows waiting read Not marked:
 * until the grading switch no model marks an answer, so the owner sets each
 * marking point and Approve saves it. Approve all waits for AI marks. */
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
  const openQuestions = report.questions.filter((q) =>
    q.question.parts.some((p) => p.answer.type === 'open')
  );
  const firstWaiting = report.answers.find((row) => row.waiting);
  // A3b: by member, entered from the Members tab's "2 to approve".
  const [member, setMember] = useState<string | undefined>(
    search.question ? undefined : search.member
  );
  const [question, setQuestion] = useState<string | undefined>(
    search.question ?? firstWaiting?.questionId ?? openQuestions[0]?.question.id
  );
  const rows = waitingFirst(
    member
      ? report.answers.filter((row) => row.userId === member)
      : report.answers.filter((row) => row.questionId === question)
  );
  const [selected, setSelected] = useState<Selected | null>(() => {
    const wanted = report.answers.find(
      (row) =>
        (!search.question || row.questionId === search.question) &&
        (!search.member || row.userId === search.member) &&
        row.waiting
    );
    const row = wanted ?? rows[0];
    return row ? selection(row) : null;
  });
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

  const toApprove = rows.filter((row) => row.waiting).length;
  const questionNumber = (id: string) =>
    report.questions.findIndex((q) => q.question.id === id) + 1;
  const questionOf = (id: string) =>
    report.questions.find((q) => q.question.id === id)?.question;
  const step = (delta: number) => {
    const i = rows.findIndex((row) => same(row, selected));
    const next = rows[i + delta];
    if (next) setSelected(selection(next));
  };
  const moveOn = () => {
    const waiting = rows.filter((row) => row.waiting && !same(row, selected));
    if (waiting[0]) setSelected(selection(waiting[0]));
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
  const trigger = member
    ? `${names.get(member)?.name ?? ''} · ${m.assignment_to_approve({ count: toApprove })}`
    : m.assignment_question_marks({
        marks: questionMarks(
          questionOf(question ?? '') ?? ({ parts: [] } as unknown as Question)
        ),
        number: questionNumber(question ?? ''),
      });
  return (
    <div className="flex min-h-0 flex-col md:flex-row">
      <div className="shrink-0 border-divider pt-3 max-md:border-b max-md:pb-3 md:w-65 md:border-r md:pr-3 md:pb-6">
        <Select
          onValueChange={(value) => {
            if (member) setMember(value);
            else setQuestion(value);
          }}
          value={member ?? question}
        >
          <SelectTrigger
            aria-label={m.assignment_tab_approve()}
            className="h-7.5 px-2.5"
          >
            <SelectValue>{trigger}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {member
              ? report.members
                  .filter((row) => row.attemptId)
                  .map((row) => (
                    <SelectItem key={row.userId} value={row.userId}>
                      {row.name}
                    </SelectItem>
                  ))
              : openQuestions.map((q) => (
                  <SelectItem key={q.question.id} value={q.question.id}>
                    {m.assignment_question_marks({
                      marks: questionMarks(q.question),
                      number: questionNumber(q.question.id),
                    })}
                  </SelectItem>
                ))}
          </SelectContent>
        </Select>
        <div className="mt-2 flex items-center justify-between px-2.5">
          <span className="t-meta text-fg-secondary">
            {m.assignment_to_approve({ count: toApprove })}
          </span>
          {/* Waits for the grading switch: there are no AI marks to approve. */}
          <span title={m.assignment_approve_all_waits()}>
            <Button disabled size="sm" variant="outline">
              {m.assignment_approve_all()}
            </Button>
          </span>
        </div>
        <ul className="mt-2 flex flex-col gap-0.5 max-md:max-h-56 max-md:overflow-auto">
          {rows.map((row) => {
            const person = names.get(row.userId);
            const on = same(row, selected);
            return (
              <li key={`${row.questionId}/${row.attemptId}`}>
                <button
                  aria-current={on || undefined}
                  className={cn(
                    'flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-left font-semibold outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action',
                    on && 'bg-page-hover hover:bg-page-hover'
                  )}
                  onClick={() => setSelected(selection(row))}
                  type="button"
                >
                  {member ? (
                    <span className="min-w-0 flex-1 truncate">
                      {`Q${questionNumber(row.questionId)} · `}
                      {repeated(row) &&
                        `${m.assignment_attempt_number({ number: row.attemptNumber })} · `}
                      <TextView
                        className="whitespace-nowrap"
                        text={questionLine(questionOf(row.questionId))}
                      />
                    </span>
                  ) : (
                    <>
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
                    </>
                  )}
                  {row.waiting ? (
                    <span className="inline-flex h-5.5 shrink-0 items-center rounded-md bg-tint-warning px-1.75 font-semibold text-tint-warning-fg text-xs">
                      {m.assignment_not_marked()}
                    </span>
                  ) : (
                    <span className="shrink-0 font-semibold text-fg-secondary">
                      {markText(row.awarded, row.marks)}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="min-w-0 flex-1 py-4 md:pl-8">
        {current ? (
          <MarkPane
            assignment={assignment}
            avatar={names.get(current.userId)?.avatarUrl}
            canGoBack={rows.findIndex((row) => same(row, selected)) > 0}
            key={`${current.attemptId}/${current.questionId}`}
            name={names.get(current.userId)?.name ?? ''}
            onApproved={moveOn}
            onPrevious={() => step(-1)}
            row={current}
          />
        ) : (
          <p className="t-meta text-fg-muted">{m.assignment_no_answers()}</p>
        )}
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
      name={name}
      onApproved={onApproved}
      onPrevious={onPrevious}
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
  question,
  waiting,
}: {
  answers: Record<string, unknown>;
  assignment: Assignment;
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
  const parts = question.parts.filter((p) => p.answer.type === 'open');
  const [items, setItems] = useState<Record<string, (number | null)[]>>(() =>
    Object.fromEntries(
      parts.map((p) => [
        p.id,
        (p.markscheme ?? []).map((_, i) =>
          p.pending ? null : (p.itemAwards?.[i] ?? 0)
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
      <h2 className="font-bold text-[1.125rem] leading-snug">
        <TextView text={questionLine(question as Question)} />{' '}
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
            <p className="whitespace-pre-wrap border-line-strong border-l-3 py-0.5 pl-4">
              {typeof text === 'string' && text ? (
                text
              ) : (
                <span className="text-fg-muted">
                  {m.assignment_not_answered()}
                </span>
              )}
            </p>
            <div className="mt-5 grid grid-cols-[minmax(0,1fr)_100px] items-center sm:grid-cols-[minmax(0,1fr)_92px_100px]">
              <p className="pb-2 font-semibold">
                {m.assignment_marking_points_title()}
              </p>
              <p className="t-label pb-2 text-fg-muted uppercase max-sm:hidden">
                {m.assignment_col_ai()}
              </p>
              <p className="t-label pb-2 text-fg-muted uppercase">
                {m.assignment_col_mark()}
              </p>
              {(part.markscheme ?? []).map((item, i) => (
                <div className="contents" key={i}>
                  <div className="min-h-11 border-divider border-t py-2.5 pr-3">
                    <TextView text={item.text} />{' '}
                    <span className="text-fg-muted">{`(${item.marks})`}</span>
                  </div>
                  <div className="flex min-h-11 items-center border-divider border-t max-sm:hidden">
                    <span className="t-meta text-fg-muted">–</span>
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
        {m.assignment_ai_not_marked()}
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
      <div className="mt-4 flex justify-end gap-2">
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
