import { useNavigate, useSearch } from '@tanstack/react-router';
import { useAttempts } from '@/api/hooks';
import type { Attempt } from '@/api/types';
import {
  ListToolbar,
  type SortOption,
  toggleValue,
} from '@/components/app/ListToolbar';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { SkeletonList } from '@/components/ui/feedback';
import { Menu } from '@/components/ui/Menu';
import { BillingTable } from '@/features/billing/BillingTable';
import { formatPoints } from '@/features/quizzes/grade';
import { m } from '@/i18n';
import { commaList, csv, sortSearch } from '@/lib/listSearch';
import { useLoadingReveal } from '@/lib/useLoadingReveal';
import {
  RESULT_SORT_DEFAULT,
  type ResultSort,
  type ResultsSearch,
} from './reviewSearch';

/** Learning → All results: quiz attempts with the list pages' sort menu and
 * workspace filter, applied here since the list arrives whole. */
export function AllResults() {
  const search = useSearch({ strict: false }) as ResultsSearch;
  const { sort = RESULT_SORT_DEFAULT, dir } = search;
  const workspaceIds = commaList(search.workspace);
  const { data, fetchStatus, isLoading } = useAttempts();
  const revealRef = useLoadingReveal(isLoading);
  const navigate = useNavigate();
  const setSearch = (patch: ResultsSearch) =>
    void navigate({
      replace: true,
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      to: '/learning',
    });
  const sorts: SortOption<ResultSort>[] = [
    { icon: 'clock', label: m.past_sort_newest(), value: 'date' },
    { icon: 'quiz', label: m.quiz_col_score(), value: 'score' },
  ];
  // The workspaces in the list, named as their newest attempt has them.
  const workspaces = new Map<string, string>();
  for (const a of data ?? [])
    if (a.workspaceId && !workspaces.has(a.workspaceId))
      workspaces.set(a.workspaceId, a.workspaceName);
  const rows = (data ?? [])
    .filter(
      (a) =>
        workspaceIds.length === 0 ||
        (a.workspaceId !== null && workspaceIds.includes(a.workspaceId))
    )
    .sort((x, y) => {
      const order =
        sort === 'score'
          ? ratio(y) - ratio(x)
          : Date.parse(y.takenAt) - Date.parse(x.takenAt);
      return dir === 'asc' ? -order : order;
    });

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
    <div className="-my-2 flex justify-end">
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
              options: [...workspaces].map(([value, label]) => ({
                label,
                value,
              })),
              selected: workspaceIds,
            },
          ]}
          onResetFilters={() => setSearch({ workspace: undefined })}
          onSortChange={(next, asc) =>
            setSearch(sortSearch(next, asc, RESULT_SORT_DEFAULT))
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
          <div ref={revealRef}>
            {/* Phones: Billing's plain table, scrolling sideways. */}
            <div className="md:hidden">
              <BillingTable
                columns={[
                  { id: 'quiz', label: m.quiz_col_quiz() },
                  { id: 'workspace', label: m.quiz_col_workspace() },
                  { id: 'score', label: m.quiz_col_score() },
                  { id: 'date', label: m.quiz_col_date() },
                  { align: 'right', id: 'menu', label: '' },
                ]}
                rows={rows.map((a) => ({
                  cells: {
                    date: formatDate(a),
                    menu: menu(a),
                    quiz: a.quizName,
                    score: scoreText(a),
                    workspace: a.workspaceName,
                  },
                  key: a.id,
                }))}
              />
            </div>
            <div className="hidden overflow-hidden rounded-card border border-line md:block">
              <div className="grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_7rem_7rem_2.25rem] items-center bg-surface-hover-bg py-3 pr-2 pl-4 font-bold text-fg-muted text-xs uppercase tracking-wide *:pr-4">
                <div>{m.quiz_col_quiz()}</div>
                <div>{m.quiz_col_workspace()}</div>
                <div>{m.quiz_col_score()}</div>
                <div>{m.quiz_col_date()}</div>
                <div />
              </div>
              {rows.map((a) => (
                <div
                  className="grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_7rem_7rem_2.25rem] items-center border-divider border-t pr-2 pl-4 text-sm"
                  key={a.id}
                >
                  <div className="truncate py-3 pr-4">{a.quizName}</div>
                  <div className="truncate py-3 pr-4">{a.workspaceName}</div>
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
          </div>
        )}
      </div>
    </div>
  );
}

const ratio = (a: Attempt) => (a.total ? a.correct / a.total : 0);
const scoreText = (a: Attempt) =>
  `${formatPoints(a.correct)} / ${formatPoints(a.total)}`;
const formatDate = (a: Attempt) => new Date(a.takenAt).toLocaleDateString();
