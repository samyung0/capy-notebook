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
    <div className="flex flex-col gap-4">
      {/* Lifted so the toolbar's centred labels start where Settings' headings do. */}
      <div className="-mx-4 -mt-3 sm:-mx-6">
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
      {fetchStatus === 'paused' && !data ? (
        <QueryPausedState />
      ) : isLoading ? (
        <SkeletonList count={6} rowHeight={52} />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-fg-muted">{m.past_empty()}</p>
      ) : (
        <div className="flex flex-col gap-3" ref={revealRef}>
          <div className="overflow-hidden rounded-card border border-line">
            <div className="hidden bg-surface-hover-bg px-4 py-2.5 font-bold text-fg-muted text-xs uppercase tracking-wide md:grid md:grid-cols-[7rem_minmax(0,1.2fr)_minmax(0,1.1fr)_7rem_7rem_4rem_8.5rem_40px] md:gap-3">
              <div>{m.quiz_col_date()}</div>
              <div>{m.quiz_col_workspace()}</div>
              <div>{m.past_col_chapter()}</div>
              <div>{m.past_col_quiz()}</div>
              <div>{m.past_col_cards()}</div>
              <div className="text-right">{m.past_col_time()}</div>
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
  );
}

function Row({
  review: r,
  onAgain,
}: {
  review: PastReview;
  onAgain: () => void;
}) {
  const group = groupName(r.group, r.chapterName);
  const date = new Intl.DateTimeFormat(getLocale(), {
    dateStyle: 'medium',
  }).format(new Date(r.startedAt));
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
    <div className="grid grid-cols-[minmax(0,1fr)_auto_40px] items-center gap-x-3 gap-y-0.5 border-divider border-t py-2.5 pr-2 pl-4 md:grid-cols-[7rem_minmax(0,1.2fr)_minmax(0,1.1fr)_7rem_7rem_4rem_8.5rem_40px] md:gap-3">
      {/* Phones: what, where and when, then both scores at the right. */}
      <div className="min-w-0 md:hidden">
        <p className="truncate font-semibold text-fg">
          {group || r.workspaceName}
        </p>
        <p className="truncate text-fg-muted text-xs">
          {group ? `${r.workspaceName} · ${date}` : date}
        </p>
      </div>
      <div className="flex flex-col items-end text-fg-secondary text-sm md:hidden">
        {r.quiz && (
          <span>{m.past_phone_quiz({ score: scoreText(r.quiz) })}</span>
        )}
        {r.cards && (
          <span>{m.past_phone_cards({ score: scoreText(r.cards) })}</span>
        )}
      </div>
      <p className="t-meta hidden text-fg-secondary md:block">{date}</p>
      <div className="hidden min-w-0 items-center gap-2.5 md:flex">
        <img
          alt=""
          className="size-4 shrink-0 rounded-[4px]"
          height={16}
          src={iconUrl(r.iconId)}
          width={16}
        />
        <span className="truncate font-bold">{r.workspaceName}</span>
      </div>
      <p className="t-meta hidden truncate text-fg-secondary md:block">
        {group}
      </p>
      <ScoreCell score={r.quiz} />
      <ScoreCell score={r.cards} />
      <p className="t-meta hidden text-right text-fg-muted md:block">
        {m.past_minutes({ count: minutes })}
      </p>
      <div className="hidden min-w-0 md:block">
        <p className="t-meta text-fg-secondary">
          {stopped ? m.past_status_incomplete() : m.past_status_completed()}
        </p>
        {stopped && <p className="truncate text-fg-muted text-xs">{stopped}</p>}
      </div>
      <div className="relative z-10 -my-2 flex justify-self-end">
        <Menu
          items={[
            { icon: 'refresh', label: m.review_again(), onClick: onAgain },
          ]}
        />
      </div>
    </div>
  );
}

const scoreText = (s: SessionScore) =>
  `${formatPoints(s.correct)} / ${formatPoints(s.total)}`;

/** A quiz or flashcard result: marks, or cards rated Good or Easy. */
function ScoreCell({ score }: { score?: SessionScore }) {
  if (!score) return <p className="t-meta hidden text-fg-muted md:block">-</p>;
  return <p className="hidden font-bold md:block">{scoreText(score)}</p>;
}
