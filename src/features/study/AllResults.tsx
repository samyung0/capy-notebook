import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useAttempts, useWorkspaces } from '@/api/hooks';
import type { Attempt, AttemptSort } from '@/api/types';
import {
  ListToolbar,
  type SortOption,
  toggleValue,
} from '@/components/app/ListToolbar';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { WorkspaceCell } from '@/components/app/WorkspaceCell';
import { Button } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/feedback';
import { Menu } from '@/components/ui/Menu';
import { BillingTable } from '@/features/billing/BillingTable';
import { formatPoints } from '@/features/quizzes/grade';
import { m } from '@/i18n';
import { csv, sortSearch } from '@/lib/listSearch';
import { useLoadingReveal } from '@/lib/useLoadingReveal';
import {
  RESULT_SORT_DEFAULT,
  type ResultsSearch,
  resultParams,
} from './reviewSearch';

/** Learning → All results: quiz attempts with the list pages' sort menu and
 * workspace filter, sorted, filtered and paged by the server. */
export function AllResults() {
  const search = useSearch({ strict: false }) as ResultsSearch;
  const params = useMemo(() => resultParams(search), [search]);
  const { sort = RESULT_SORT_DEFAULT, dir, workspaceIds = [] } = params;
  const {
    data,
    fetchNextPage,
    fetchStatus,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
  } = useAttempts(params);
  const { data: workspaces = [] } = useWorkspaces(
    { sort: 'accessed' },
    { errorBoundary: false }
  );
  const revealRef = useLoadingReveal(isLoading);
  const rows = data?.pages.flatMap((page) => page.items) ?? [];
  const navigate = useNavigate();
  const setSearch = (patch: ResultsSearch) =>
    void navigate({
      replace: true,
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      to: '/learning',
    });
  const sorts: SortOption<AttemptSort>[] = [
    { icon: 'clock', label: m.past_sort_newest(), value: 'date' },
    { icon: 'quiz', label: m.quiz_col_score(), value: 'score' },
  ];
  // Attempts of a deleted quiz have no quiz to redo.
  const redo = (quizId: string | null) =>
    quizId
      ? [
          {
            icon: 'refresh' as const,
            label: m.quiz_redo(),
            onClick: () =>
              navigate({ params: { quizId }, to: '/quizzes/$quizId/attempt' }),
          },
        ]
      : [];
  const menu = (a: Attempt) => (
    <div className="relative z-10 -my-2 flex justify-end">
      <Menu
        items={[
          {
            icon: 'list',
            label: m.quiz_check_result(),
            onClick: () =>
              navigate({
                params: { attemptId: a.id },
                to: '/quizzes/attempts/$attemptId',
              }),
          },
          ...redo(a.materialId),
        ]}
      />
    </div>
  );

  return (
    <div className="flex flex-col">
      {/* Lifted so the toolbar's labels start at the table's edge; nudged
       * left over the plain table, whose text has no inset. */}
      <div className="-mx-4 -translate-x-0.5 sm:-mx-6 md:translate-x-0">
        <ListToolbar
          ascending={dir === 'asc'}
          filters={[
            {
              emptyLabel: m.create_filter_no_workspaces(),
              key: 'workspace',
              label: m.files_filter_workspace(),
              onToggle: (value) =>
                setSearch({ workspace: csv(toggleValue(workspaceIds, value)) }),
              options: workspaces.map((ws) => ({
                label: ws.name,
                value: ws.id,
              })),
              selected: workspaceIds,
            },
          ]}
          onResetFilters={() => setSearch({ workspace: undefined })}
          onSortChange={(next, asc) =>
            setSearch(sortSearch('results', next, asc, RESULT_SORT_DEFAULT))
          }
          sort={sort}
          sorts={sorts}
        />
      </div>
      <div className="pt-2">
        {fetchStatus === 'paused' && !data ? (
          <QueryPausedState />
        ) : isLoading ? (
          <SkeletonList count={6} rowHeight={52} />
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-fg-muted">
            {m.quiz_no_attempts()}
          </p>
        ) : (
          <div className="flex flex-col gap-3" ref={revealRef}>
            {/* Phones: Billing's plain table, scrolling sideways. */}
            <div className="md:hidden">
              <BillingTable
                columns={[
                  { clamp: true, id: 'quiz', label: m.quiz_col_quiz() },
                  {
                    clamp: true,
                    id: 'workspace',
                    label: m.quiz_col_workspace(),
                  },
                  { id: 'score', label: m.quiz_col_score() },
                  { id: 'date', label: m.quiz_col_date() },
                  { align: 'right', id: 'menu', label: '' },
                ]}
                rows={rows.map((a) => ({
                  cells: {
                    date: formatDate(a),
                    menu: menu(a),
                    quiz: <ResultLink attempt={a} />,
                    score: scoreText(a),
                    workspace: (
                      <WorkspaceCell iconId={a.iconId} name={a.workspaceName} />
                    ),
                  },
                  className: 'relative hover:bg-surface-hover-bg',
                  key: a.id,
                }))}
              />
            </div>
            <div className="hidden overflow-hidden rounded-card border border-line md:block">
              <div className="grid grid-cols-[minmax(10rem,1.8fr)_minmax(10rem,1.6fr)_minmax(6rem,1fr)_minmax(7rem,1fr)_2.25rem] items-center bg-surface-hover-bg py-3 pr-2 pl-4 font-bold text-fg-muted text-xs uppercase tracking-wide *:pr-4">
                <div>{m.quiz_col_quiz()}</div>
                <div>{m.quiz_col_workspace()}</div>
                <div>{m.quiz_col_score()}</div>
                <div>{m.quiz_col_date()}</div>
                <div />
              </div>
              {rows.map((a) => (
                <div
                  className="relative grid grid-cols-[minmax(10rem,1.8fr)_minmax(10rem,1.6fr)_minmax(6rem,1fr)_minmax(7rem,1fr)_2.25rem] items-center border-divider border-t pr-2 pl-4 text-sm hover:bg-surface-hover-bg"
                  key={a.id}
                >
                  <div className="py-3 pr-4">
                    <ResultLink attempt={a} />
                  </div>
                  <div className="py-3 pr-4">
                    <WorkspaceCell iconId={a.iconId} name={a.workspaceName} />
                  </div>
                  <div className="whitespace-nowrap py-3 pr-4">
                    {scoreText(a)}
                  </div>
                  <div className="whitespace-nowrap py-3 pr-4">
                    {formatDate(a)}
                  </div>
                  {menu(a)}
                </div>
              ))}
            </div>
            {hasNextPage && (
              <Button
                className="self-center"
                disabled={isFetchingNextPage}
                onClick={() => fetchNextPage()}
                size="sm"
                variant="ghost-hover"
              >
                {m.list_load_more()}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The quiz name, linking the whole row to the attempt's result. */
function ResultLink({ attempt: a }: { attempt: Attempt }) {
  return (
    <Link
      className="wrap-break-word line-clamp-2 after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-action focus-visible:after:ring-inset"
      params={{ attemptId: a.id }}
      to="/quizzes/attempts/$attemptId"
    >
      {a.quizName}
    </Link>
  );
}

const scoreText = (a: Attempt) =>
  `${formatPoints(a.correct)} / ${formatPoints(a.total)}`;
const formatDate = (a: Attempt) => new Date(a.takenAt).toLocaleDateString();
