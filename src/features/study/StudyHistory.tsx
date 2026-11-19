import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useStudyHistory, useWorkspaces } from '@/api/hooks';
import type {
  HistoryKind,
  HistoryRow,
  HistorySort,
  HistoryStatus,
} from '@/api/types';
import { ListEnd } from '@/components/app/ListEnd';
import { ListToolbar, toggleValue } from '@/components/app/ListToolbar';
import { PageBody } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import type { ColumnSort } from '@/components/app/SortHeader';
import { WorkspaceCell } from '@/components/app/WorkspaceCell';
import { FileIcon } from '@/components/ui/FileIcon';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { BillingTable } from '@/features/billing/BillingTable';
import { formatPoints } from '@/features/quizzes/grade';
import { getLocale, m } from '@/i18n';
import { cn } from '@/lib/cn';
import { materialIconName } from '@/lib/fileIcons';
import { csv, sortSearch } from '@/lib/listSearch';
import { waitsForConnection } from '@/lib/online';
import { useLoadingReveal } from '@/lib/useLoadingReveal';
import { resultLink } from './attempts';
import { ContinueLink } from './ContinueLink';
import {
  HISTORY_KINDS,
  HISTORY_SORT_DEFAULT,
  HISTORY_STATUSES,
  type HistorySearch,
  historyParams,
} from './reviewSearch';
import { groupName } from './reviewText';

const STATUS_LABEL: Record<HistoryStatus, () => string> = {
  done: m.history_status_done,
  open: m.history_status_in_progress,
  partial: m.history_status_partly,
};

const KIND_LABEL: Record<HistoryKind, () => string> = {
  flashcards: m.editor_flashcards,
  quiz: m.editor_quiz,
  revision: m.history_revision,
};

/** Learning → History (Epo 2026-11-13): revisions and quiz and flashcard
 * attempts in one table under the list toolbar, sorted, filtered and paged
 * by the server. A row opens its result, or goes on where it stopped. */
export function StudyHistory({ workspaceId }: { workspaceId?: string }) {
  const search = useSearch({ strict: false }) as HistorySearch;
  const navigate = useNavigate();
  // In a workspace (its Study's History tab) the list is that workspace's,
  // with no Workspace filter or column.
  const setSearch = (patch: HistorySearch) =>
    void navigate({
      replace: true,
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      to: workspaceId ? '.' : '/learning',
    });
  const params = useMemo(
    () => ({
      ...historyParams(search),
      ...(workspaceId ? { workspaceIds: [workspaceId] } : {}),
    }),
    [search, workspaceId]
  );
  const {
    sort = HISTORY_SORT_DEFAULT,
    kinds = [],
    statuses = [],
    workspaceIds = [],
  } = params;
  const {
    data,
    fetchNextPage,
    fetchStatus,
    hasNextPage,
    isFetchNextPageError,
    isFetchingNextPage,
    isLoading,
  } = useStudyHistory(params);
  const { data: workspaces = [] } = useWorkspaces(
    { sort: 'accessed' },
    { errorBoundary: false }
  );
  const revealRef = useLoadingReveal(isLoading);
  const rows = data?.pages.flatMap((page) => page.items) ?? [];
  const sorting: ColumnSort<HistorySort> = {
    ascending: params.dir === 'asc',
    ascendingFirst: ['workspace', 'name', 'topic'],
    onSortChange: (next, asc) =>
      setSearch(sortSearch('history', next, asc, HISTORY_SORT_DEFAULT)),
    sort,
  };
  const filtered =
    kinds.length > 0 ||
    statuses.length > 0 ||
    (!workspaceId && workspaceIds.length > 0);

  return (
    <>
      <ListToolbar
        filters={[
          {
            key: 'kind',
            label: m.files_filter_kind(),
            onToggle: (value) =>
              setSearch({ kind: csv(toggleValue(kinds, value)) }),
            options: HISTORY_KINDS.map((kind) => ({
              label: KIND_LABEL[kind](),
              value: kind,
            })),
            selected: kinds,
          },
          {
            key: 'status',
            label: m.history_col_status(),
            onToggle: (value) =>
              setSearch({ status: csv(toggleValue(statuses, value)) }),
            options: HISTORY_STATUSES.map((status) => ({
              label: STATUS_LABEL[status](),
              value: status,
            })),
            selected: statuses,
          },
          ...(workspaceId
            ? []
            : [
                {
                  emptyLabel: m.common_nothing_yet(),
                  key: 'workspace',
                  label: m.files_filter_workspace(),
                  onToggle: (value: string) =>
                    setSearch({
                      workspace: csv(toggleValue(workspaceIds, value)),
                    }),
                  options: workspaces.map((ws) => ({
                    label: ws.name,
                    value: ws.id,
                  })),
                  selected: workspaceIds,
                },
              ]),
        ]}
        onResetFilters={() =>
          setSearch({
            kind: undefined,
            status: undefined,
            workspace: undefined,
          })
        }
      />
      <PageBody belowToolbar>
        {waitsForConnection(fetchStatus, data) ? (
          <QueryPausedState />
        ) : isLoading ? (
          <SkeletonList count={6} rowHeight={44} />
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-fg-muted">
            {filtered ? m.common_no_matches() : m.history_empty()}
          </p>
        ) : (
          <div className="flex flex-col gap-3" ref={revealRef}>
            {/* Billing's plain table, scrolling sideways on phones. */}
            <BillingTable
              columns={[
                { id: 'date', label: m.quiz_col_date(), sort: 'date' },
                ...(workspaceId
                  ? []
                  : [
                      {
                        clamp: true,
                        id: 'workspace',
                        label: m.quiz_col_workspace(),
                        sort: 'workspace' as const,
                      },
                    ]),
                {
                  clamp: true,
                  className: 'md:max-w-none',
                  id: 'name',
                  label: m.list_col_name(),
                  sort: 'name',
                },
                {
                  clamp: true,
                  id: 'topic',
                  label: m.history_col_topic(),
                  sort: 'topic',
                },
                { id: 'score', label: m.quiz_col_score(), sort: 'score' },
                { id: 'status', label: m.history_col_status() },
              ]}
              rows={rows.map((r) => ({
                cells: {
                  date: formatDate(r.at),
                  name: <RowLink row={r} />,
                  score:
                    r.total > 0
                      ? `${formatPoints(r.correct)} / ${formatPoints(r.total)}`
                      : '-',
                  status: <Status row={r} />,
                  topic: topicText(r),
                  workspace: (
                    <WorkspaceCell iconId={r.iconId} name={r.workspaceName} />
                  ),
                },
                className: 'relative h-11 hover:bg-surface-hover-bg',
                key: `${r.kind}-${r.id}`,
              }))}
              sorting={sorting}
            />
            <ListEnd
              fetchNextPage={fetchNextPage}
              hasNextPage={hasNextPage}
              isFetchingNextPage={isFetchingNextPage}
              isFetchNextPageError={isFetchNextPageError}
            />
          </div>
        )}
      </PageBody>
    </>
  );
}

