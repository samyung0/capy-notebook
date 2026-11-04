import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import {
  useAssignmentReport,
  useDeleteAssignment,
  usePublishAssignment,
  useSetAssignmentClosed,
} from '@/api/hooks';
import type {
  Assignment,
  AssignmentMemberRow,
  AssignmentPartReport,
  AssignmentQuestionReport,
  FileKind,
  MaterialRefType,
} from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { FileIcon } from '@/components/ui/FileIcon';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Menu } from '@/components/ui/Menu';
import { Tabs } from '@/components/ui/Tabs';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { userToast } from '@/components/ui/userToast';
import { answerLabels } from '@/features/questions/editorFields';
import { optionLetter, TextView } from '@/features/questions/QuestionView';
import { type Question, questionMarks } from '@/features/questions/types';
import { formatPoints } from '@/features/quizzes/grade';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy, unexpectedErrorId } from '@/lib/errors';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { questionLine } from '../practice/practiceText';
import { PracticeFrame, Td, Th } from '../practice/studyPage';
import { ApproveTab } from './ApproveTab';
import { BackToAssignments } from './AssignmentAttemptPage';
import type { AssignmentsSearch, ReportTab } from './AssignmentsPage';
import {
  closedItself,
  dayLabel,
  lateLabel,
  markText,
  percentText,
  takesLateWork,
} from './assignmentText';
import { NewAssignmentDialog } from './NewAssignmentDialog';
import { NoAnswersWarning } from './NoAnswersWarning';

/** Questions the report opens with, as the board draws them. */
const OPEN_FIRST = 3;
/** A marking point most members missed gets the flag. */
const OFTEN_MISSED = 0.5;

const CHIP =
  'inline-flex h-5.5 shrink-0 items-center rounded-md bg-page-hover px-1.75 font-semibold text-fg-secondary text-xs';

/** An assignment's report (boards G3, G3m, A3): the facts as chips, then its
 * Questions, Members and Approve AI marks tabs, each with its own link. An
 * unmarked one lists who has ticked it; a draft waits to be published. */
