import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import {
  type AssignmentSort,
  useAssignment,
  useAssignments,
  useDeleteAssignment,
  useTopics,
  useWorkspace,
} from '@/api/hooks';
import type { Assignment } from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { ListEnd } from '@/components/app/ListEnd';
import { FilterPopover, toggleValue } from '@/components/app/ListToolbar';
import type { ColumnSort } from '@/components/app/SortHeader';
import { Button } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/feedback';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { unexpectedErrorId } from '@/lib/errors';
import { useLoadingReveal } from '@/lib/useLoadingReveal';
import {
  ListRow,
  PracticeFrame,
  Td,
  Th,
  TopicsCell,
} from '../practice/studyPage';
import { studyView } from '../practice/studyView';
import type { AssignmentsSearch } from '../studyRoutes';
import { AssignmentAttemptPage } from './AssignmentAttemptPage';
import { AssignmentReport } from './AssignmentReport';
import { dayLabel, kindLabel, percentText } from './assignmentText';
import { MemberAssignment } from './MemberAssignment';
import { NewAssignmentMenu } from './NewAssignmentMenu';
import { TodoSection } from './TodoSection';

/** A class's To do, Assignments to its staff (boards W1, W2; its own page on
 * the rail since Epo 2026-11-11), the workspace's centre page at
 * `assignments`. A member's is To do's table for this class (Epo 2026-11-20),
 * as its Dashboard shows it. */
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
        fromProfile={
          search.member
            ? { member: search.member, show: search.show }
            : undefined
        }
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
    // A member's: the To do page's table for this class (Epo 2026-11-20), as
    // its Dashboard shows it.
    <PracticeFrame className="@container">
      <TodoSection manages={false} page workspace={ws} />
    </PracticeFrame>
  );
}

/** One assignment's page: its report to whoever runs it (unless `own`), else
 * the page of the one it is given to. */
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

/** A column sort the server runs (Epo 2026-11-13), open ones still before
 * closed ones: Posted, newest first, until another column is picked (Epo
 * 2026-11-20); text starts A to Z, dates newest first. */
function useAssignmentSort() {
  const [server, setSort] = useState<{
    ascending: boolean;
    by: AssignmentSort;
  }>({ ascending: false, by: 'posted' });
  const sorting: ColumnSort<AssignmentSort> = {
    ascending: server.ascending,
    ascendingFirst: ['title', 'kind', 'topic'],
    onSortChange: (by, ascending) => setSort({ ascending, by }),
    sort: server.by,
  };
  return { server, sorting };
}

/** The owner's and teaching assistants' table (W1, W2): open ones newest first,
 * closed ones behind Show closed. A row opens the report. */
function StaffList({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const { data: workspaceTopics } = useTopics(workspaceId);
  const [showClosed, setShowClosed] = useState(false);
  const [topics, setTopics] = useState<string[]>([]);
  // Both kinds picked keeps both, as none does.
  const [kinds, setKinds] = useState<Assignment['kind'][]>([]);
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
    {
      closed: showClosed,
      done: true,
      kind: kinds.length === 1 ? kinds[0] : undefined,
      sort: server,
      topics,
    },
    { errorBoundary: false }
  );
  const revealRef = useLoadingReveal(isPending);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { mutate: remove } = useDeleteAssignment(workspaceId);
  const open = (id: string) =>
    navigate({ search: { assignment: id }, to: '.' });
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
          // New graded quiz says its own, with Open (GradedQuizDialog).
          onCreated={(created) => {
            if (created.kind === 'marked') return;
            userToast({
              button: {
                label: m.assignment_undo(),
                onClick: () => remove(created.id),
              },
              title: m.assignment_created(),
              variant: 'success',
            });
          }}
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
        {/* The list pages' Filter: the workspace's topics, no Other files
            (Epo 2026-11-13), and the kind (Epo 2026-11-19); the server
            filters, as the list comes in pages. */}
        <FilterPopover
          filters={[
            ...(workspaceTopics?.length
              ? [
                  {
                    key: 'topic',
                    label: m.practice_col_topics(),
                    onToggle: (value: string) =>
                      setTopics(toggleValue(topics, value)),
                    options: workspaceTopics.map((t) => ({
                      label: t.name,
                      value: t.id,
                    })),
                    selected: topics,
                  },
                ]
              : []),
            {
              key: 'kind',
              label: m.assignment_col_kind(),
              onToggle: (value: string) =>
                setKinds(toggleValue(kinds, value as Assignment['kind'])),
              options: [
                { label: m.assignment_kind_marked(), value: 'marked' },
                { label: m.assignment_kind_assignment(), value: 'unmarked' },
              ],
              selected: kinds,
            },
          ]}
          onResetFilters={() => {
            setTopics([]);
            setKinds([]);
          }}
        />
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
          {topics.length || kinds.length
            ? m.common_no_matches()
            : m.common_nothing_yet()}
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
                {/* Its whole label: it starts sorted (Epo 2026-11-20), and its
                      dates alone are narrower. */}
                <Th sort={{ fit: true, sorting, value: 'posted' as const }}>
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
              <ListRow
                className={cn(row.closed && 'opacity-55')}
                key={row.id}
                onOpen={() => void open(row.id)}
              >
                <div className="min-w-0 flex-1">
                  {/* Title and progress only, two lines (Epo 2026-11-20):
                        the kind is the wide table's column. */}
                  <StaffTitle row={row} />
                  <div className="mt-1">
                    <Progress bar row={row} />
                  </div>
                </div>
                {/* The due date at the row's end, not the average (Epo
                      2026-11-16); the wide table keeps both columns. */}
                {row.dueAt && (
                  <span className="t-meta shrink-0 text-fg-muted">
                    {m.assignment_due({ date: dayLabel(row.dueAt) })}
                  </span>
                )}
              </ListRow>
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
