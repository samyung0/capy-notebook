import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import {
  type AssignmentSort,
  useAssignment,
  useAssignments,
  useDeleteAssignment,
  useSetAssignmentDone,
  useTopics,
  useWorkspace,
} from '@/api/hooks';
import type { Assignment } from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { ListEnd } from '@/components/app/ListEnd';
import { FilterPopover, toggleValue } from '@/components/app/ListToolbar';
import type { ColumnSort } from '@/components/app/SortHeader';
import { Button, PageButton } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/feedback';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { unexpectedErrorId } from '@/lib/errors';
import { useLoadingReveal } from '@/lib/useLoadingReveal';
import { PracticeFrame, Td, Th, TopicsCell } from '../practice/studyPage';
import { studyView } from '../practice/studyView';
import { AssignmentAttemptPage } from './AssignmentAttemptPage';
import { AssignmentReport } from './AssignmentReport';
import { dayLabel, kindLabel, markText, percentText } from './assignmentText';
import { LateBadge } from './LateBadge';
import { NewAssignmentDialog } from './LazyNewAssignmentDialog';
import { MemberAssignment } from './MemberAssignment';
import { NewAssignmentMenu } from './NewAssignmentMenu';
import { OwnTaskDetails } from './TodoDialog';
import { useAssignmentStart } from './useAssignmentStart';

/** A report's tab in the URL: a graded quiz's Questions, Responses (`approve`
 * its Approve AI grades view) and Settings; a task's Members, Settings and
 * Preview. */
export type ReportTab =
  | 'questions'
  | 'responses'
  | 'approve'
  | 'members'
  | 'settings'
  | 'preview';

/** The Assignments page's URL, under `study=assignments`. `assignment` opens
 * one: its report for a class's owner and teaching assistants (unless `own`, the
 * page of one given to them), its page for a member. `attempt` opens a try: a
 * running one, or results, a member's for staff. `tab`, `by`, `question` and
 * `member` are a report's view (todo-study-tracking.md §9, Links); `by`
 * is Responses' By question (By member without it). */
export type AssignmentsSearch = {
  assignment?: string;
  attempt?: string;
  member?: string;
  own?: true;
  question?: string;
  by?: 'question';
  tab?: ReportTab;
};

/** The workspace's To do, Assignments to a class's staff (boards W1, W2 for
 * staff, W3 for members; its own page on the rail since Epo 2026-11-11), the
 * workspace's centre page while `study=assignments` is in its URL. */
export function AssignmentsPage({
  search,
  workspaceId,
}: {
  search: AssignmentsSearch;
  workspaceId: string;
}) {
  const { data: ws } = useWorkspace(workspaceId);
  if (!ws) return null;
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
    <StaffList key={workspaceId} workspaceId={workspaceId} />
  ) : (
    <MemberList workspaceId={workspaceId} />
  );
}

/** One assignment's or task's page: its report to whoever runs it (unless
 * `own`), else the page of the one it is given to. */
