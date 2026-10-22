import { useNavigate, useSearch } from '@tanstack/react-router';
import { type CSSProperties, useState } from 'react';
import {
  useLearningPlans,
  useLearningProgress,
  useSetWorkspaceStudyEnabled,
} from '@/api/hooks';
import type { ProgressMap, ProgressWorkspace } from '@/api/types';
import { PageHeader, PagePanel } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { TabContent } from '@/components/app/tabPanel';
import { Button } from '@/components/ui/Button';
import { Skeleton, SkeletonList } from '@/components/ui/feedback';
import { Menu } from '@/components/ui/Menu';
import { Tabs } from '@/components/ui/Tabs';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { MiniTrail } from '@/features/questions/trailMap/TrailMap';
import { AllResults } from '@/features/study/AllResults';
import { PlanRow, usePlanLinks } from '@/features/study/plans/PlansSection';
import { workspaceMap } from '@/features/study/plans/planProgress';
import { RecordProgress } from '@/features/study/RecordProgress';
import { ReviewTab } from '@/features/study/ReviewTab';
import { PlaceholderRailMap } from '@/features/study/railMap/RailMap';
import { WorkspaceRailMap } from '@/features/study/WorkspaceRailMap';
import { inReadingOrder } from '@/features/workspace/workspaceContent';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { coverInk } from '@/lib/coverInk';
import { iconUrl } from '@/lib/icon-catalog';
import { waitsForConnection } from '@/lib/online';
import type { LearningTab } from '@/lib/tabSearch';
import { useLoadingReveal } from '@/lib/useLoadingReveal';

/** Learning → Progress: the most recently studied workspace as a map with
 * its Continue, the user's plans, the other workspaces in progress as rows
 * with a small trail, then the finished ones. The map leads with the finished
 * workspace a finish toast's Go check names (`finished`), and with the latest
 * finished when none is in progress. Show all brings back workspaces hiding
 * study progress, at half opacity. */
