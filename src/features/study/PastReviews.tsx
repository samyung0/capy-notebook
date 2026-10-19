import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo } from 'react';
import { usePastReviews, useReviewOverview } from '@/api/hooks';
import type { PastReview, PastReviewSort, SessionScore } from '@/api/types';
import { ListEnd } from '@/components/app/ListEnd';
import { ListToolbar, toggleValue } from '@/components/app/ListToolbar';
import { PageBody } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import {
  ariaSort,
  type ColumnSort,
  SortHeader,
  sortDirection,
} from '@/components/app/SortHeader';
import { WorkspaceCell } from '@/components/app/WorkspaceCell';
import { SkeletonList } from '@/components/ui/feedback';
import { Menu } from '@/components/ui/Menu';
import { BillingTable } from '@/features/billing/BillingTable';
import { formatPoints } from '@/features/quizzes/grade';
import { getLocale, m } from '@/i18n';
import { csv, sortSearch } from '@/lib/listSearch';
import { waitsForConnection } from '@/lib/online';
import { useLoadingReveal } from '@/lib/useLoadingReveal';
import {
  PAST_REVIEW_SORT_DEFAULT,
  type PastReviewsSearch,
  pastReviewParams,
} from './reviewSearch';
import { groupName } from './reviewText';

/** Learning → Past reviews: finished review sessions in the Files table
 * style, with the list pages' filter; every column header sorts. */
