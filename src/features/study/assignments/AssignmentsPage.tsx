import { Navigate, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import {
  useAssignment,
  useAssignments,
  useDeleteAssignment,
  useSetAssignmentDone,
  useTopics,
  useWorkspace,
} from '@/api/hooks';
import type { Assignment, Topic } from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { Button } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/feedback';
import { Menu } from '@/components/ui/Menu';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { unexpectedErrorId } from '@/lib/errors';
import { PracticeFrame, Td, Th } from '../practice/studyPage';
import { studyView } from '../practice/studyView';
import { AssignmentAttemptPage } from './AssignmentAttemptPage';
import { AssignmentReport } from './AssignmentReport';
import { dayLabel, kindLabel, markText, percentText } from './assignmentText';
import { LateBadge } from './LateBadge';
import { MemberAssignment } from './MemberAssignment';
import { NewAssignmentDialog } from './NewAssignmentDialog';
import { useAssignmentStart } from './useAssignmentStart';

export type ReportTab = 'questions' | 'members' | 'approve';

/** The Assignments page's URL, under `study=assignments`. `assignment` opens
 * one: its report for a class's owner and teaching assistants (unless `own`, the
 * page of one given to them), its page for a member. `attempt` opens a try: a
 * running one, or results, a member's for staff. `tab`, `question` and `member`
 * are a report's view (todo-study-tracking.md §9, Links). */
export type AssignmentsSearch = {
  assignment?: string;
  attempt?: string;
  member?: string;
  newFromQuiz?: string;
  own?: true;
  question?: string;
  tab?: ReportTab;
};

/** Study → Assignments (boards W1, W2 for staff, W3 for members), the
 * workspace's centre page while `study=assignments` is in its URL. Class only
 * (studyView, board U3): anywhere else the link opens Practice. */
export function AssignmentsPage({
  search,
  workspaceId,
}: {
  search: AssignmentsSearch;
  workspaceId: string;
}) {
  const { data: ws } = useWorkspace(workspaceId);
  if (!ws) return null;
  if (!studyView(ws).pages.includes('assignments'))
    return <Navigate replace search={{ study: 'practice' }} to="." />;
  if (search.attempt)
    return (
      <AssignmentAttemptPage
        attemptId={search.attempt}
        key={search.attempt}
        workspaceId={workspaceId}
      />
    );
  if (search.assignment)
    return (
      <AssignmentDetail
        id={search.assignment}
        key={search.assignment}
        search={search}
      />
    );
  return studyView(ws).manages ? (
    <StaffList
      key={workspaceId}
      newFromQuiz={search.newFromQuiz}
      workspaceId={workspaceId}
    />
  ) : (
    <MemberList workspaceId={workspaceId} />
  );
}

function AssignmentDetail({
  id,
  search,
}: {
  id: string;
  search: AssignmentsSearch;
}) {
  const { data, error, isError, isPending, refetch } = useAssignment(id, {
    errorBoundary: false,
  });
  if (isPending)
    return (
      <PracticeFrame>
        <SkeletonList count={6} rowHeight={40} />
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
          title={m.assignment_load_failed()}
          variant="panel"
        />
      </PracticeFrame>
    );
  return data.manage && !search.own ? (
    <AssignmentReport assignment={data} search={search} />
  ) : (
    <MemberAssignment assignment={data} />
  );
}

/** Topic: All and the topics the rows hold, in topic order, Other files last. */
function TopicFilter({
  filter,
  onFilter,
  rows,
  topics,
}: {
  filter: string | null | undefined;
  onFilter: (topic: string | null | undefined) => void;
  rows: Assignment[];
  topics: Topic[];
}) {
  const held = new Set(rows.flatMap((r) => r.topicIds));
  const options: { id: string | null; name: string }[] = [
    ...topics
      .filter((t) => held.has(t.id))
      .map((t) => ({ id: t.id, name: t.name })),
    ...(rows.some((r) => r.topicIds.length === 0)
      ? [{ id: null, name: m.topic_other_files() }]
      : []),
  ];
  const name =
    filter === undefined
      ? m.practice_topic_all()
      : (options.find((o) => o.id === filter)?.name ?? m.practice_topic_all());
  return (
    <Menu
      align="start"
      items={[
        {
          checked: filter === undefined,
          label: m.practice_topic_all(),
          onClick: () => onFilter(undefined),
        },
        ...options.map((o) => ({
          checked: filter === o.id,
          label: o.name,
          onClick: () => onFilter(o.id),
        })),
      ]}
      trigger={
        <Button
          className="px-2.5"
          iconRight="chevronDown"
          size="sm"
          variant="outline"
        >
          {m.practice_topic_filter({ topic: name })}
        </Button>
      }
    />
  );
}

const onTopic = (row: Assignment, filter: string | null) =>
  filter === null ? row.topicIds.length === 0 : row.topicIds.includes(filter);

/** The owner's and teaching assistants' table (W1, W2): open ones by due date,
 * closed ones behind Show closed. A row opens the report. */
function StaffList({
  newFromQuiz,
  workspaceId,
}: {
  newFromQuiz?: string;
  workspaceId: string;
}) {
  const navigate = useNavigate();
  const { data: ws } = useWorkspace(workspaceId);
  const { data: topics } = useTopics(workspaceId);
  const { data, error, isError, isPending, refetch } = useAssignments(
    workspaceId,
    { errorBoundary: false }
  );
  const { mutate: remove } = useDeleteAssignment(workspaceId);
  const [creating, setCreating] = useState(!!newFromQuiz);
  const [showClosed, setShowClosed] = useState(false);
  const [topic, setTopic] = useState<string | null | undefined>(undefined);
  const open = (id: string) =>
    navigate({
      search: { assignment: id, study: 'assignments' as const },
      to: '.',
    });
  const closeNew = () => {
    setCreating(false);
    if (newFromQuiz)
      void navigate({
        replace: true,
        search: { study: 'assignments' as const },
        to: '.',
      });
  };
  const items = data?.items ?? [];
  const rows = items
    .filter((row) => showClosed || !row.closed)
    .filter((row) => topic === undefined || onTopic(row, topic));
  const topicName = (id: string) => topics?.find((t) => t.id === id)?.name;
  const members = data?.members;
  const meta = [
    ws?.name,
    members === undefined
      ? null
      : members === 1
        ? m.workspace_members_one()
        : m.workspace_members_count({ count: members }),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <PracticeFrame className="@container">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2.25">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3">
          <h1 className="t-page-title">{m.study_panel_assignments()}</h1>
          <span className="t-meta mt-1.5 text-fg-muted">{meta}</span>
        </div>
        <Button iconLeft="plus" onClick={() => setCreating(true)}>
          {m.assignment_new()}
        </Button>
      </div>
      <div className="mt-4 mb-1.25 flex flex-wrap items-center gap-2 md:mb-2">
        <Button
          className="px-2.5"
          iconLeft="view"
          onClick={() => setShowClosed(!showClosed)}
          size="sm"
          variant="outline"
        >
          {showClosed ? m.assignment_hide_closed() : m.assignment_show_closed()}
        </Button>
        {items.length > 0 && (
          <TopicFilter
            filter={topic}
            onFilter={setTopic}
            rows={items}
            topics={topics ?? []}
          />
        )}
      </div>
      {isPending ? (
        <SkeletonList className="mt-6" count={5} rowHeight={40} />
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
      ) : rows.length === 0 ? (
        <p className="t-meta mt-6 text-fg-muted">
          {items.length === 0
            ? m.assignment_empty()
            : m.assignment_none_shown()}
        </p>
      ) : (
        <>
          <table className="@4xl:table hidden w-full border-separate border-spacing-0">
            <thead>
              <tr>
                <Th>{m.assignment_col_assignment()}</Th>
                <Th>{m.assignment_col_kind()}</Th>
                <Th>{m.practice_col_topics()}</Th>
                <Th>{m.assignment_col_posted()}</Th>
                <Th>{m.assignment_col_due()}</Th>
                <Th>{m.assignment_col_progress()}</Th>
                <Th>{m.assignment_col_average()}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  className="cursor-pointer [&>td]:hover:bg-surface-hover-bg"
                  key={row.id}
                  onClick={() => void open(row.id)}
                >
                  {/* Takes what the others leave, its text cut to fit. */}
                  <Td className="w-full max-w-0">
                    <StaffTitle row={row} />
                  </Td>
                  <Td muted>{kindLabel(row.kind)}</Td>
                  <Td muted>
                    <TopicsCell row={row} topicName={topicName} />
                  </Td>
                  <Td muted>{dayLabel(row.postedAt)}</Td>
                  <Td muted>{row.dueAt ? dayLabel(row.dueAt) : '–'}</Td>
                  <Td>
                    <Progress row={row} />
                  </Td>
                  <Td>
                    {row.manage?.average === undefined ? (
                      <span className="text-fg-muted">–</span>
                    ) : (
                      <span className="font-bold">
                        {percentText(row.manage.average)}
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Phones and narrow panes: one row per assignment. */}
          <ul className="@4xl:hidden">
            {rows.map((row) => (
              <li className="border-divider border-b" key={row.id}>
                <button
                  className="flex min-h-14 w-full items-center gap-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset"
                  onClick={() => void open(row.id)}
                  type="button"
                >
                  <div className="min-w-0 flex-1">
                    <StaffTitle row={row} />
                    <div className="t-meta mt-0.5 truncate text-fg-muted">
                      {[
                        kindLabel(row.kind),
                        row.dueAt
                          ? m.assignment_due({ date: dayLabel(row.dueAt) })
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                    <div className="mt-1">
                      <Progress row={row} />
                    </div>
                  </div>
                  {row.manage?.average !== undefined && (
                    <span className="font-bold">
                      {percentText(row.manage.average)}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {creating && (
        <NewAssignmentDialog
          onClose={closeNew}
          onDone={(created) => {
            closeNew();
            userToast({
              button: {
                label: m.assignment_undo(),
                onClick: () => remove(created.id),
              },
              title: m.assignment_created(),
              variant: 'success',
            });
          }}
          presetQuizId={newFromQuiz}
          workspaceId={workspaceId}
        />
      )}
    </PracticeFrame>
  );
}

function StaffTitle({ row }: { row: Assignment }) {
  const waiting = row.manage?.toApprove ?? 0;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate font-semibold">{row.title}</span>
      {row.draft && (
        <span className="inline-flex h-5.5 shrink-0 items-center rounded-md bg-page-hover px-1.75 font-semibold text-fg-secondary text-xs">
          {m.assignment_draft()}
        </span>
      )}
      {waiting > 0 && (
        <span className="t-meta shrink-0 font-semibold text-tint-warning-fg">
          {m.assignment_to_approve({ count: waiting })}
        </span>
      )}
    </div>
  );
}

/** "Membranes and transport +4": the main topic, then how many more. */
function TopicsCell({
  row,
  topicName,
}: {
  row: Assignment;
  topicName: (id: string) => string | undefined;
}) {
  const [first, ...rest] = row.topicIds;
  return (
    <span className="flex min-w-0 max-w-55 items-center gap-1.5">
      <span className="truncate">
        {first ? topicName(first) : m.topic_other_files()}
      </span>
      {rest.length > 0 && (
        <span className="shrink-0 font-bold">+{rest.length}</span>
      )}
    </span>
  );
}

function Progress({ row }: { row: Assignment }) {
  const done = row.manage?.done ?? 0;
  const assigned = row.manage?.assigned ?? 0;
  if (row.draft) return <span className="text-fg-muted">–</span>;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate font-semibold text-fg-muted">
        <b className="font-bold text-fg">{done}</b>{' '}
        {row.kind === 'marked'
          ? m.assignment_of_submitted({ total: assigned })
          : m.assignment_of_done({ total: assigned })}
      </span>
      <span
        aria-hidden
        className="inline-block h-1 w-14 shrink-0 overflow-hidden rounded-full bg-divider"
      >
        <span
          className="block h-full bg-solid-accent-1"
          style={{ width: `${assigned ? (done / assigned) * 100 : 0}%` }}
        />
      </span>
    </span>
  );
}

/** A member's table (W3): what is assigned to them with Start or Mark done;
 * Show done brings back finished ones and their marks. A row opens its page. */
function MemberList({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const { data: ws } = useWorkspace(workspaceId);
  const { data, error, isError, isPending, refetch } = useAssignments(
    workspaceId,
    { errorBoundary: false }
  );
  const { mutate: setDone, isPending: ticking } =
    useSetAssignmentDone(workspaceId);
  const { dialog, start, starting } = useAssignmentStart(workspaceId);
  const [showDone, setShowDone] = useState(false);
  const items = data?.items ?? [];
  const rows = items.filter((row) => showDone || !row.mine?.done);
  const open = (row: Assignment) =>
    navigate({
      search: {
        assignment: row.id,
        ...(row.kind === 'marked' && row.mine?.countedAttemptId
          ? { attempt: row.mine.countedAttemptId }
          : {}),
        study: 'assignments' as const,
      },
      to: '.',
    });
  const action = (row: Assignment) => {
    const mine = row.mine;
    if (!mine) return null;
    if (row.kind === 'unmarked')
      return mine.done ? (
        <span className="t-meta font-semibold text-fg-muted">
          {m.assignment_done()}
        </span>
      ) : (
        <Button
          disabled={ticking}
          onClick={(event) => {
            event.stopPropagation();
            setDone({ done: true, id: row.id });
          }}
          size="sm"
          variant="outline"
        >
          {m.assignment_mark_done()}
        </Button>
      );
    if (mine.done)
      return (
        <span className="font-bold">
          {markText(mine.mark ?? 0, (mine.total ?? 0) - mine.waitingMarks)}
        </span>
      );
    if (row.closedAt)
      return (
        <span className="t-meta font-semibold text-tint-error-fg">
          {m.assignment_missing()}
        </span>
      );
    return (
      <Button
        disabled={starting}
        onClick={(event) => {
          event.stopPropagation();
          start(row);
        }}
        size="sm"
      >
        {mine.runningAttemptId ? m.assignment_continue() : m.assignment_start()}
      </Button>
    );
  };
  return (
    <PracticeFrame className="@container">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3">
        <h1 className="t-page-title">{m.study_panel_assignments()}</h1>
        <span className="t-meta mt-1.5 text-fg-muted">{ws?.name}</span>
      </div>
      <div className="mt-4 mb-1.25 flex items-center gap-2 md:mb-2">
        <Button
          className="px-2.5"
          iconLeft="view"
          onClick={() => setShowDone(!showDone)}
          size="sm"
          variant="outline"
        >
          {showDone ? m.assignment_hide_done() : m.assignment_show_done()}
        </Button>
      </div>
      {isPending ? (
        <SkeletonList className="mt-6" count={4} rowHeight={40} />
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
      ) : rows.length === 0 ? (
        <p className="t-meta mt-6 text-fg-muted">
          {items.length === 0
            ? m.assignment_member_empty()
            : m.assignment_all_done()}
        </p>
      ) : (
        <>
          <table className="@2xl:table hidden w-full border-separate border-spacing-0">
            <thead>
              <tr>
                <Th>{m.assignment_col_assignment()}</Th>
                <Th>{m.assignment_col_kind()}</Th>
                <Th>{m.assignment_col_posted()}</Th>
                <Th>{m.assignment_col_due()}</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  className="cursor-pointer [&>td]:hover:bg-surface-hover-bg"
                  key={row.id}
                  onClick={() => void open(row)}
                >
                  <Td className="w-full max-w-0">
                    <MemberTitle row={row} />
                  </Td>
                  <Td muted>{kindLabel(row.kind)}</Td>
                  <Td muted>{dayLabel(row.postedAt)}</Td>
                  <Td muted>{row.dueAt ? dayLabel(row.dueAt) : '–'}</Td>
                  <Td className="text-right">{action(row)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="@2xl:hidden">
            {rows.map((row) => (
              <li
                className="flex min-h-14 cursor-pointer items-center gap-3 border-divider border-b py-2"
                key={row.id}
                onClick={() => void open(row)}
              >
                <div className="min-w-0 flex-1">
                  <MemberTitle row={row} />
                  <div className="t-meta mt-0.5 truncate text-fg-muted">
                    {[
                      kindLabel(row.kind),
                      row.dueAt
                        ? m.assignment_due({ date: dayLabel(row.dueAt) })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                {action(row)}
              </li>
            ))}
          </ul>
        </>
      )}
      {dialog}
    </PracticeFrame>
  );
}

function MemberTitle({ row }: { row: Assignment }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span
        className={cn(
          'truncate font-semibold',
          row.mine?.done && 'text-fg-muted'
        )}
      >
        {row.title}
      </span>
      {row.mine?.late && <LateBadge penaltyPct={row.mine.latePenaltyPct} />}
      {row.mine?.missing && !row.closedAt && (
        <span className="t-meta shrink-0 font-semibold text-tint-error-fg">
          {row.latePenaltyPct > 0
            ? m.assignment_overdue_penalty({ percent: row.latePenaltyPct })
            : m.assignment_overdue()}
        </span>
      )}
    </div>
  );
}