export function AssignmentReport({
  assignment,
  search,
}: {
  assignment: Assignment;
  search: AssignmentsSearch;
}) {
  const navigate = useNavigate();
  const { data, error, isError, isPending, refetch } = useAssignmentReport(
    assignment.id,
    { errorBoundary: false }
  );
  const [editing, setEditing] = useState(false);
  const tab: ReportTab = search.tab ?? 'questions';
  const go = (next: AssignmentsSearch) =>
    navigate({
      search: {
        assignment: assignment.id,
        study: 'assignments' as const,
        ...next,
      },
      to: '.',
    });
  const manage = assignment.manage;
  const marked = assignment.kind === 'marked';
  const chips = [
    assignment.draft ? m.assignment_draft() : null,
    assignment.timeLimitMin
      ? m.assignment_chip_timed({ minutes: assignment.timeLimitMin })
      : marked
        ? m.assignment_chip()
        : m.assignment_kind_unmarked(),
    assignment.dueAt
      ? m.assignment_due({ date: dayLabel(assignment.dueAt) })
      : null,
    assignment.noLate
      ? m.assignment_switch_no_late()
      : assignment.latePenaltyPct > 0
        ? m.assignment_late_penalty({ percent: assignment.latePenaltyPct })
        : null,
    assignment.closedAt
      ? m.assignment_closed_on({ date: dayLabel(assignment.closedAt) })
      : null,
    assignment.draft
      ? null
      : marked
        ? m.assignment_submitted_of({
            done: manage?.done ?? 0,
            total: manage?.assigned ?? 0,
          })
        : m.assignment_done_of({
            done: manage?.done ?? 0,
            total: manage?.assigned ?? 0,
          }),
    manage?.average === undefined
      ? null
      : m.assignment_chip_average({ percent: percentText(manage.average) }),
  ].filter(Boolean) as string[];

  return (
    <PracticeFrame>
      <BackToAssignments />
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h1 className="t-page-title min-w-0">{assignment.title}</h1>
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <span className={CHIP} key={chip}>
              {chip}
            </span>
          ))}
          <ReportMenu assignment={assignment} onEdit={() => setEditing(true)} />
        </div>
      </div>
      {assignment.draft ? (
        <DraftBody assignment={assignment} />
      ) : marked ? (
        <>
          <Tabs
            className="mt-3.5"
            onChange={(value) =>
              void go(value === 'questions' ? {} : { tab: value as ReportTab })
            }
            tabs={[
              { label: m.assignment_tab_questions(), value: 'questions' },
              { label: m.assignment_tab_members(), value: 'members' },
              { label: m.assignment_tab_approve(), value: 'approve' },
            ]}
            value={tab}
          />
          {isPending ? (
            <SkeletonList className="mt-5" count={6} rowHeight={44} />
          ) : isError ? (
            <ErrorState
              action={
                <Button onClick={() => void refetch()} variant="outline">
                  {m.action_retry()}
                </Button>
              }
              className="mt-10"
              errorId={unexpectedErrorId(error)}
              title={m.assignment_load_failed()}
              variant="panel"
            />
          ) : tab === 'members' ? (
            <MembersTab
              assignment={assignment}
              go={go}
              members={data.members}
            />
          ) : tab === 'approve' ? (
            <ApproveTab assignment={assignment} report={data} search={search} />
          ) : (
            <QuestionsTab
              go={go}
              questions={data.questions}
              submitted={manage?.done ?? 0}
            />
          )}
        </>
      ) : (
        <UnmarkedBody
          assignment={assignment}
          loading={isPending}
          members={data?.members ?? []}
        />
      )}
      {editing && (
        <NewAssignmentDialog
          existing={assignment}
          onClose={() => setEditing(false)}
          onDone={() => setEditing(false)}
          workspaceId={assignment.workspaceId}
        />
      )}
    </PracticeFrame>
  );
}

function ReportMenu({
  assignment,
  onEdit,
}: {
  assignment: Assignment;
  onEdit: () => void;
}) {
  const navigate = useNavigate();
  const { workspaceId, id } = assignment;
  const { mutate: setClosed } = useSetAssignmentClosed(workspaceId, id);
  const { mutate: remove } = useDeleteAssignment(workspaceId);
  const failed = (error: unknown) =>
    userToast({
      title: errorCopy(error, m.assignment_save_failed()),
      variant: 'error',
    });
  return (
    <Menu
      align="end"
      items={[
        { icon: 'pencil', label: m.action_edit(), onClick: onEdit },
        ...(assignment.draft || closedItself(assignment)
          ? []
          : [
              {
                // Closing a marked one shows its quiz as practice, with its keys.
                confirmLabel:
                  assignment.kind === 'marked' && !assignment.closedAt
                    ? m.assignment_close_confirm()
                    : undefined,
                icon: 'lock' as const,
                label: assignment.closedAt
                  ? m.assignment_reopen()
                  : m.assignment_close(),
                onClick: () =>
                  setClosed(!assignment.closedAt, { onError: failed }),
              },
            ]),
        {
          confirmLabel: m.assignment_delete_confirm(),
          danger: true,
          icon: 'trash',
          label: m.action_delete(),
          onClick: () =>
            remove(id, {
              onError: failed,
              onSuccess: () =>
                void navigate({
                  search: { study: 'assignments' as const },
                  to: '.',
                }),
            }),
        },
      ]}
    />
  );
}

function DraftBody({ assignment }: { assignment: Assignment }) {
  const { mutate, isPending } = usePublishAssignment(
    assignment.workspaceId,
    assignment.id
  );
  return (
    <div className="mt-6 flex flex-col items-start gap-3">
      <p className="text-fg-secondary">{m.assignment_draft_note()}</p>
      {assignment.manage?.quizId && (
        <NoAnswersWarning quizId={assignment.manage.quizId} />
      )}
      <Button
        disabled={isPending}
        onClick={() =>
          mutate(undefined, {
            onError: (error) =>
              userToast({
                title: errorCopy(error, m.assignment_save_failed()),
                variant: 'error',
              }),
          })
        }
      >
        {m.assignment_publish()}
      </Button>
    </div>
  );
}