export function PastReviews() {
  const search = useSearch({ strict: false }) as PastReviewsSearch;
  const navigate = useNavigate();
  const setSearch = (patch: PastReviewsSearch) =>
    void navigate({
      replace: true,
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      to: '/learning',
    });
  const params = useMemo(() => pastReviewParams(search), [search]);
  const {
    sort = PAST_REVIEW_SORT_DEFAULT,
    has = [],
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
  } = usePastReviews(params);
  const { data: overview } = useReviewOverview({ errorBoundary: false });
  const revealRef = useLoadingReveal(isLoading);
  const rows = data?.pages.flatMap((page) => page.items) ?? [];
  const sorting: ColumnSort<PastReviewSort> = {
    ascending: params.dir === 'asc',
    ascendingFirst: ['workspace', 'chapter', 'status'],
    onSortChange: (next, asc) =>
      setSearch(sortSearch('pastReviews', next, asc, PAST_REVIEW_SORT_DEFAULT)),
    sort,
  };
  const again = (r: PastReview) =>
    navigate({
      params: { workspaceId: r.workspaceId },
      search: {
        chapterId: r.chapterId,
        from: 'review',
        group: r.group,
        reviewMode: r.mode,
      },
      to: '/learning/review/$workspaceId',
    });

  return (
    <>
      <ListToolbar
        filters={[
          {
            emptyLabel: m.create_filter_no_workspaces(),
            key: 'workspace',
            label: m.files_filter_workspace(),
            onToggle: (value) =>
              setSearch({ workspace: csv(toggleValue(workspaceIds, value)) }),
            options: (overview?.workspaces ?? []).map((ws) => ({
              label: ws.name,
              value: ws.workspaceId,
            })),
            selected: workspaceIds,
          },
          {
            key: 'has',
            label: m.past_filter_has(),
            onToggle: (value) =>
              setSearch({ has: csv(toggleValue(has, value)) }),
            options: [
              { label: m.past_has_quiz(), value: 'quiz' },
              { label: m.past_has_cards(), value: 'flashcards' },
            ],
            selected: has,
          },
        ]}
        onResetFilters={() =>
          setSearch({ has: undefined, workspace: undefined })
        }
      />
      <PageBody belowToolbar>
        {waitsForConnection(fetchStatus, data) ? (
          <QueryPausedState />
        ) : isLoading ? (
          <SkeletonList count={6} rowHeight={52} />
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-fg-muted">{m.past_empty()}</p>
        ) : (
          <div className="flex flex-col gap-3" ref={revealRef}>
            {/* Phones and tablets: Billing's plain table, scrolling sideways,
             * without Time and Status. */}
            <div className="xl:hidden">
              <BillingTable
                columns={[
                  { id: 'date', label: m.quiz_col_date(), sort: 'date' },
                  {
                    clamp: true,
                    id: 'workspace',
                    label: m.quiz_col_workspace(),
                    sort: 'workspace',
                  },
                  {
                    clamp: true,
                    id: 'chapter',
                    label: m.past_col_chapter(),
                    sort: 'chapter',
                  },
                  { id: 'quiz', label: m.past_col_quiz(), sort: 'quiz' },
                  { id: 'cards', label: m.past_col_cards(), sort: 'cards' },
                  { align: 'right', id: 'menu', label: '' },
                ]}
                rows={rows.map((r) => ({
                  cells: {
                    cards: <ScoreText score={r.cards} />,
                    chapter: groupName(r.group, r.chapterName),
                    date: formatDate(r.startedAt),
                    menu: <AgainMenu onAgain={() => again(r)} />,
                    quiz: <ScoreText score={r.quiz} />,
                    workspace: (
                      <WorkspaceCell iconId={r.iconId} name={r.workspaceName} />
                    ),
                  },
                  key: r.id,
                }))}
                sorting={sorting}
              />
            </div>
            <div className="hidden overflow-hidden rounded-card border border-line xl:block">
              <div className="grid grid-cols-[minmax(7rem,1fr)_minmax(10rem,1.6fr)_minmax(10rem,1.6fr)_minmax(5rem,1fr)_minmax(5rem,1fr)_minmax(5rem,1fr)_minmax(8.5rem,1fr)_40px] items-center bg-surface-hover-bg py-2.5 pr-2 pl-4 font-bold text-fg-muted text-xs uppercase tracking-wide *:pr-4">
                {(
                  [
                    ['date', m.quiz_col_date()],
                    ['workspace', m.quiz_col_workspace()],
                    ['chapter', m.past_col_chapter()],
                    ['quiz', m.past_col_quiz()],
                    ['cards', m.past_col_cards()],
                    ['time', m.past_col_time()],
                    ['status', m.past_col_status()],
                  ] as const
                ).map(([value, label]) => (
                  <div
                    aria-sort={ariaSort(sortDirection(sorting, value))}
                    className="min-w-0"
                    key={value}
                    role="columnheader"
                  >
                    <SortHeader label={label} sorting={sorting} value={value} />
                  </div>
                ))}
                <div />
              </div>
              {rows.map((r) => (
                <Row key={r.id} onAgain={() => again(r)} review={r} />
              ))}
            </div>
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

function Row({
  review: r,
  onAgain,
}: {
  review: PastReview;
  onAgain: () => void;
}) {
  const minutes = Math.max(
    1,
    Math.round(
      (new Date(r.lastAnswerAt).getTime() - new Date(r.startedAt).getTime()) /
        60_000
    )
  );
  const stopped =
    r.answered < r.total &&
    m.past_stopped({ answered: r.answered, total: r.total });
  return (
    <div className="grid grid-cols-[minmax(7rem,1fr)_minmax(10rem,1.6fr)_minmax(10rem,1.6fr)_minmax(5rem,1fr)_minmax(5rem,1fr)_minmax(5rem,1fr)_minmax(8.5rem,1fr)_40px] items-center border-divider border-t pr-2 pl-4 text-sm">
      <p className="whitespace-nowrap py-3 pr-4">{formatDate(r.startedAt)}</p>
      <div className="py-3 pr-4">
        <WorkspaceCell iconId={r.iconId} name={r.workspaceName} />
      </div>
      <p className="wrap-break-word line-clamp-2 py-3 pr-4">
        {groupName(r.group, r.chapterName)}
      </p>
      <p className="whitespace-nowrap py-3 pr-4">
        <ScoreText score={r.quiz} />
      </p>
      <p className="whitespace-nowrap py-3 pr-4">
        <ScoreText score={r.cards} />
      </p>
      <p className="whitespace-nowrap py-3 pr-4">
        {m.past_minutes({ count: minutes })}
      </p>
      <div className="min-w-0 whitespace-nowrap py-3 pr-4">
        <p>
          {stopped ? m.past_status_incomplete() : m.past_status_completed()}
        </p>
        {stopped && <p className="truncate text-fg-muted text-xs">{stopped}</p>}
      </div>
      <AgainMenu onAgain={onAgain} />
    </div>
  );
}

const formatDate = (iso: string) =>
  new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium' }).format(
    new Date(iso)
  );

function AgainMenu({ onAgain }: { onAgain: () => void }) {
  return (
    <div className="relative z-10 -my-2 flex justify-end">
      <Menu
        items={[{ icon: 'refresh', label: m.review_again(), onClick: onAgain }]}
      />
    </div>
  );
}

/** A quiz or flashcard result: marks, or cards rated Good or Easy. */
function ScoreText({ score }: { score?: SessionScore }) {
  if (!score) return <span className="text-fg-muted">-</span>;
  return `${formatPoints(score.correct)} / ${formatPoints(score.total)}`;
}
