import { useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useReviewOverview } from '@/api/hooks';
import type { ReviewSuggestion } from '@/api/types';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { iconUrl } from '@/lib/icon-catalog';
import { useLoadingReveal } from '@/lib/useLoadingReveal';
import type { ReviewSearch } from './reviewSearch';
import { groupName, itemCount, REVIEW_MODE, reviewReason } from './reviewText';

/** Learning → Review: suggested reviews with their reason, sessions left
 * before the end, then every workspace for a review of your own. */
export function ReviewTab() {
  const { data, fetchStatus, isLoading } = useReviewOverview();
  const revealRef = useLoadingReveal(isLoading);
  const navigate = useNavigate();
  if (fetchStatus === 'paused' && !data) return <QueryPausedState />;
  if (isLoading) return <SkeletonList count={5} rowHeight={72} />;
  if (!data?.workspaces.length && !data?.unfinished.length)
    return (
      <p className="py-8 text-center text-fg-muted">
        {m.review_no_workspaces()}
      </p>
    );
  const review = (workspaceId: string, search: ReviewSearch) =>
    navigate({
      params: { workspaceId },
      search: { ...search, from: 'review' },
      to: '/learning/review/$workspaceId',
    });
  return (
    <div className="flex flex-col gap-9" ref={revealRef}>
      {data.suggestions.length > 0 && (
        <section>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
            <h2 className="t-card-title">{m.review_worth()}</h2>
            <UnderlineLink
              onClick={() =>
                navigate({ search: { tab: 'study' }, to: '/settings' })
              }
            >
              {m.review_preferences()}
            </UnderlineLink>
          </div>
          {data.suggestions.map((s) => (
            <SuggestionRow
              key={`${s.workspaceId}/${s.group}/${s.chapterId ?? ''}`}
              onStart={() =>
                review(s.workspaceId, {
                  chapterId: s.chapterId,
                  group: s.group,
                  reviewMode: s.mode,
                })
              }
              suggestion={s}
            />
          ))}
        </section>
      )}
      {data.unfinished.length > 0 && (
        <section>
          <h3 className="mb-1 font-bold text-fg-muted text-sm">
            {m.learning_continue_review()}
          </h3>
          {data.unfinished.map((u) => {
            const group = groupName(u.group, u.chapterName);
            return (
              <Row
                action={
                  <UnderlineLink
                    onClick={() => review(u.workspaceId, { session: u.id })}
                  >
                    {m.study_continue()}
                  </UnderlineLink>
                }
                iconId={u.iconId}
                key={u.id}
                meta={m.review_unfinished_meta({
                  answered: u.answered,
                  total: u.total,
                  when: relativeTime(u.lastAnswerAt),
                })}
                title={group || u.workspaceName}
                titleSub={group ? u.workspaceName : undefined}
              />
            );
          })}
        </section>
      )}
      {data.workspaces.length > 0 && (
        <section>
          <h3 className="mb-1 font-bold text-fg-muted text-sm">
            {m.review_all_workspaces()}
          </h3>
          {data.workspaces.map((ws) => (
            <Row
              action={
                <UnderlineLink
                  disabled={!ws.reviewable}
                  onClick={() => review(ws.workspaceId, { group: 'workspace' })}
                >
                  {ws.lastReviewedAt
                    ? m.review_again()
                    : m.study_review_button()}
                </UnderlineLink>
              }
              count={itemCount(ws.reviewable)}
              iconId={ws.iconId}
              key={ws.workspaceId}
              meta={
                ws.lastReviewedAt
                  ? m.review_reviewed_when({
                      when: relativeTime(ws.lastReviewedAt),
                    })
                  : ws.reviewable
                    ? m.review_not_reviewed()
                    : m.review_nothing_practised()
              }
              title={ws.name}
            />
          ))}
        </section>
      )}
    </div>
  );
}

function SuggestionRow({
  suggestion: s,
  onStart,
}: {
  suggestion: ReviewSuggestion;
  onStart: () => void;
}) {
  const mode = REVIEW_MODE[s.mode];
  return (
    <Row
      action={
        <UnderlineLink accent onClick={onStart}>
          {m.review_start()}
        </UnderlineLink>
      }
      iconId={s.iconId}
      title={groupName(s.group, s.chapterName) || s.workspaceName}
      titleSub={
        s.group === 'workspace' ? m.review_whole_workspace() : s.workspaceName
      }
    >
      <p className="text-fg-secondary text-sm">{reviewReason(s)}</p>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
        <span
          className={cn(
            'inline-flex items-center gap-1 font-bold',
            mode.className
          )}
        >
          <Icon className="size-3.5 -translate-y-px" name={mode.icon} />
          {mode.label()}
        </span>
        <span className="text-fg-muted">{itemCount(s.items)}</span>
      </p>
    </Row>
  );
}

/** One row of the Review tab: the workspace icon, a title with its context,
 * an optional count (hidden on phones) and the row's action. */
function Row({
  iconId,
  title,
  titleSub,
  meta,
  count,
  action,
  children,
}: {
  iconId: string;
  title: string;
  titleSub?: string;
  meta?: string;
  count?: string;
  action: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3.5 gap-y-1 border-divider border-t py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]">
      <img
        alt=""
        className="size-8 rounded-button"
        height={32}
        src={iconUrl(iconId)}
        width={32}
      />
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="truncate font-semibold text-fg">{title}</span>
          {titleSub && (
            <span className="truncate text-fg-muted text-xs">{titleSub}</span>
          )}
        </div>
        {meta && <p className="truncate text-fg-muted text-xs">{meta}</p>}
        {children}
      </div>
      {count === undefined ? (
        <span className="hidden sm:block" />
      ) : (
        <span className="hidden self-center text-fg-secondary text-sm sm:block">
          {count}
        </span>
      )}
      <div className="self-center">{action}</div>
    </div>
  );
}
