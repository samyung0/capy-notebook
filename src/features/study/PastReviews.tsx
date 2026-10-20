import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo } from 'react';
import { usePastReviews, useReviewOverview } from '@/api/hooks';
import type { PastReview, PastReviewSort, SessionScore } from '@/api/types';
import { ListEnd } from '@/components/app/ListEnd';
import { FilterPopover, toggleValue } from '@/components/app/ListToolbar';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import type { ColumnSort } from '@/components/app/SortHeader';
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

/** Learning → Review's last section: finished review sessions in the Files
 * table style, with the list pages' filter beside the heading; every column
 * header sorts. */
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
    <section>
      <div className="mb-3 flex items-center justify-between gap-4">
        <h3 className="font-bold text-fg-muted text-sm">
          {m.learning_tab_past()}
        </h3>
        <FilterPopover
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
      </div>
      {waitsForConnection(fetchStatus, data) ? (
        <QueryPausedState />
      ) : isLoading ? (
        <SkeletonList count={6} rowHeight={52} />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-fg-muted">{m.past_empty()}</p>
      ) : (
        <div className="flex flex-col gap-3" ref={revealRef}>
          {/* Billing's plain table, scrolling sideways; Time and Status
           * from xl. */}
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
              {
                className: 'max-xl:hidden',
                id: 'time',
                label: m.past_col_time(),
                sort: 'time',
              },
              {
                className: 'max-xl:hidden',
                id: 'status',
                label: m.past_col_status(),
                sort: 'status',
              },
              { align: 'right', id: 'menu', label: '' },
            ]}
            rows={rows.map((r) => ({
              cells: {
                cards: <ScoreText score={r.cards} />,
                chapter: groupName(r.group, r.chapterName),
                date: (
                  <Link
                    className="after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-action focus-visible:after:ring-inset"
                    params={{ sessionId: r.id }}
                    to="/learning/reviews/$sessionId"
                  >
                    {formatDate(r.startedAt)}
                  </Link>
                ),
                menu: (
                  <RowMenu
                    onAgain={() => again(r)}
                    onResult={() =>
                      navigate({
                        params: { sessionId: r.id },
                        to: '/learning/reviews/$sessionId',
                      })
                    }
                  />
                ),
                quiz: <ScoreText score={r.quiz} />,
                status: <Status review={r} />,
                time: m.past_minutes({ count: minutes(r) }),
                workspace: (
                  <WorkspaceCell iconId={r.iconId} name={r.workspaceName} />
                ),
              },
              className: 'relative hover:bg-surface-hover-bg',
              key: r.id,
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
    </section>
  );
}

const minutes = (r: PastReview) =>
  Math.max(
    1,
    Math.round(
      (new Date(r.lastAnswerAt).getTime() - new Date(r.startedAt).getTime()) /
        60_000
    )
  );

/** Completed, or Incomplete with "Stopped after N of M" under it. */
function Status({ review: r }: { review: PastReview }) {
  if (r.answered >= r.total) return m.past_status_completed();
  return (
    <>
      <p>{m.past_status_incomplete()}</p>
      <p className="text-fg-muted text-xs">
        {m.past_stopped({ answered: r.answered, total: r.total })}
      </p>
    </>
  );
}

const formatDate = (iso: string) =>
  new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium' }).format(
    new Date(iso)
  );

function RowMenu({
  onAgain,
  onResult,
}: {
  onAgain: () => void;
  onResult: () => void;
}) {
  return (
    <div className="relative z-10 -my-2 flex justify-end">
      <Menu
        items={[
          { icon: 'list', label: m.quiz_check_result(), onClick: onResult },
          { icon: 'refresh', label: m.review_again(), onClick: onAgain },
        ]}
      />
    </div>
  );
}

/** A quiz or flashcard result: marks, or cards rated Good or Easy. */
function ScoreText({ score }: { score?: SessionScore }) {
  if (!score) return <span className="text-fg-muted">-</span>;
  return `${formatPoints(score.correct)} / ${formatPoints(score.total)}`;
}
