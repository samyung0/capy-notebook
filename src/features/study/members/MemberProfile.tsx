import { useNavigate } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { isApiError } from '@/api/client';
import { useMemberProfile } from '@/api/hooks';
import type {
  MemberActivity,
  MemberAssignment,
  MissedQuestion,
  SummaryTopic,
} from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { Avatar } from '@/components/ui/Avatar';
import { PageButton } from '@/components/ui/Button';
import { FileIcon } from '@/components/ui/FileIcon';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { formatPoints } from '@/features/quizzes/grade';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { unexpectedErrorId } from '@/lib/errors';
import { materialIconName } from '@/lib/fileIcons';
import {
  dayLabel,
  dayMonth,
  percentText,
  weekdayLabel,
} from '../assignments/assignmentText';
import { GradedQuizDialog } from '../assignments/LazyNewAssignmentDialog';
import { PracticeFrame } from '../practice/studyPage';
import { LabelChip, TopicSquares } from '../topicLabels';
import { topicName } from './membersRows';
import { StorageFullChip } from './StorageFullChip';

const DAY = 24 * 60 * 60 * 1000;

const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0);

/** "Mon" within the last week, else "28 Oct". */
function activityDay(iso: string, now = Date.now()) {
  const days = Math.round(
    (startOfDay(now) - startOfDay(Date.parse(iso))) / DAY
  );
  return days < 7 ? weekdayLabel(iso) : dayMonth(iso);
}

/** "active today", "active yesterday", "active 28 Oct". */
function activeText(iso: string, now = Date.now()) {
  const days = Math.round(
    (startOfDay(now) - startOfDay(Date.parse(iso))) / DAY
  );
  if (days <= 0) return m.member_active_today();
  if (days === 1) return m.member_active_yesterday();
  return m.member_active_on({ date: dayMonth(iso) });
}

/** The weakest topic needing practice: the lowest share right. */
const weakest = (topics: SummaryTopic[]) =>
  topics
    .filter((t) => t.label === 'needs_practice' && t.asked > 0)
    .sort((a, b) => a.right / a.asked - b.right / b.asked)[0];

/** A member's profile (board G2): the grade so far, every assignment, topics
 * with their labels and evidence, the questions still missed and recent work.
 * Practice shows as counts only. An empty section says so under its heading;
 * a member with nothing at all gets one line instead. */
