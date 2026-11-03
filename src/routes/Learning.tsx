import { useNavigate, useSearch } from '@tanstack/react-router';
import { useDeleteStudyPlan, useLearningPlans } from '@/api/hooks';
import type { StudyPlan } from '@/api/types';
import { PageHeader, PagePanel } from '@/components/app/layout';
import { TabContent } from '@/components/app/tabPanel';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Menu } from '@/components/ui/Menu';
import { Tabs } from '@/components/ui/Tabs';
import { AllResults } from '@/features/study/AllResults';
import { ReviewTab } from '@/features/study/ReviewTab';
import { m } from '@/i18n';
import { iconUrl } from '@/lib/icon-catalog';
import type { LearningTab } from '@/lib/tabSearch';

/** Learning → Plans: the user's study plans, each opening its workspace's
 * Practice (a plan has no page of its own since the workspace Study page
 * went), with Delete plan in its ⋮. Read progress and its counts went
 * (Epo 2026-11-03); the page is redesigned later. */
function Plans() {
  const { data, isPending } = useLearningPlans({ errorBoundary: false });
  const { mutate: deletePlan } = useDeleteStudyPlan();
  const navigate = useNavigate();
  const openPlan = (plan: StudyPlan) =>
    navigate({
      params: { workspaceId: plan.workspaceId },
      search: { study: 'practice' },
      to: '/workspaces/$workspaceId',
    });
  if (isPending) return <SkeletonList count={3} rowHeight={52} />;
  if (!data?.plans.length)
    return <p className="text-fg-muted">{m.learning_no_plans()}</p>;
  const parents = new Map(data.workspaces.map((ws) => [ws.workspaceId, ws]));
  return (
    <section>
      {data.plans.map((plan) => {
        const parent = parents.get(plan.workspaceId);
        return (
          <div
            className="relative -mx-1.5 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-divider border-t px-1.5 py-3 first:border-t-0 hover:bg-surface-hover-bg"
            key={plan.id}
          >
            <WorkspaceName
              iconId={parent?.iconId}
              meta={parent?.name ?? ''}
              name={plan.name}
              onOpen={() => openPlan(plan)}
            />
            <div className="relative z-10">
              <Menu
                items={[
                  {
                    confirmLabel: m.action_confirm_delete(),
                    danger: true,
                    icon: 'trash',
                    label: m.plan_delete(),
                    onClick: () => deletePlan(plan.id),
                  },
                ]}
              />
            </div>
          </div>
        );
      })}
    </section>
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
  const { tab = 'review' } = useSearch({ strict: false }) as {
    tab?: LearningTab;
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
          { label: m.learning_tab_review(), value: 'review' },
          { label: m.learning_tab_results(), value: 'results' },
          { label: m.learning_tab_plans(), value: 'plans' },
        ]}
        value={tab}
      />
      {/* All results lays out as Files does: toolbar right under the tabs,
       * then the table in the list's padding. */}
      {tab === 'results' ? (
        <AllResults />
      ) : (
        <TabContent fill>
          {tab === 'plans' ? <Plans /> : <ReviewTab />}
        </TabContent>
      )}
    </PagePanel>
  );
}
