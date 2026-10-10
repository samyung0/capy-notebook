import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo } from 'react';
import { usePastReviews, useReviewOverview } from '@/api/hooks';
import type { PastReview, PastReviewSort, SessionScore } from '@/api/types';
import {
  ListToolbar,
  type SortOption,
  toggleValue,
} from '@/components/app/ListToolbar';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Button } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/feedback';
import { Menu } from '@/components/ui/Menu';
import { BillingTable } from '@/features/billing/BillingTable';
import { formatPoints } from '@/features/quizzes/grade';
import { getLocale, m } from '@/i18n';
import { iconUrl } from '@/lib/icon-catalog';
import { csv, sortSearch } from '@/lib/listSearch';
import { useLoadingReveal } from '@/lib/useLoadingReveal';
import {
  PAST_REVIEW_SORT_DEFAULT,
  type PastReviewsSearch,
  pastReviewParams,
} from './reviewSearch';
import { groupName } from './reviewText';

/** Learning → Past reviews: finished review sessions in the Files table
 * style, with the list pages' sort menu and filter. */
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
    isFetchingNextPage,
    isLoading,
  } = usePastReviews(params);
  const { data: overview } = useReviewOverview({ errorBoundary: false });
  const revealRef = useLoadingReveal(isLoading);
  const rows = data?.pages.flatMap((page) => page.items) ?? [];
  const sorts: SortOption<PastReviewSort>[] = [
    { icon: 'clock', label: m.past_sort_newest(), value: 'date' },
    { icon: 'quiz', label: m.past_sort_quiz(), value: 'quiz' },
    { icon: 'flashcards', label: m.past_sort_cards(), value: 'cards' },
    { icon: 'schedule', label: m.past_sort_time(), value: 'time' },
  ];
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
    <div className="flex flex-col">
      {/* Lifted so the toolbar's labels start at the table's edge; nudged
       * left over the plain table, whose text has no inset. */}
      <div className="-mx-4 -translate-x-0.5 sm:-mx-6 xl:translate-x-0">
        <ListToolbar
          ascending={params.dir === 'asc'}
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
          onSortChange={(next, asc) =>
            setSearch(sortSearch(next, asc, PAST_REVIEW_SORT_DEFAULT))
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
          <p className="py-8 text-center text-fg-muted">{m.past_empty()}</p>
        ) : (
          <div className="flex flex-col gap-3" ref={revealRef}>
            {/* Phones and tablets: Billing's plain table, scrolling sideways,
             * without Time and Status. */}
            <div className="xl:hidden">
              <BillingTable
                columns={[
                  { id: 'date', label: m.quiz_col_date() },
                  { id: 'workspace', label: m.quiz_col_workspace() },
                  { id: 'chapter', label: m.past_col_chapter() },
                  { id: 'quiz', label: m.past_col_quiz() },
                  { id: 'cards', label: m.past_col_cards() },
                  { align: 'right', id: 'menu', label: '' },
                ]}
                rows={rows.map((r) => ({
                  cells: {
                    cards: <ScoreText score={r.cards} />,
                    chapter: groupName(r.group, r.chapterName),
                    date: formatDate(r.startedAt),
                    menu: <AgainMenu onAgain={() => again(r)} />,
                    quiz: <ScoreText score={r.quiz} />,
                    workspace: <WorkspaceCell review={r} />,
                  },
                  key: r.id,
                }))}
              />
            </div>
            <div className="hidden overflow-hidden rounded-card border border-line xl:block">
              <div className="grid grid-cols-[7rem_minmax(0,1fr)_minmax(0,1.1fr)_6rem_6rem_5rem_8.5rem_40px] bg-surface-hover-bg py-2.5 pr-2 pl-4 font-bold text-fg-muted text-xs uppercase tracking-wide *:pr-4">
                <div>{m.quiz_col_date()}</div>
                <div>{m.quiz_col_workspace()}</div>
                <div>{m.past_col_chapter()}</div>
                <div>{m.past_col_quiz()}</div>
                <div>{m.past_col_cards()}</div>
                <div>{m.past_col_time()}</div>
                <div>{m.past_col_status()}</div>
                <div />
              </div>
              {rows.map((r) => (
                <Row key={r.id} onAgain={() => again(r)} review={r} />
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
    <div className="grid grid-cols-[7rem_minmax(0,1fr)_minmax(0,1.1fr)_6rem_6rem_5rem_8.5rem_40px] items-center border-divider border-t pr-2 pl-4 text-sm">
      <p className="whitespace-nowrap py-3 pr-4">{formatDate(r.startedAt)}</p>
      <div className="py-3 pr-4">
        <WorkspaceCell review={r} />
      </div>
      <p className="truncate py-3 pr-4">{groupName(r.group, r.chapterName)}</p>
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

function WorkspaceCell({ review: r }: { review: PastReview }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <img
        alt=""
        className="size-4 shrink-0 rounded-[4px]"
        height={16}
        src={iconUrl(r.iconId)}
        width={16}
      />
      <span className="truncate">{r.workspaceName}</span>
    </div>
  );
}

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
