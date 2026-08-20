import { Link } from '@tanstack/react-router';
import { useMe, useWorkspaces } from '@/api/hooks';
import { CloudConnectBanner } from '@/components/app/CloudConnectBanner';
import { Panel } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { TopInsetBar } from '@/components/app/TopInsetBar';
import DashboardDefaultBanner from '@/components/banners/DashboardDefaultBanner';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import {
  WorkspaceCard,
  WorkspaceCardSkeleton,
} from '@/components/ui/WorkspaceCard';
import { RecentItemsCard } from '@/features/dashboard/RecentItemsCard';
import { m } from '@/i18n';

function StreakHeading() {
  const { data: me } = useMe({ errorBoundary: false });
  const streak = me?.streak ?? 0;
  return (
    <div>
      <h2 className="t-page-title">
        {streak > 0
          ? m.dashboard_streak_days({ count: streak })
          : m.dashboard_streak_none()}
      </h2>
      <p className="t-subtitle mt-1 text-fg-muted">
        {m.dashboard_empty_intro()}
      </p>
    </div>
  );
}

const DASHBOARD_WORKSPACE_LIMIT = 12;

function WorkspacesSection() {
  const { data, fetchStatus, isLoading } = useWorkspaces(
    { sort: 'accessed' },
    { errorBoundary: false }
  );
  const recent = data?.slice(0, DASHBOARD_WORKSPACE_LIMIT);
  const hasMore = (data?.length ?? 0) > DASHBOARD_WORKSPACE_LIMIT;
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="t-large-card-title">{m.dashboard_workspaces()}</h2>
        <Button asChild size="xs" variant="ghost-link">
          <Link preload="intent" to="/workspaces">
            {m.action_go_workspaces()}
          </Link>
        </Button>
      </div>
      {fetchStatus === 'paused' ? (
        <QueryPausedState />
      ) : isLoading ? (
        <div className="grid w-full auto-rows-fr grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
          {Array.from({ length: DASHBOARD_WORKSPACE_LIMIT }).map((_, i) => (
            <WorkspaceCardSkeleton key={i} />
          ))}
        </div>
      ) : !recent || recent.length === 0 ? (
        <div className="mt-30 flex w-full items-center justify-center">
          <p>
            {m.workspaces_empty()}{' '}
            <Link
              className="underline decoration-link decoration-wavy underline-offset-2 hover:decoration-link-hover"
              preload="intent"
              to="/workspaces"
            >
              {m.dashboard_empty_cta()}
            </Link>
          </p>
        </div>
      ) : (
        <div className="grid w-full auto-rows-fr grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
          {recent?.map((w) => (
            <WorkspaceCard key={w.id} workspace={w} />
          ))}
          {hasMore && (
            <div className="flex items-center justify-center p-5">
              <Button asChild size="xs" variant="ghost-link">
                <Link preload="intent" to="/workspaces">
                  <span className="flex items-center gap-2">
                    {m.action_see_all()}
                    <Icon name="arrowRight" size={16} />
                  </span>
                </Link>
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default function Dashboard() {
  return (
    <div className="flex h-full min-h-full flex-col gap-1.5 sm:gap-2.5 lg:flex-row">
      <Panel
        className="order-last min-h-0 flex-1 rounded-button lg:order-first lg:rounded-card-xl"
        sectionClassName="gap-5 2xl:gap-6 p-4 sm:p-6"
      >
        <StreakHeading />
        <CloudConnectBanner />
        <DashboardDefaultBanner />
        <WorkspacesSection />
      </Panel>

      <div className="order-first flex h-auto min-h-0 w-(--top-inset-bar-width) shrink-0 flex-col gap-2.5 overflow-visible lg:order-last lg:h-full lg:min-h-full lg:overflow-hidden">
        <TopInsetBar />
        <Panel
          className="hidden min-h-0 flex-1 lg:flex"
          sectionClassName="min-h-0 flex-1 gap-2.5 p-5"
        >
          <RecentItemsCard />
        </Panel>
      </div>
    </div>
  );
}