export function AssignmentDetail({
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
          errorId={unexpectedErrorId(error)}
          onRetry={() => void refetch()}
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

/** A column sort the server runs (Epo 2026-11-13): none active is the
 * page's own order; text starts A to Z, dates newest first. */
function useAssignmentSort() {
  const [sort, setSort] = useState<{
    ascending: boolean;
    by: AssignmentSort | 'order';
  }>({ ascending: true, by: 'order' });
  const sorting: ColumnSort<AssignmentSort | 'order'> = {
    ascending: sort.ascending,
    ascendingFirst: ['title', 'kind', 'topic'],
    onSortChange: (by, ascending) => setSort({ ascending, by }),
    sort: sort.by,
  };
  const server =
    sort.by === 'order'
      ? undefined
      : { ascending: sort.ascending, by: sort.by };
  return { server, sorting };
}

/** The owner's and teaching assistants' table (W1, W2): open ones by due date,
 * closed ones behind Show closed. A row opens the report. */
function StaffList({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const { data: workspaceTopics } = useTopics(workspaceId);
  const [showClosed, setShowClosed] = useState(false);
  const [topics, setTopics] = useState<string[]>([]);
  const { server, sorting } = useAssignmentSort();
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchingNextPage,
    isFetchNextPageError,
    isPending,
    refetch,
  } = useAssignments(
    workspaceId,
    { closed: showClosed, done: true, sort: server, topics },
    { errorBoundary: false }
  );
  const revealRef = useLoadingReveal(isPending);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { mutate: remove } = useDeleteAssignment(workspaceId);
  const open = (id: string) =>
    navigate({
      search: { assignment: id, study: 'assignments' as const },
      to: '.',
    });
  // Open ones first, then closed ones behind Show closed, a page at a time.
  const rows = data?.pages.flatMap((page) => page.items) ?? [];
  const topicName = (id: string) =>
    workspaceTopics?.find((t) => t.id === id)?.name;
  return (
    <PracticeFrame className="@container" ref={scrollRef}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2.25">
        {/* The title alone: no hint text beside it (Epo 2026-11-13). */}
        <h1 className="t-page-title">{m.study_panel_assignments()}</h1>
        <NewAssignmentMenu
          onCreated={(created) =>
            userToast({
              button: {
                label: m.assignment_undo(),
                onClick: () => remove(created.id),
              },
              title:
                created.kind === 'marked'
                  ? m.assignment_created_graded()
                  : m.assignment_created(),
              variant: 'success',
            })
          }
          own={false}
          workspaceId={workspaceId}
        />
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
        {!!workspaceTopics?.length && (
          // The list pages' Filter: the workspace's topics, no Other files
          // (Epo 2026-11-13); the server filters, as the list comes in pages.
          <FilterPopover
            filters={[
              {
                key: 'topic',
                label: m.practice_col_topics(),
                onToggle: (value) => setTopics(toggleValue(topics, value)),
                options: workspaceTopics.map((t) => ({
                  label: t.name,
                  value: t.id,
                })),
                selected: topics,
              },
            ]}
            onResetFilters={() => setTopics([])}
          />
        )}
      </div>
      {isPending ? (
        <SkeletonList className="mt-6" count={5} rowHeight={40} />
      ) : isError ? (
        <ErrorState
          className="h-auto py-20"
          errorId={unexpectedErrorId(error)}
          onRetry={() => void refetch()}
          title={m.assignment_load_failed()}
          variant="panel"
        />
      ) : rows.length === 0 ? (
        <p className="t-meta mt-6 text-fg-muted">
          {topics.length ? m.common_no_matches() : m.common_nothing_yet()}
        </p>
      ) : (
        <div ref={revealRef}>
          <table className="@4xl:table hidden w-full border-separate border-spacing-0">
            <thead>
              <tr>
                <Th sort={{ sorting, value: 'title' as const }}>
                  {m.assignment_col_assignment()}
                </Th>
                <Th sort={{ sorting, value: 'kind' as const }}>
                  {m.assignment_col_kind()}
                </Th>
                <Th sort={{ sorting, value: 'topic' as const }}>
                  {m.practice_col_topics()}
                </Th>
                <Th sort={{ sorting, value: 'posted' as const }}>
                  {m.assignment_col_posted()}
                </Th>
                <Th sort={{ sorting, value: 'due' as const }}>
                  {m.assignment_col_due()}
                </Th>
                <Th>{m.assignment_col_progress()}</Th>
                <Th>{m.assignment_col_average()}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  className={cn(
                    'cursor-pointer hover:[&>td]:bg-surface-hover-bg',
                    // Closed reads apart from open (Epo 2026-11-13), muted
                    // as To do's done rows are.
                    row.closed && '[&>td]:opacity-55'
                  )}
                  key={row.id}
                  onClick={() => void open(row.id)}
                >
                  {/* Takes what the others leave, its text cut to fit. */}
                  <Td className="w-full max-w-0">
                    <StaffTitle row={row} />
                  </Td>
                  <Td muted>{kindLabel(row)}</Td>
                  <Td muted>
                    <TopicsCell topicIds={row.topicIds} topicName={topicName} />
                  </Td>
                  <Td muted>{dayLabel(row.postedAt)}</Td>
                  <Td muted>{row.dueAt ? dayLabel(row.dueAt) : '–'}</Td>
                  {/* The count alone; the phones' rows keep the bar. */}
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
                  className={cn(
                    'flex min-h-14 w-full items-center gap-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset',
                    row.closed && 'opacity-55'
                  )}
                  onClick={() => void open(row.id)}
                  type="button"
                >
                  <div className="min-w-0 flex-1">
                    <StaffTitle row={row} />
                    <div className="t-meta mt-0.5 truncate text-fg-muted">
                      {[
                        kindLabel(row),
                        row.dueAt
                          ? m.assignment_due({ date: dayLabel(row.dueAt) })
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                    <div className="mt-1">
                      <Progress bar row={row} />
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
          {/* Scrolling near the end reads the next page. */}
          <ListEnd
            fetchNextPage={fetchNextPage}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            isFetchNextPageError={isFetchNextPageError}
            root={scrollRef}
          />
        </div>
      )}
    </PracticeFrame>
  );
}

function StaffTitle({ row }: { row: Assignment }) {
  // Waiting answers split into AI-marked (to approve) and not graded (T3).
  const notGraded = row.manage?.notGraded ?? 0;
  const waiting = (row.manage?.toApprove ?? 0) - notGraded;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate font-semibold">{row.title}</span>
      {row.draft && (
        <span className="inline-flex h-5.5 shrink-0 items-center rounded-md bg-page-hover px-1.75 font-semibold text-fg-secondary text-xs">
          {m.assignment_draft()}
        </span>
      )}
      {waiting > 0 && (
        <span className="t-meta shrink-0 font-semibold text-tint-accent-1-fg">
          {m.assignment_to_approve({ count: waiting })}
        </span>
      )}
      {notGraded > 0 && (
        <span className="t-meta shrink-0 font-semibold text-tint-warning-fg">
          {m.assignment_not_graded({ count: notGraded })}
        </span>
      )}
    </div>
  );
}

function Progress({ bar, row }: { bar?: boolean; row: Assignment }) {
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
      {bar && (
        <span
          aria-hidden
          className="inline-block h-1 w-14 shrink-0 overflow-hidden rounded-full bg-divider"
        >
          <span
            className="block h-full bg-solid-accent-1"
            style={{ width: `${assigned ? (done / assigned) * 100 : 0}%` }}
          />
        </span>
      )}
    </span>
  );
}

/** A member's table (W3): what is assigned to them with Start or Mark done;
 * Show done brings back finished ones and their marks. A row opens its page. */
function MemberList({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const { data: ws } = useWorkspace(workspaceId);
  const [showDone, setShowDone] = useState(false);
  const { server, sorting } = useAssignmentSort();
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchingNextPage,
    isFetchNextPageError,
    isPending,
    refetch,
  } = useAssignments(
    workspaceId,
    { closed: true, done: showDone, sort: server, topics: [] },
    { errorBoundary: false }
  );
  const revealRef = useLoadingReveal(isPending);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { mutate: setDone, isPending: ticking } =
    useSetAssignmentDone(workspaceId);
  const { dialog, start, starting } = useAssignmentStart(workspaceId);
  const [adding, setAdding] = useState(false);
  const [openTask, setOpenTask] = useState<Assignment | null>(null);
  // Done ones come only with Show done, a page at a time.
  const rows = data?.pages.flatMap((page) => page.items) ?? [];
  // The task as last read; marked done, it leaves the list but not its dialog.
  const task = openTask
    ? (rows.find((row) => row.id === openTask.id) ?? openTask)
    : undefined;
  const open = (row: Assignment) => {
    // A task they set themself opens its details here.
    if (row.own) return setOpenTask(row);
    return navigate({
      search: {
        assignment: row.id,
        ...(row.kind === 'marked' && row.mine?.countedAttemptId
          ? { attempt: row.mine.countedAttemptId }
          : {}),
        study: 'assignments' as const,
      },
      to: '.',
    });
  };
  const action = (row: Assignment) => {
    const mine = row.mine;
    if (!mine) return null;
    // A graded Assignment's grade, once given and shown (Epo 2026-11-14).
    if (row.kind === 'unmarked' && mine.mark !== undefined)
      return (
        <span className="font-bold">
          {markText(mine.mark, mine.total ?? 0)}
        </span>
      );
    if (row.kind === 'unmarked')
      return mine.done ? (
        <span className="t-meta font-semibold text-fg-muted">
          {row.allowUploads
            ? m.assignment_col_handed_in()
            : m.assignment_done()}
        </span>
      ) : // One that takes files is handed in from its page (S3); a closed one
      // takes no tick.
      row.allowUploads || row.closedAt ? null : (
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
    if (mine.done && row.gradesHidden)
      return (
        <span className="t-meta inline-flex h-5.5 items-center rounded-md bg-page-hover px-1.75 font-semibold text-fg-secondary text-xs">
          {m.assignment_submitted()}
        </span>
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
    <PracticeFrame className="@container" ref={scrollRef}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2.25">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3">
          <h1 className="t-page-title">{m.nav_todo()}</h1>
        </div>
        {/* Where staff have New: only they give out assignments (Epo
            2026-11-10), so a member's is a task for themself; a personal
            workspace's New also makes a graded quiz (Epo 2026-11-14). */}
        {ws?.role &&
          (ws.kind === 'class' ? (
            <PageButton iconLeft="plus" onClick={() => setAdding(true)}>
              {m.todo_new_task()}
            </PageButton>
          ) : (
            <NewAssignmentMenu own workspaceId={workspaceId} />
          ))}
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
          className="h-auto py-20"
          errorId={unexpectedErrorId(error)}
          onRetry={() => void refetch()}
          title={m.assignment_load_failed()}
          variant="panel"
        />
      ) : rows.length === 0 ? (
        // The To do page's empty line.
        <p className="t-subtitle py-20 text-center font-normal text-fg-muted">
          {m.todo_empty()}
        </p>
      ) : (
        <div ref={revealRef}>
          <table className="@2xl:table hidden w-full border-separate border-spacing-0">
            <thead>
              <tr>
                <Th sort={{ sorting, value: 'title' as const }}>
                  {m.assignment_col_assignment()}
                </Th>
                <Th sort={{ sorting, value: 'kind' as const }}>
                  {m.assignment_col_kind()}
                </Th>
                <Th sort={{ sorting, value: 'posted' as const }}>
                  {m.assignment_col_posted()}
                </Th>
                <Th sort={{ sorting, value: 'due' as const }}>
                  {m.assignment_col_due()}
                </Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  className={cn(
                    'cursor-pointer hover:[&>td]:bg-surface-hover-bg',
                    row.closed && '[&>td]:opacity-55'
                  )}
                  key={row.id}
                  onClick={() => void open(row)}
                >
                  <Td className="w-full max-w-0">
                    <MemberTitle row={row} />
                  </Td>
                  <Td muted>{kindLabel(row)}</Td>
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
                className={cn(
                  'flex min-h-14 cursor-pointer items-center gap-3 border-divider border-b py-2',
                  row.closed && 'opacity-55'
                )}
                key={row.id}
                onClick={() => void open(row)}
              >
                <div className="min-w-0 flex-1">
                  <MemberTitle row={row} />
                  <div className="t-meta mt-0.5 truncate text-fg-muted">
                    {[
                      kindLabel(row),
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
          {/* Scrolling near the end reads the next page. */}
          <ListEnd
            fetchNextPage={fetchNextPage}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            isFetchNextPageError={isFetchNextPageError}
            root={scrollRef}
          />
        </div>
      )}
      {dialog}
      {adding && (
        <NewAssignmentDialog
          onClose={() => setAdding(false)}
          onDone={() => setAdding(false)}
          own
          title={m.todo_new_task()}
          workspaceId={workspaceId}
        />
      )}
      {task && ws && (
        <OwnTaskDetails
          onClose={() => setOpenTask(null)}
          task={task}
          workspace={ws}
        />
      )}
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
