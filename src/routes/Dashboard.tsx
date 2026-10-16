import { Link } from '@tanstack/react-router';
import { USE_MSW } from '@/api/auth';
import { useWorkspaces } from '@/api/hooks';
import { CloneLinkDialog } from '@/components/app/CloneLinkDialog';
import { InlineErrorState } from '@/components/app/ErrorState';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import DashboardBanner from '@/components/banners/DashboardBanner';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import {
  WorkspaceCard,
  WorkspaceCardSkeleton,
} from '@/components/ui/WorkspaceCard';
import { OnboardingDialog } from '@/features/auth/OnboardingDialog';
import {
  RecentItemsCard,
  useRecentItems,
} from '@/features/dashboard/RecentItemsCard';
import { m } from '@/i18n';
import { unexpectedErrorId } from '@/lib/errors';
import { waitsForConnection } from '@/lib/online';
import { useLoadingReveal } from '@/lib/useLoadingReveal';

const CLERK_ACTIVE = !USE_MSW && !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

const DASHBOARD_WORKSPACE_LIMIT = 12;

/** One row of recent workspaces scrolling sideways, inside the content
 * width; the scroll fade marks the hidden cards. Only the right edge fades,
 * so the card at the left edge stays at full strength. */
const SLIDER_CLASS =
  'scroll-fade-x flex [--scroll-fade-start:0px]! gap-4 overflow-x-auto pt-1 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden';
// Phones show part of the next card so the row reads as scrollable.
const SLIDE_CLASS = 'w-[85%] shrink-0 sm:w-75';

function WorkspacesSection() {
  const { data, error, fetchStatus, isLoading, refetch } = useWorkspaces(
    { sort: 'accessed' },
    { errorBoundary: false }
  );
  const recent = data?.slice(0, DASHBOARD_WORKSPACE_LIMIT);
  const hasMore = (data?.length ?? 0) > DASHBOARD_WORKSPACE_LIMIT;
  const revealRef = useLoadingReveal(isLoading);
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="t-large-card-title">{m.dashboard_workspaces()}</h2>
        <Button
          asChild
          className="underline"
          iconRight="navigationForward"
          size="xs"
          variant="ghost-link"
        >
          <Link preload="intent" to="/workspaces">
            {m.action_go_workspaces()}
          </Link>
        </Button>
      </div>
      {waitsForConnection(fetchStatus, data) ? (
        <QueryPausedState />
      ) : isLoading ? (
        <div className={SLIDER_CLASS}>
          {Array.from({ length: 4 }, (_, i) => (
            <WorkspaceCardSkeleton className={SLIDE_CLASS} key={i} />
          ))}
        </div>
      ) : !data && error ? (
        <InlineErrorState
          className="pt-10 pb-6"
          errorId={unexpectedErrorId(error)}
          message={m.dashboard_recent_workspaces_error()}
          onRetry={() => void refetch()}
        />
      ) : (
        <div className={SLIDER_CLASS} ref={revealRef}>
          {recent?.map((w) => (
            <div className={SLIDE_CLASS} key={w.id}>
              <WorkspaceCard workspace={w} />
            </div>
          ))}
          {hasMore && (
            <div className="flex shrink-0 items-center justify-center p-5">
              <Button asChild size="xs" variant="ghost-link">
                <Link preload="intent" to="/workspaces">
                  <span className="flex items-center gap-2">
                    {m.action_see_all()}
                    <Icon name="arrowRight" />
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

/** A new account's dashboard: both lists are empty, so neither section
 * shows, and this sits in the middle of the page instead. */
function DashboardEmpty() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-10 text-center">
      <p className="t-subtitle">{m.workspaces_empty()}</p>
      <Button
        asChild
        className="t-subtitle! underline hover:bg-surface-hover-bg/80"
        iconRight="sparkles"
        size="sm"
        variant="ghost-link"
      >
        <Link preload="intent" to="/workspaces">
          {m.dashboard_empty_cta()}
        </Link>
      </Button>
    </div>
  );
}

export default function Dashboard() {
  const recent = useRecentItems();
  // Only loaded, empty lists hide: loading, paused and failed lists keep
  // their section so the skeleton or error still shows.
  const workspacesEmpty = recent.workspaces?.length === 0;
  const recentEmpty =
    !recent.isLoading &&
    !recent.paused &&
    recent.missing.length === 0 &&
    recent.items.length === 0;
  return (
    <>
      <PanelWithInvertedRadius
        header={
          <PageHeader
            subtitle={m.dashboard_empty_intro()}
            title={m.dashboard_learn_today()}
          />
        }
      >
        <div className="flex flex-1 flex-col gap-6 px-4 pt-5 pb-6 sm:gap-8 sm:px-6 sm:pt-6">
          {/* <CloudConnectBanner /> */}
          <DashboardBanner />
          {workspacesEmpty && recentEmpty ? (
            <DashboardEmpty />
          ) : (
            <>
              {!workspacesEmpty && <WorkspacesSection />}
              {!recentEmpty && <RecentItemsCard recent={recent} />}
            </>
          )}
        </div>
      </PanelWithInvertedRadius>
      {CLERK_ACTIVE && <OnboardingDialog />}
      <CloneLinkDialog />
    </>
  );
}