function Progress({ finished }: { finished?: string }) {
  const [all, setAll] = useState(false);
  const { data, fetchStatus, isLoading } = useLearningProgress(finished, all);
  const { data: plans } = useLearningPlans({ errorBoundary: false });
  const revealRef = useLoadingReveal(isLoading);
  const navigate = useNavigate();
  const links = usePlanLinks(undefined);
  if (waitsForConnection(fetchStatus, data)) return <QueryPausedState />;
  if (isLoading) return <ProgressSkeleton />;
  const showAll = (
    <Button
      className="ml-auto"
      onClick={() => setAll(!all)}
      rounded="large"
      size="sm"
      variant="outline"
    >
      {all ? m.learning_hide_hidden() : m.learning_show_all()}
    </Button>
  );
  const planList = plans && plans.plans.length > 0 && (
    <section className="mt-8">
      <h3 className="mb-1 font-bold text-fg-muted text-sm">
        {m.learning_your_plans()}
      </h3>
      {plans.plans.map((plan) => (
        <PlanRow
          key={plan.id}
          onContinue={(next) => links.openItem(next.item, next.workspaceId)}
          onOpen={() => links.openPlan(plan)}
          parent={workspaceMap(plans.workspaces).get(plan.workspaceId)}
          plan={plan}
          spaces={workspaceMap(plans.workspaces)}
        />
      ))}
    </section>
  );
  if (!data?.active.length && !data?.finished.length)
    return (
      <>
        <PlaceholderRailMap />
        <RecordProgress />
        {planList}
        <div className="mt-8 flex">{showAll}</div>
      </>
    );
  const openWorkspace = (workspaceId: string) =>
    navigate({ params: { workspaceId }, to: '/workspaces/$workspaceId' });
  const lead = [...data.active, ...data.finished].find(
    (ws) => ws.workspaceId === data.lead?.workspaceId
  );
  const others = data.active.filter((ws) => ws !== lead);
  const done = data.finished.filter((ws) => ws !== lead);
  return (
    <div ref={revealRef}>
      {lead && data.lead && (
        <LeadWorkspace
          key={lead.workspaceId}
          map={data.lead}
          workspace={lead}
        />
      )}
      {planList}
      <section className={cn((lead || planList) && 'mt-8')}>
        <div className="mb-1 flex items-center gap-3">
          <h3 className="font-bold text-fg-muted text-sm">
            {m.learning_other_workspaces()}
          </h3>
          {showAll}
        </div>
        {others.map((ws) => (
          <div
            className={cn(
              'grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 gap-y-1.5 border-divider border-t py-3 sm:grid-cols-[minmax(0,1fr)_minmax(150px,240px)_4.5rem_auto_auto]',
              ws.hidden && 'opacity-50'
            )}
            key={ws.workspaceId}
          >
            <WorkspaceName
              meta={
                ws.hidden
                  ? m.learning_hidden()
                  : m.learning_studied({
                      when: relativeTime(ws.lastStudiedAt),
                    })
              }
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
            <ShownMenu
              className="col-start-3 row-start-1 sm:col-start-auto sm:row-start-auto"
              workspace={ws}
            />
          </div>
        ))}
      </section>
      {done.length > 0 && (
        <section className={cn((lead || others.length > 0) && 'mt-8')}>
          <h3 className="mb-1 font-bold text-fg-muted text-sm">
            {m.learning_finished()}
          </h3>
          {done.map((ws) => (
            <div
              className={cn(
                'grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 border-divider border-t py-3 sm:grid-cols-[minmax(0,1fr)_4.5rem_auto_auto]',
                ws.hidden && 'opacity-50'
              )}
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
              <UnderlineLink
                noArrow
                onClick={() => openWorkspace(ws.workspaceId)}
              >
                {m.learning_open()}
              </UnderlineLink>
              <ShownMenu workspace={ws} />
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
  const next = items.find((it) => it.state !== 'done');
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
        <h2 className="t-large-card-title">
          {next ? m.learning_continue_study() : m.learning_workspace_finished()}
        </h2>
        {next && (
          <UnderlineLink accent onClick={() => open(next.id)}>
            {m.learning_continue_item({ title: next.title })}
          </UnderlineLink>
        )}
      </div>
      <WorkspaceRailMap
        chapters={chapters}
        cover={workspace.cover}
        items={items}
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

/** A workspace row's ⋮: its Hide study progress, the Study page's switch. A
 * hidden row (Show all) shows Show instead. */
function ShownMenu({
  workspace,
  className,
}: {
  workspace: ProgressWorkspace;
  className?: string;
}) {
  const { isPending, mutate: setShown } = useSetWorkspaceStudyEnabled(
    workspace.workspaceId
  );
  if (workspace.hidden)
    return (
      <Button
        className={className}
        disabled={isPending}
        onClick={() => setShown(true)}
        rounded="large"
        size="sm"
        variant="outline"
      >
        {m.study_show()}
      </Button>
    );
  return (
    <div className={className}>
      <Menu
        items={[
          {
            icon: 'viewOff',
            label: m.study_hide_progress(),
            onClick: () => setShown(false),
          },
        ]}
      />
    </div>
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
  const { tab = 'progress', finished } = useSearch({ strict: false }) as {
    tab?: LearningTab;
    finished?: string;
  };
  const navigate = useNavigate();
  return (
    <PagePanel header={<PageHeader title={m.nav_learning()} />}>
      <Tabs
        className="page-tabs-px"
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
          { label: m.learning_tab_results(), value: 'results' },
        ]}
        value={tab}
      />
      {/* All results lays out as Files does: toolbar right under the tabs,
       * then the table in the list's padding. */}
      {tab === 'results' ? (
        <AllResults />
      ) : (
        // Without the reading width: the map runs to the panel's edges.
        <TabContent fill>
          {tab === 'progress' ? (
            <Progress finished={finished} />
          ) : (
            <ReviewTab />
          )}
        </TabContent>
      )}
    </PagePanel>
  );
}
