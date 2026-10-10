import { useNavigate, useSearch } from '@tanstack/react-router';
import type { CSSProperties } from 'react';
import { useAttempts, useLearningProgress } from '@/api/hooks';
import type { Attempt, ProgressMap, ProgressWorkspace } from '@/api/types';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Skeleton, SkeletonList } from '@/components/ui/feedback';
import { Menu } from '@/components/ui/Menu';
import { Tabs } from '@/components/ui/Tabs';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { BillingTable } from '@/features/billing/BillingTable';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { MiniTrail } from '@/features/questions/trailMap/TrailMap';
import { formatPoints } from '@/features/quizzes/grade';
import { PastReviews } from '@/features/study/PastReviews';
import { ReviewTab } from '@/features/study/ReviewTab';
import { RailMap } from '@/features/study/railMap/RailMap';
import { inReadingOrder } from '@/features/workspace/workspaceContent';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { coverInk } from '@/lib/coverInk';
import { iconUrl } from '@/lib/icon-catalog';
import type { LearningTab } from '@/lib/tabSearch';
import { useLoadingReveal } from '@/lib/useLoadingReveal';

function PastAttempts() {
  const { data, fetchStatus, isLoading } = useAttempts();
  const revealRef = useLoadingReveal(isLoading);
  const navigate = useNavigate();
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
  if (fetchStatus === 'paused') return <QueryPausedState />;
  if (isLoading) return <SkeletonList count={6} rowHeight={52} />;
  if (!data?.length)
    return (
      <p className="py-8 text-center text-fg-muted">{m.quiz_no_attempts()}</p>
    );

  const score = (a: Attempt) =>
    `${formatPoints(a.correct)} / ${formatPoints(a.total)}`;
  const date = (a: Attempt) => new Date(a.takenAt).toLocaleDateString();
  const menu = (a: Attempt) => (
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
  );

  return (
    <div ref={revealRef}>
      {/* Phones: Billing's plain table, scrolling sideways. */}
      <div className="md:hidden">
        <BillingTable
          columns={[
            { id: 'quiz', label: m.quiz_col_quiz() },
            { id: 'workspace', label: m.quiz_col_workspace() },
            { id: 'score', label: m.quiz_col_score() },
            { id: 'date', label: m.quiz_col_date(), muted: true },
            { align: 'right', id: 'menu', label: '' },
          ]}
          rows={data.map((a) => ({
            cells: {
              date: date(a),
              menu: <div className="-my-2 flex justify-end">{menu(a)}</div>,
              quiz: a.quizName,
              score: score(a),
              workspace: a.workspaceName,
            },
            key: a.id,
          }))}
        />
      </div>
      <div className="hidden overflow-hidden rounded-card border border-line md:block">
        <div className="grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_7rem_7rem_2.25rem] items-center gap-3 bg-surface-hover-bg px-4 py-3 font-bold text-fg-muted text-xs uppercase tracking-wide">
          <div>{m.quiz_col_quiz()}</div>
          <div>{m.quiz_col_workspace()}</div>
          <div>{m.quiz_col_score()}</div>
          <div>{m.quiz_col_date()}</div>
          <div />
        </div>
        {data.map((a: Attempt) => (
          <div
            className="grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_7rem_7rem_2.25rem] items-center gap-3 border-divider border-t py-2 pr-2 pl-4"
            key={a.id}
          >
            <div className="truncate font-semibold text-fg">{a.quizName}</div>
            <div className="truncate text-fg-secondary text-sm">
              {a.workspaceName}
            </div>
            <div>{score(a)}</div>
            <div className="text-fg-muted text-sm">{date(a)}</div>
            {menu(a)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Learning → Progress: the most recently studied workspace as a map with
 * its Continue, the other workspaces in progress as rows with a small trail,
 * then the finished ones. */
function Progress() {
  const { data, fetchStatus, isLoading } = useLearningProgress();
  const revealRef = useLoadingReveal(isLoading);
  const navigate = useNavigate();
  if (fetchStatus === 'paused') return <QueryPausedState />;
  if (isLoading) return <ProgressSkeleton />;
  if (!data?.active.length && !data?.finished.length)
    return (
      <p className="py-8 text-center text-fg-muted">
        {m.learning_no_progress()}
      </p>
    );
  const openWorkspace = (workspaceId: string) =>
    navigate({ params: { workspaceId }, to: '/workspaces/$workspaceId' });
  const [lead, ...others] = data.active;
  return (
    <div ref={revealRef}>
      {lead && data.lead && <LeadWorkspace map={data.lead} workspace={lead} />}
      {others.length > 0 && (
        <section className={cn(lead && 'mt-8')}>
          <h3 className="mb-1 font-bold text-fg-muted text-sm">
            {m.learning_other_workspaces()}
          </h3>
          {others.map((ws) => (
            <div
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 border-divider border-t py-3 sm:grid-cols-[minmax(0,1fr)_minmax(150px,240px)_4.5rem_auto]"
              key={ws.workspaceId}
            >
              <WorkspaceName
                meta={m.learning_studied({
                  when: relativeTime(ws.lastStudiedAt),
                })}
                workspace={ws}
              />
              <div
                className={cn(
                  'col-span-2 row-start-2 max-w-[282px] pl-[42px] sm:col-span-1 sm:row-start-auto sm:pl-0',
                  'rail-trail',
                  ws.cover && 'rail-colour'
                )}
                style={{ '--cover-ink': coverInk(ws.cover) } as CSSProperties}
              >
                <MiniTrail
                  answered={ws.done}
                  topicId={ws.workspaceId}
                  total={ws.total}
                />
              </div>
              <div className="hidden text-right text-fg-secondary text-sm sm:block">
                {m.study_of({ done: ws.done, total: ws.total })}
              </div>
              <UnderlineLink
                className="col-start-2 row-start-1 sm:col-start-auto sm:row-start-auto"
                iconRight={undefined}
                onClick={() => openWorkspace(ws.workspaceId)}
              >
                {m.study_continue()}
              </UnderlineLink>
            </div>
          ))}
        </section>
      )}
      {data.finished.length > 0 && (
        <section className={cn(data.active.length > 0 && 'mt-8')}>
          <h3 className="mb-1 font-bold text-fg-muted text-sm">
            {m.learning_finished()}
          </h3>
          {data.finished.map((ws) => (
            <div
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-divider border-t py-3 sm:grid-cols-[minmax(0,1fr)_4.5rem_auto]"
              key={ws.workspaceId}
            >
              <WorkspaceName
                meta={m.learning_finished_when({
                  when: relativeTime(ws.lastStudiedAt),
                })}
                workspace={ws}
              />
              <div className="hidden text-right text-fg-secondary text-sm sm:block">
                {m.study_of({ done: ws.done, total: ws.total })}
              </div>
              <UnderlineLink onClick={() => openWorkspace(ws.workspaceId)}>
                {m.learning_open()}
              </UnderlineLink>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

/** Progress's shape while it loads: the heading, the map, the name and the
 * other workspaces, so the page does not jump when it arrives. */
function ProgressSkeleton() {
  return (
    <div aria-label={m.a11y_loading()} role="status">
      <div className="flex items-center justify-between gap-6">
        <Skeleton className="h-6 w-36" />
        <Skeleton className="h-5 w-44" />
      </div>
      {/* The map's drawn height: (MAP_HEIGHT - TOP) * SCALE. */}
      <Skeleton className="mt-1 h-[208px] w-full rounded-card-lg" />
      <Skeleton className="mt-6 h-6 w-48" />
      <Skeleton className="mt-2 h-4 w-28" />
      <Skeleton className="mt-10 mb-2 h-4 w-32" />
      <SkeletonList count={3} rowHeight={52} />
    </div>
  );
}

function LeadWorkspace({
  workspace,
  map,
}: {
  workspace: ProgressWorkspace;
  map: ProgressMap;
}) {
  const navigate = useNavigate();
  const chapters = [...map.chapters].sort((a, b) => a.order - b.order);
  const items = inReadingOrder(chapters, map.items);
  const chapterIndex = new Map(chapters.map((ch, i) => [ch.id, i]));
  const next = items.find((it) => it.state !== 'done') ?? items[0];
  const open = (id: string) => {
    const item = items.find((it) => it.id === id);
    if (!item) return;
    navigate({
      params: { workspaceId: workspace.workspaceId },
      search: item.type === 'file' ? { file: id } : { material: id },
      to: '/workspaces/$workspaceId',
    });
  };
  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 className="t-large-card-title">{m.learning_continue_review()}</h2>
        <UnderlineLink accent onClick={() => open(next.id)}>
          {m.learning_continue_item({ title: next.title })}
        </UnderlineLink>
      </div>
      <RailMap
        chapters={chapters.map((ch) => ch.name)}
        color={coverInk(workspace.cover)}
        items={items.map((it) => ({
          chapter: it.chapterId
            ? (chapterIndex.get(it.chapterId) ?? null)
            : null,
          id: it.id,
          state: it.state,
          title: it.title,
        }))}
        onOpen={open}
        workspaceId={workspace.workspaceId}
      />
      <div className="mt-6 flex min-w-0 items-center gap-2.5">
        <img
          alt=""
          className="size-8 shrink-0 rounded-button"
          src={iconUrl(workspace.iconId)}
        />
        <h3 className="t-card-title truncate">{workspace.name}</h3>
      </div>
      <p className="mt-2.5 text-fg-muted text-sm">
        {m.learning_done_of({ done: workspace.done, total: workspace.total })}
      </p>
    </section>
  );
}

function WorkspaceName({
  workspace,
  meta,
}: {
  workspace: ProgressWorkspace;
  meta: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 lg:gap-3.5">
      <img
        alt=""
        className="size-8 shrink-0 rounded-button"
        src={iconUrl(workspace.iconId)}
      />
      <div className="min-w-0">
        <div className="truncate font-semibold text-fg">{workspace.name}</div>
        <div className="truncate text-fg-muted text-xs">{meta}</div>
      </div>
    </div>
  );
}

export default function Learning() {
  const { tab = 'progress' } = useSearch({ strict: false }) as {
    tab?: LearningTab;
  };
  const navigate = useNavigate();
  return (
    <PanelWithInvertedRadius header={<PageHeader title={m.nav_learning()} />}>
      <Tabs
        className="px-1 sm:px-6"
        onChange={(next) =>
          navigate({
            replace: true,
            search: { tab: next as LearningTab },
            to: '/learning',
          })
        }
        tabs={[
          { label: m.learning_tab_progress(), value: 'progress' },
          { label: m.learning_tab_review(), value: 'review' },
          { label: m.learning_tab_past(), value: 'past' },
          { label: m.learning_tab_results(), value: 'results' },
        ]}
        value={tab}
      />
      {/* Settings' tab padding, without its width cap: the map runs to the panel's edges. */}
      <div className="flex flex-1 flex-col gap-4 px-4 pt-5 pb-8 sm:px-6 sm:pt-8 lg:px-10 xl:px-16">
        {tab === 'progress' ? (
          <Progress />
        ) : tab === 'review' ? (
          <ReviewTab />
        ) : tab === 'past' ? (
          <PastReviews />
        ) : (
          <PastAttempts />
        )}
      </div>
    </PanelWithInvertedRadius>
  );
}