export function MemberProfilePage({
  memberId,
  show,
  workspaceId,
}: {
  memberId: string;
  show?: 'topics';
  workspaceId: string;
}) {
  const navigate = useNavigate();
  const { data, error, isError, isPending, refetch } = useMemberProfile(
    workspaceId,
    memberId,
    { errorBoundary: false }
  );
  const [assigning, setAssigning] = useState(false);
  const back = (
    <button
      className="inline-flex items-center gap-1.5 font-semibold underline decoration-1 underline-offset-3 outline-none focus-visible:ring-2 focus-visible:ring-action"
      onClick={() =>
        void navigate({ search: { show, study: 'summary' as const }, to: '.' })
      }
      type="button"
    >
      <Icon name="navigationBack" size={16} />
      {m.workspace_tab_study()}
    </button>
  );
  if (isPending)
    return (
      <PracticeFrame className="lg:pt-6">
        {back}
        <SkeletonList className="mt-6" count={6} rowHeight={36} />
      </PracticeFrame>
    );
  // Not a viewer member here (removed, or never one): nothing to retry.
  if (isError && isApiError(error) && error.status === 404)
    return (
      <PracticeFrame className="lg:pt-6">
        {back}
        <ErrorState
          className="h-auto py-20"
          kind="notFound"
          title={m.member_profile_not_found()}
          variant="panel"
        />
      </PracticeFrame>
    );
  if (isError)
    return (
      <PracticeFrame className="lg:pt-6">
        {back}
        <ErrorState
          className="h-auto py-20"
          errorId={unexpectedErrorId(error)}
          onRetry={() => void refetch()}
          title={m.member_profile_load_failed()}
          variant="panel"
        />
      </PracticeFrame>
    );
  const focus = weakest(data.topics);
  // Nothing given, answered or done yet: one line stands in for the sections.
  const notStarted =
    data.assignments.length === 0 &&
    data.missed.length === 0 &&
    data.activity.length === 0 &&
    data.topics.every((t) => t.asked === 0);
  const openAssignment = (a: MemberAssignment) =>
    navigate({
      search: a.attemptId
        ? {
            assignment: a.id,
            attempt: a.attemptId,
            // Its back link returns to this profile (Epo 2026-11-16).
            member: memberId,
            show,
            study: 'assignments' as const,
          }
        : { assignment: a.id, study: 'assignments' as const, tab: 'members' },
      to: '.',
    });
  return (
    <PracticeFrame className="lg:pt-6">
      <div>{back}</div>
      {/* Phones: the button goes under the name, which keeps the width. */}
      <div className="mt-4 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:gap-3.5">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <Avatar
            aria-hidden
            className="size-12 shrink-0 text-base"
            name={data.name}
            src={data.avatarUrl || undefined}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="t-page-title truncate">{data.name}</h1>
              {data.storageFull && <StorageFullChip />}
            </div>
            <span className="t-meta text-fg-muted">
              {[
                m.member_joined({ date: dayMonth(data.joinedAt) }),
                data.lastActiveAt ? activeText(data.lastActiveAt) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
        </div>
        {/* Every member, needing practice or not; the weakest topic needing it
            comes preset (Epo 2026-11-16). */}
        <PageButton
          className="shrink-0 self-start sm:self-auto"
          onClick={() => setAssigning(true)}
          variant="outline"
        >
          {m.member_assign_quiz()}
        </PageButton>
      </div>

      {notStarted ? (
        <div className="mt-7.5 flex max-w-140 flex-col gap-1 border-divider border-t pt-6">
          <p className="font-semibold">
            {m.member_not_started({ name: data.name })}
          </p>
          <p className="text-fg-muted">{m.member_not_started_body()}</p>
        </div>
      ) : (
        // The left side takes the room the right's 380px leaves, up to
        // 1000px, so its names get the width (Epo 2026-11-16); the gap
        // between them grows with the screen.
        <div className="mt-7.5 flex flex-col gap-8.5 lg:flex-row lg:gap-12 xl:gap-16 2xl:gap-24">
          <div className="flex min-w-0 flex-col gap-8.5 lg:max-w-250 lg:flex-1">
            <section>
              <h2 className="t-subtitle">{m.study_panel_assignments()}</h2>
              {data.assignments.length === 0 ? (
                <Empty>{m.common_nothing_yet()}</Empty>
              ) : (
                <ul className="mt-1">
                  {data.assignments.map((a) => (
                    <AssignmentRow
                      assignment={a}
                      key={a.id}
                      onOpen={() => void openAssignment(a)}
                    />
                  ))}
                </ul>
              )}
              {data.overall !== undefined && (
                <div className="mt-3 flex items-center gap-2.5">
                  <span className="font-semibold">{m.member_overall()}</span>
                  <span className="font-bold">{percentText(data.overall)}</span>
                  <span
                    aria-hidden
                    className="inline-block h-1 w-14 overflow-hidden rounded-full bg-divider"
                  >
                    <span
                      className="block h-full bg-solid-accent-1"
                      style={{ width: `${data.overall * 100}%` }}
                    />
                  </span>
                </div>
              )}
            </section>
            <section>
              <h2 className="t-subtitle">{m.summary_topics()}</h2>
              {data.topics.length === 0 ? (
                <Empty>{m.common_nothing_yet()}</Empty>
              ) : (
                <ul className="mt-1">
                  {data.topics.map((t) => (
                    <TopicRow key={t.topicId ?? t.group} topic={t} />
                  ))}
                </ul>
              )}
            </section>
          </div>

          <div className="flex min-w-0 flex-col gap-7.5 lg:w-95 lg:shrink-0">
            <section>
              <h2 className="t-subtitle">{m.member_frequently_wrong()}</h2>
              {data.missed.length === 0 ? (
                <Empty>{m.common_nothing_yet()}</Empty>
              ) : (
                <ul className="mt-0.5">
                  {data.missed.map((q) => (
                    <MissedRow key={`${q.materialId}/${q.questionId}`} q={q} />
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h2 className="t-subtitle">{m.member_recent_activity()}</h2>
              {data.activity.length === 0 ? (
                <Empty>{m.common_nothing_yet()}</Empty>
              ) : (
                <ul className="mt-0.5">
                  {data.activity.map((a, i) => (
                    <ActivityRow activity={a} key={`${a.at}-${i}`} />
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}
      {assigning && (
        <GradedQuizDialog
          onClose={() => setAssigning(false)}
          onDone={() => setAssigning(false)}
          presetAssignee={memberId}
          presetTopicId={focus?.topicId}
          workspaceId={workspaceId}
        />
      )}
    </PracticeFrame>
  );
}

/** A section with nothing in it keeps its heading and says so. */
const Empty = ({ children }: { children: ReactNode }) => (
  <p className="mt-2 text-fg-muted">{children}</p>
);

const ROW =
  'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-divider border-b py-2 md:min-h-9 md:py-1';
/** Board G2's columns, one grid for both lists so they line up (Epo
 * 2026-11-16): an assignment's title spans the first two, its status and date
 * sit over a topic's count and squares (up to ten, topicSquares). */
const COLS = 'md:grid-cols-[minmax(0,1fr)_140px_120px_130px]';

const CHIP =
  't-meta inline-flex h-5.5 items-center whitespace-nowrap rounded-md px-1.75 font-semibold';

function AssignmentRow({
  assignment: a,
  onOpen,
}: {
  assignment: MemberAssignment;
  onOpen: () => void;
}) {
  let status: ReactNode = (
    <span className="font-semibold text-fg-muted">–</span>
  );
  let meta = a.dueAt ? m.assignment_due({ date: dayLabel(a.dueAt) }) : '';
  // A graded quiz's counted mark, or a graded Assignment's grade, which staff
  // may give without a tick (Epo 2026-11-14).
  if (a.mark !== undefined && (a.doneAt || a.kind === 'unmarked')) {
    status = (
      <span>
        <span className="font-bold">{formatPoints(a.mark)}</span>
        <span className="font-semibold text-fg-muted">
          {' / '}
          {formatPoints(a.total ?? 0)}
        </span>
      </span>
    );
    if (a.doneAt)
      meta =
        a.kind === 'marked'
          ? m.assignment_submitted_on({ date: dayMonth(a.doneAt) })
          : m.assignment_done_on({ date: dayMonth(a.doneAt) });
    if (a.waitingMarks > 0)
      meta += ` · ${m.member_marks_waiting({ marks: a.waitingMarks })}`;
  } else if (a.doneAt) {
    status = (
      <span className={cn(CHIP, 'bg-tint-success text-tint-success-fg')}>
        {m.assignment_done()}
      </span>
    );
    meta = m.assignment_done_on({ date: dayMonth(a.doneAt) });
  } else if (a.running) {
    status = (
      <span className={cn(CHIP, 'bg-page-hover text-fg-secondary')}>
        {m.assignment_in_progress()}
      </span>
    );
  } else if (a.missing) {
    status = (
      <span className={cn(CHIP, 'bg-tint-error text-tint-error-fg')}>
        {m.assignment_missing()}
      </span>
    );
  }
  return (
    <li>
      <button
        className={cn(
          ROW,
          COLS,
          'w-full text-left outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset'
        )}
        onClick={onOpen}
        type="button"
      >
        <span className="line-clamp-2 font-semibold md:col-span-2">
          {a.title}
        </span>
        <span className="justify-self-end md:justify-self-start">{status}</span>
        <span className="t-meta col-span-2 text-fg-muted md:col-span-1 md:font-semibold md:text-sm">
          {meta}
        </span>
      </button>
    </li>
  );
}

function TopicRow({ topic }: { topic: SummaryTopic }) {
  return (
    <li className={cn(ROW, COLS)}>
      <span className="line-clamp-2 font-semibold">{topicName(topic)}</span>
      <span className="justify-self-end md:justify-self-start">
        <LabelChip label={topic.label} />
      </span>
      <span className="t-meta text-fg-muted">
        {topic.asked > 0
          ? m.summary_right({ asked: topic.asked, right: topic.right })
          : ''}
      </span>
      <TopicSquares className="hidden md:flex" topic={topic} />
    </li>
  );
}

const missedText = (count: number) =>
  count <= 1
    ? m.member_missed_once()
    : count === 2
      ? m.member_missed_twice()
      : m.member_missed_times({ count });

function MissedRow({ q }: { q: MissedQuestion }) {
  return (
    <li className="flex flex-col gap-1.5 border-divider border-b py-2.5">
      <span className="line-clamp-2 font-semibold">{q.text}</span>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            CHIP,
            'min-w-0 truncate bg-page-hover text-fg-secondary'
          )}
        >
          {topicName({ group: q.group, name: q.topicName })}
        </span>
        <span className="t-meta shrink-0 text-fg-muted">
          {missedText(q.misses)}
        </span>
      </div>
    </li>
  );
}

const questionsText = (count: number) =>
  count === 1 ? m.practice_questions_one() : m.practice_questions({ count });

function ActivityRow({ activity: a }: { activity: MemberActivity }) {
  const topic = topicName({ group: a.group ?? 'others', name: a.topicName });
  return (
    <li className="flex min-h-10.5 items-center gap-2.5 border-divider border-b">
      {a.kind === 'practice' ? (
        <FileIcon
          className="size-4.5 shrink-0"
          name={materialIconName('quiz')}
        />
      ) : a.kind === 'review' ? (
        <Icon
          className="shrink-0 text-(--ctp-sapphire)"
          name="retry"
          size={18}
        />
      ) : (
        <Icon
          className="shrink-0 text-(--ctp-teal)"
          name="quillWrite"
          size={18}
        />
      )}
      <span className="min-w-0 truncate font-semibold">
        {a.kind === 'practice'
          ? a.title
          : a.kind === 'review'
            ? a.questions === 1
              ? m.member_tried_in_one({ topic })
              : m.member_tried_in({ count: a.questions, topic })
            : m.member_submitted_work({ title: a.title ?? '' })}
      </span>
      {a.kind === 'practice' && (
        <span className="shrink-0 font-semibold text-fg-muted">
          {questionsText(a.questions)}
        </span>
      )}
      <span className="t-meta ml-auto shrink-0 text-fg-muted">
        {activityDay(a.at)}
      </span>
    </li>
  );
}
