import { useNavigate, useSearch } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import {
  useDeleteStudyPlan,
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
import { Icon } from '@/components/ui/Icon';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { Tabs } from '@/components/ui/Tabs';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { AllResults } from '@/features/study/AllResults';
import { usePlanLinks } from '@/features/study/plans/planLinks';
import {
  planFinishedAt,
  planProgress,
  planStudiedAt,
  workspaceMap,
} from '@/features/study/plans/planProgress';
import { RecordProgress } from '@/features/study/RecordProgress';
import { ReviewTab } from '@/features/study/ReviewTab';
import { PlaceholderRailMap } from '@/features/study/railMap/RailMap';
import { WorkspaceRailMap } from '@/features/study/WorkspaceRailMap';
import { inReadingOrder } from '@/features/workspace/workspaceContent';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { iconUrl } from '@/lib/icon-catalog';
import { waitsForConnection } from '@/lib/online';
import type { LearningTab } from '@/lib/tabSearch';
import { useLoadingReveal } from '@/lib/useLoadingReveal';

/** Learning → Progress: the most recently studied workspace as a map with
 * its Continue, the user's plans, the other workspaces' Default Plans in
 * progress as rows, then the finished ones naming the plan; every row
 * opens what it names. The map leads with the finished workspace a finish
 * toast's Go check names (`finished`), and with the latest finished when none
 * is in progress. Each list's Show hidden (with its count) brings back what
 * hides study progress (a plan by its workspace), at half opacity. */
function Progress({ finished }: { finished?: string }) {
  const [all, setAll] = useState(false);
  const [allPlans, setAllPlans] = useState(false);
  const { data, fetchStatus, isLoading } = useLearningProgress(finished, all);
  const { data: plans } = useLearningPlans({ errorBoundary: false });
  const revealRef = useLoadingReveal(isLoading);
  const navigate = useNavigate();
  const links = usePlanLinks(undefined);
  const { mutate: deletePlan } = useDeleteStudyPlan();
  if (waitsForConnection(fetchStatus, data)) return <QueryPausedState />;
  if (isLoading) return <ProgressSkeleton />;
  // Show hidden (count), only while something hides; Hide hidden once on.
  const showHidden = (on: boolean, count: number, toggle: () => void) =>
    (on || count > 0) && (
      <Button
        className="ml-auto"
        onClick={toggle}
        rounded="large"
        size="sm"
        variant="ghost-hover"
      >
        {on ? m.learning_hide_hidden() : m.learning_show_hidden({ count })}
      </Button>
    );
  // Plans in progress list under Your plans, finished ones under Finished; a
  // plan whose workspace hides study progress waits for Your plans' Show
  // hidden, which counts both.
  const spaces = workspaceMap(plans?.plans.length ? plans.workspaces : []);
  const planRows = (plans?.plans ?? []).map((plan) => {
    const parent = spaces.get(plan.workspaceId);
    const progress = planProgress(plan, spaces);
    return {
      finishedAt: planFinishedAt(progress),
      hidden: !!parent?.hidden,
      parent,
      plan,
      progress,
    };
  });
  const hiddenPlans = planRows.filter((p) => p.hidden).length;
  const shownPlans = planRows.filter((p) => allPlans || !p.hidden);
  const ongoing = shownPlans.filter((p) => !p.finishedAt);
  const planList = (ongoing.length > 0 || hiddenPlans > 0) && (
    <section className="mt-8">
      <div className="mb-1 flex items-center gap-3">
        <h3 className="font-bold text-fg-muted text-sm">
          {m.learning_your_plans()}
        </h3>
        {showHidden(allPlans, hiddenPlans, () => setAllPlans(!allPlans))}
      </div>
      {ongoing.map(({ plan, parent, hidden, progress }) => {
        const studiedAt = planStudiedAt(progress);
        const remove: MenuItem = {
          confirmLabel: m.action_confirm_delete(),
          danger: true,
          icon: 'trash',
          label: m.plan_delete(),
          onClick: () => deletePlan(plan.id),
        };
        return (
          <ProgressRow
            done={m.learning_done_of(progress)}
            hidden={hidden}
            iconId={parent?.iconId}
            key={plan.id}
            menu={
              parent ? (
                <ShownMenu more={[remove]} workspace={parent} />
              ) : (
                <Menu items={[remove]} />
              )
            }
            meta={
              hidden
                ? m.learning_hidden()
                : studiedAt
                  ? m.learning_studied({ when: relativeTime(studiedAt) })
                  : m.progress_not_studied()
            }
            name={plan.name}
            onOpen={() => links.openPlan(plan)}
          />
        );
      })}
    </section>
  );
  const openWorkspace = (workspaceId: string) =>
    navigate({ params: { workspaceId }, to: '/workspaces/$workspaceId' });
  // Finished workspaces (their Default Plan) and plans, latest first.
  const finishedList = (done: ProgressWorkspace[]) => {
    const rows = [
      ...done.map((ws) => ({
        at: ws.lastStudiedAt,
        end: <ShownMenu workspace={ws} />,
        hidden: !!ws.hidden,
        key: ws.workspaceId,
        open: () => openWorkspace(ws.workspaceId),
        planName: m.plan_default(),
        workspace: ws,
      })),
      ...shownPlans.flatMap(({ plan, parent, hidden, finishedAt }) =>
        finishedAt && parent
          ? [
              {
                at: finishedAt,
                // Keeps the plan name in line with the rows' ⋮.
                end: <span className="w-9" />,
                hidden,
                key: plan.id,
                open: () => links.openPlan(plan),
                planName: plan.name,
                workspace: parent,
              },
            ]
          : []
      ),
    ].sort((a, b) => b.at.localeCompare(a.at));
    if (!rows.length) return null;
    return (
      <section className="mt-8">
        <h3 className="mb-1 font-bold text-fg-muted text-sm">
          {m.learning_finished()}
        </h3>
        {rows.map((row) => (
          <div
            className={cn(
              'relative -mx-1.5 grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 border-divider border-t px-1.5 py-3 hover:bg-surface-hover-bg',
              row.hidden && 'opacity-50'
            )}
            key={row.key}
          >
            <WorkspaceName
              iconId={row.workspace.iconId}
              meta={m.learning_finished_when({ when: relativeTime(row.at) })}
              name={row.workspace.name}
              onOpen={row.open}
            />
            <div className="max-w-[160px] truncate text-right text-fg-secondary text-sm">
              {row.planName}
            </div>
            {row.end}
          </div>
        ))}
      </section>
    );
  };
  if (!data?.active.length && !data?.finished.length)
    return (
      <>
        <PlaceholderRailMap />
        <RecordProgress />
        {planList}
        {finishedList([])}
        <div className="mt-8 flex">
          {showHidden(all, data?.hiddenCount ?? 0, () => setAll(!all))}
        </div>
      </>
    );
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
            {m.learning_default_plans()}
          </h3>
          {showHidden(all, data?.hiddenCount ?? 0, () => setAll(!all))}
        </div>
        {others.map((ws) => (
          <ProgressRow
            done={m.learning_done_of({ done: ws.done, total: ws.total })}
            hidden={!!ws.hidden}
            iconId={ws.iconId}
            key={ws.workspaceId}
            menu={<ShownMenu workspace={ws} />}
            meta={
              ws.hidden
                ? m.learning_hidden()
                : m.learning_studied({ when: relativeTime(ws.lastStudiedAt) })
            }
            name={ws.name}
            onOpen={() => openWorkspace(ws.workspaceId)}
          />
        ))}
      </section>
      {finishedList(done)}
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

/** A row's ⋮: its workspace's Hide study progress, the Study page's switch,
 * then `more`. A hidden row (Show all) shows Show instead. */
function ShownMenu({
  workspace,
  more = [],
  className,
}: {
  workspace: Pick<ProgressWorkspace, 'workspaceId' | 'hidden'>;
  more?: MenuItem[];
  className?: string;
}) {
  const { isPending, mutate: setShown } = useSetWorkspaceStudyEnabled(
    workspace.workspaceId
  );
  if (workspace.hidden)
    return (
      <Button
        className={cn('relative z-10', className)}
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
    <div className={cn('relative z-10', className)}>
      <Menu
        items={[
          {
            icon: 'viewOff',
            label: m.study_hide_progress(),
            onClick: () => setShown(false),
          },
          ...more,
        ]}
      />
    </div>
  );
}

/** A row in progress (Your plans, Default plans): its name and when it was
 * studied, how much is done and its ⋮. Hidden ones are at half opacity. */
function ProgressRow({
  done,
  hidden,
  menu,
  ...name
}: Parameters<typeof WorkspaceName>[0] & {
  done: string;
  hidden: boolean;
  menu: ReactNode;
}) {
  return (
    <div
      className={cn(
        'relative -mx-1.5 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-divider border-t px-1.5 py-3 hover:bg-surface-hover-bg sm:grid-cols-[minmax(0,1fr)_auto_auto]',
        hidden && 'opacity-50'
      )}
    >
      <WorkspaceName {...name} />
      <div className="hidden text-right text-fg-secondary text-sm sm:block">
        {done}
      </div>
      {menu}
    </div>
  );
}

/** A row's icon (a plan without its workspace: the plan's), name and meta;
 * the name's button covers the row, opening it. */
function WorkspaceName({
  name,
  iconId,
  meta,
  onOpen,
}: {
  name: string;
  iconId?: string;
  meta: string;
  onOpen: () => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 lg:gap-3.5">
      {iconId ? (
        <img
          alt=""
          className="size-8 shrink-0 rounded-button"
          src={iconUrl(iconId)}
        />
      ) : (
        <span className="grid size-8 shrink-0 place-items-center text-fg-secondary">
          <Icon className="-scale-x-100" name="route" size={18} />
        </span>
      )}
      <div className="min-w-0">
        <button
          className="block max-w-full truncate text-left font-semibold text-fg after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-action focus-visible:after:ring-inset"
          onClick={onOpen}
          type="button"
        >
          {name}
        </button>
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