/** An unmarked assignment's files, and who has ticked it. */
function UnmarkedBody({
  assignment,
  loading,
  members,
}: {
  assignment: Assignment;
  loading: boolean;
  members: AssignmentMemberRow[];
}) {
  return (
    <>
      {assignment.files.length > 0 && (
        <section className="mt-6.5 max-w-180">
          <h2 className="t-subtitle">{m.assignment_field_files()}</h2>
          <ul className="mt-2">
            {assignment.files.map((file) => (
              <li
                className="flex min-h-10 items-center gap-2 border-divider border-b"
                key={file.fileId ?? file.materialId}
              >
                <FileIcon
                  className="size-4 shrink-0"
                  name={
                    file.fileId
                      ? fileIconName({
                          kind: file.kind as FileKind,
                          name: file.name,
                        })
                      : materialIconName(file.kind as MaterialRefType)
                  }
                />
                <span className="min-w-0 flex-1 truncate font-semibold">
                  {file.name}
                </span>
                <UnderlineLink asChild className="text-fg">
                  <Link
                    search={
                      file.fileId
                        ? { file: file.fileId }
                        : { material: file.materialId }
                    }
                    to="."
                  >
                    {m.assignment_open()}
                  </Link>
                </UnderlineLink>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="mt-6.5">
        <h2 className="t-subtitle">{m.assignment_tab_members()}</h2>
        {loading ? (
          <SkeletonList className="mt-3" count={5} rowHeight={40} />
        ) : (
          <ul className="mt-2">
            {members.map((member) => (
              <li
                className="flex min-h-10 items-center gap-2.5 border-divider border-b"
                key={member.userId}
              >
                <MemberName member={member} />
                <span className="t-meta ml-auto shrink-0 text-fg-muted">
                  {member.submittedAt
                    ? m.assignment_done_on({
                        date: dayLabel(member.submittedAt),
                      })
                    : m.assignment_not_done()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function MemberName({ member }: { member: AssignmentMemberRow }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Avatar
        aria-hidden
        className="size-6.5 shrink-0 text-[10px]"
        name={member.name}
        src={member.avatarUrl || undefined}
      />
      <span className="truncate font-semibold">{member.name}</span>
    </span>
  );
}

/** Members (G3m): when each submitted, how long they took, their mark and how
 * many answers wait. A row opens that member's answers. */
function MembersTab({
  assignment,
  go,
  members,
}: {
  assignment: Assignment;
  go: (next: AssignmentsSearch) => unknown;
  members: AssignmentMemberRow[];
}) {
  const status = (member: AssignmentMemberRow) =>
    member.submittedAt ? (
      <span className="flex items-center gap-2">
        {dayLabel(member.submittedAt)}
        {member.late && (
          <span className="font-semibold text-tint-warning-fg">
            {lateLabel(member.latePenaltyPct)}
          </span>
        )}
      </span>
    ) : member.missing ? (
      <span className="font-semibold text-tint-error-fg">
        {m.assignment_missing()}
      </span>
    ) : (
      <span className="text-fg-muted">
        {member.running
          ? m.assignment_in_progress()
          : m.assignment_not_submitted()}
      </span>
    );
  const approve = (member: AssignmentMemberRow) =>
    member.waitingAnswers > 0 && (
      <button
        className="t-meta font-semibold text-tint-warning-fg underline decoration-[1.5px] underline-offset-3 outline-none focus-visible:ring-2 focus-visible:ring-action"
        onClick={(event) => {
          event.stopPropagation();
          void go({ member: member.userId, tab: 'approve' });
        }}
        type="button"
      >
        {m.assignment_to_approve({ count: member.waitingAnswers })}
      </button>
    );
  const open = (member: AssignmentMemberRow) => {
    if (member.attemptId) void go({ attempt: member.attemptId });
  };
  return (
    <>
      <table className="mt-2 hidden w-full table-fixed border-separate border-spacing-0 md:table">
        <thead>
          <tr>
            <Th>{m.assignment_col_member()}</Th>
            <Th className="w-50">{m.assignment_col_submitted()}</Th>
            <Th className="w-30">{m.assignment_col_time_taken()}</Th>
            <Th className="w-30">{m.assignment_col_mark()}</Th>
            <Th className="w-35" />
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr
              className={cn(
                member.attemptId &&
                  'cursor-pointer [&>td]:hover:bg-surface-hover-bg'
              )}
              key={member.userId}
              onClick={() => open(member)}
            >
              <Td>
                <MemberName member={member} />
              </Td>
              <Td muted={!member.missing}>{status(member)}</Td>
              <Td muted>
                {member.minutes ? minutesShort(member.minutes) : ''}
              </Td>
              <Td>
                {member.mark !== undefined && (
                  <span className="font-bold">
                    {formatPoints(member.mark)}{' '}
                    <span className="font-semibold text-fg-muted">
                      / {formatPoints(member.total ?? 0)}
                    </span>
                  </span>
                )}
              </Td>
              <Td>{approve(member)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="mt-1 md:hidden">
        {members.map((member) => (
          <li
            className={cn(
              'flex min-h-14 items-center gap-3 border-divider border-b py-2',
              member.attemptId && 'cursor-pointer'
            )}
            key={member.userId}
            onClick={() => open(member)}
          >
            <div className="min-w-0 flex-1">
              <MemberName member={member} />
              <div className="t-meta mt-0.5 flex flex-wrap items-center gap-x-2 pl-9 text-fg-muted">
                {status(member)}
                {member.minutes ? (
                  <span>{minutesShort(member.minutes)}</span>
                ) : null}
                {approve(member)}
              </div>
            </div>
            {member.mark !== undefined && (
              <span className="shrink-0 font-bold">
                {markText(member.mark, member.total ?? 0)}
              </span>
            )}
          </li>
        ))}
      </ul>
      {takesLateWork(assignment) && (
        <p className="t-meta mt-3 text-fg-muted">{m.assignment_late_note()}</p>
      )}
    </>
  );
}

const minutesShort = (count: number) => m.assignment_minutes_short({ count });

/** Questions (G3): percent correct and answer frequencies, marking points and
 * how often each was awarded. The first few start open. */
function QuestionsTab({
  go,
  questions,
  submitted,
}: {
  go: (next: AssignmentsSearch) => unknown;
  questions: AssignmentQuestionReport[];
  submitted: number;
}) {
  const [opened, setOpened] = useState(() =>
    questions.slice(0, OPEN_FIRST).map((q) => q.question.id)
  );
  return (
    <ol className="flex flex-col">
      {questions.map((row, i) => (
        <QuestionReportRow
          go={go}
          key={row.question.id}
          number={i + 1}
          onToggle={() =>
            setOpened((list) =>
              list.includes(row.question.id)
                ? list.filter((id) => id !== row.question.id)
                : [...list, row.question.id]
            )
          }
          open={opened.includes(row.question.id)}
          row={row}
          submitted={submitted}
        />
      ))}
    </ol>
  );
}

function QuestionReportRow({
  go,
  number,
  onToggle,
  open,
  row,
  submitted,
}: {
  go: (next: AssignmentsSearch) => unknown;
  number: number;
  onToggle: () => void;
  open: boolean;
  row: AssignmentQuestionReport;
  submitted: number;
}) {
  const { question } = row;
  const marks = questionMarks(question);
  const type = question.parts[0]?.answer.type;
  const meta = `Q${number} · ${type ? answerLabels[type]() : ''} · ${
    marks === 1
      ? m.question_ui_one_mark()
      : m.question_ui_marks({ count: marks })
  }`;
  const line = <TextView text={questionLine(question)} />;
  const score =
    row.percent === undefined ? (
      row.average === undefined ? (
        <span className="t-meta text-fg-muted">
          {m.assignment_too_few({ count: submitted })}
        </span>
      ) : (
        <>
          <span className="text-fg-muted">{m.assignment_average()}</span>{' '}
          <b className={cn('font-bold', open && 'text-xl')}>
            {formatPoints(Number(row.average.toFixed(1)))}
          </b>{' '}
          <span className="text-fg-muted">
            {m.assignment_of_marks({ marks })}
          </span>
        </>
      )
    ) : (
      <>
        <b className={cn('font-bold', open && 'text-xl')}>
          {percentText(row.percent)}
        </b>{' '}
        <span className="text-fg-muted">{m.assignment_correct()}</span>
      </>
    );
  if (!open)
    return (
      <li className="border-divider border-b">
        <button
          aria-expanded={false}
          className="grid min-h-15 w-full grid-cols-[minmax(0,1fr)_20px] items-center gap-x-3 gap-y-1 py-3 text-left outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset md:grid-cols-[200px_minmax(0,1fr)_auto_20px]"
          onClick={onToggle}
          type="button"
        >
          <span className="t-meta truncate text-fg-secondary">{meta}</span>
          <span className="truncate font-semibold max-md:col-start-1 max-md:row-start-2">
            {line}
          </span>
          <span className="whitespace-nowrap max-md:col-start-1 max-md:row-start-3">
            {score}
          </span>
          <Icon
            className="justify-self-end text-fg-muted max-md:col-start-2 max-md:row-start-1"
            name="chevronDown"
            size={16}
          />
        </button>
      </li>
    );
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_20px] gap-x-3 border-divider border-b py-5 md:grid-cols-[320px_minmax(0,1fr)_20px] md:gap-x-10">
      <div className="min-w-0">
        <p className="t-meta text-fg-secondary">{meta}</p>
        <p className="mt-2 text-[1.0625rem] leading-snug">{line}</p>
        <p className="mt-3">{score}</p>
      </div>
      <button
        aria-expanded
        aria-label={m.action_close()}
        className="col-start-2 row-start-1 grid size-5 place-items-center self-start justify-self-end text-fg-muted outline-none focus-visible:ring-2 focus-visible:ring-action md:col-start-3"
        onClick={onToggle}
        type="button"
      >
        <Icon className="rotate-180" name="chevronDown" size={16} />
      </button>
      <div className="col-span-2 mt-4 min-w-0 md:col-span-1 md:col-start-2 md:row-start-1 md:mt-0">
        {row.parts.map((part) => (
          <PartStats
            go={go}
            key={part.partId}
            part={part}
            question={question}
            showLabel={row.parts.length > 1}
          />
        ))}
      </div>
    </li>
  );
}

function PartStats({
  go,
  part,
  question,
  showLabel,
}: {
  go: (next: AssignmentsSearch) => unknown;
  part: AssignmentPartReport;
  question: Question;
  showLabel: boolean;
}) {
  const source = question.parts.find((p) => p.id === part.partId);
  if (!source) return null;
  const label =
    showLabel && source.blocks[0]?.type === 'text' ? source.blocks[0].text : '';
  const answer = source.answer;
  return (
    <div className="mb-3 last:mb-0">
      {label && <p className="t-meta mb-1 truncate text-fg-muted">{label}</p>}
      {answer.type === 'mcq' && part.options && (
        <OptionBars
          correct={answer.correct}
          counts={part.options}
          labels={answer.options}
          letters
        />
      )}
      {answer.type === 'boolean' && part.options && (
        <OptionBars
          correct={[answer.correct ? 0 : 1]}
          counts={part.options}
          labels={[m.question_ui_true(), m.question_ui_false()]}
        />
      )}
      {answer.type === 'short' && !!part.wrongAnswers?.length && (
        <div>
          <p className="t-meta text-fg-secondary">
            {m.assignment_common_wrong()}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {part.wrongAnswers.map((wrong) => (
              <span className={CHIP} key={wrong.text}>
                {`${wrong.text} · ${wrong.count}`}
              </span>
            ))}
          </div>
        </div>
      )}
      {answer.type === 'open' && part.items && (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 sm:grid-cols-[minmax(0,1fr)_210px]">
            <p className="t-meta border-divider border-b pb-1.5 text-fg-secondary">
              {m.assignment_marking_point()}
            </p>
            <p className="t-meta border-divider border-b pb-1.5 text-fg-secondary">
              {m.assignment_awarded()}
            </p>
            {part.items.map((item) => {
              const share = item.marked ? item.awarded / item.marked : 0;
              return (
                <div className="contents" key={item.text}>
                  <div className="border-divider border-b py-2.5 pr-2">
                    <TextView text={item.text} />
                  </div>
                  <div className="flex min-h-11 items-center gap-2 border-divider border-b py-2">
                    <span
                      aria-hidden
                      className="inline-block h-2 w-14 shrink-0 overflow-hidden rounded-full bg-divider sm:w-25"
                    >
                      <span
                        className="block h-full bg-solid-accent-1"
                        style={{ width: `${share * 100}%` }}
                      />
                    </span>
                    <span className="t-meta whitespace-nowrap font-semibold text-fg-secondary">
                      {m.practice_tried_of({
                        members: item.marked,
                        tried: item.awarded,
                      })}
                    </span>
                  </div>
                  {item.marked > 0 && share < OFTEN_MISSED && (
                    <span className="col-span-2 -mt-1 mb-1 inline-flex h-5.5 w-fit items-center justify-self-end rounded-md bg-tint-warning px-1.75 font-semibold text-tint-warning-fg text-xs">
                      {m.assignment_often_missed()}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <UnderlineLink
            className="mt-3 text-fg"
            onClick={() => void go({ question: question.id, tab: 'approve' })}
          >
            {m.assignment_check_marks()}
          </UnderlineLink>
        </>
      )}
    </div>
  );
}

function OptionBars({
  correct,
  counts,
  labels,
  letters,
}: {
  correct: number[];
  counts: number[];
  labels: string[];
  letters?: boolean;
}) {
  const max = Math.max(
    1,
    ...counts.map((n) => n),
    counts.reduce((a, b) => a + b, 0)
  );
  return (
    <ul className="flex flex-col gap-1.5">
      {labels.map((label, i) => {
        const right = correct.includes(i);
        return (
          <li
            className="grid min-h-7 grid-cols-[20px_minmax(0,1fr)_72px_16px] items-center gap-2 sm:grid-cols-[20px_minmax(0,230px)_minmax(80px,1fr)_20px]"
            key={label}
          >
            {letters ? (
              <span className="font-semibold text-fg-muted">
                {optionLetter(i)}
              </span>
            ) : (
              <span />
            )}
            <span className="flex min-w-0 items-center gap-2 font-medium">
              <TextView className="truncate" text={label} />
              {right && (
                <span className="t-meta inline-flex shrink-0 items-center gap-1 text-tint-success-fg">
                  <Icon name="check" size={14} />
                  <span className="max-sm:sr-only">
                    {m.assignment_correct_answer()}
                  </span>
                </span>
              )}
            </span>
            <span
              aria-hidden
              className="block h-2 overflow-hidden rounded-full bg-divider"
            >
              <span
                className={cn(
                  'block h-full',
                  right ? 'bg-solid-success' : 'bg-line-strong'
                )}
                style={{ width: `${(counts[i] / max) * 100}%` }}
              />
            </span>
            <span className="text-right font-semibold">{counts[i]}</span>
          </li>
        );
      })}
    </ul>
  );
}