const LINK_COVER =
  'wrap-break-word line-clamp-2 after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-action focus-visible:after:ring-inset';

/** What the row is and its name, linking the whole row: an unfinished one
 * goes on where it stopped, the rest open their result. */
function RowLink({ row: r }: { row: HistoryRow }) {
  const icon =
    r.kind === 'revision' ? (
      <Icon className="shrink-0 text-tint-warning-fg" name="retry" size={18} />
    ) : (
      <FileIcon className="size-4.5 shrink-0" name={materialIconName(r.kind)} />
    );
  const name = r.kind === 'revision' ? m.history_revision() : r.name;
  let link: React.ReactNode;
  if (r.status === 'open')
    link = (
      <ContinueLink className={LINK_COVER} row={r}>
        {name}
      </ContinueLink>
    );
  else if (r.kind === 'revision')
    link = (
      <Link
        className={LINK_COVER}
        params={{ sessionId: r.id }}
        to="/learning/reviews/$sessionId"
      >
        {name}
      </Link>
    );
  else
    link = (
      <Link className={LINK_COVER} {...resultLink({ id: r.id, kind: r.kind })}>
        {name}
      </Link>
    );
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {icon}
      {link}
    </div>
  );
}

/** A revision's topic, Other files or All topics; an attempt's topics. */
function topicText(r: HistoryRow) {
  if (r.kind !== 'revision') return r.topics.join(', ');
  if (r.group === 'workspace') return m.history_all_topics();
  return groupName(r.group ?? 'workspace', r.topics[0]);
}

/** Done; "6 of 15 answered" for one that ended with some left (skipped or
 * ended early); "In progress · 4 of 10" for one that can go on. */
function Status({ row: r }: { row: HistoryRow }) {
  if (r.status === 'done') return m.history_status_done();
  const counts = { answered: r.answered, total: r.items };
  return (
    <span
      className={cn(
        r.status === 'open' ? 'text-tint-info-fg' : 'text-tint-warning-fg'
      )}
    >
      {r.status === 'open'
        ? m.history_status_open(counts)
        : m.history_status_partial(counts)}
    </span>
  );
}

const formatDate = (iso: string) =>
  new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium' }).format(
    new Date(iso)
  );
