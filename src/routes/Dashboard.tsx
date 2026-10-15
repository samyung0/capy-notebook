import { Link } from '@tanstack/react-router';
import { USE_MSW } from '@/api/auth';
import { useWorkspaces } from '@/api/hooks';
import { CloneLinkDialog } from '@/components/app/CloneLinkDialog';
import { ErrorState } from '@/components/app/ErrorState';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import DashboardBanner from '@/components/banners/DashboardBanner';
import { Button, ErrorAction } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { WorkspaceCard } from '@/components/ui/WorkspaceCard';
import { OnboardingDialog } from '@/features/auth/OnboardingDialog';
import { RecentItemsCard } from '@/features/dashboard/RecentItemsCard';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/errors';
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
      {fetchStatus === 'paused' ? (
        <QueryPausedState />
      ) : isLoading ? (
        <div className={SLIDER_CLASS}>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton
              className={cn(SLIDE_CLASS, 'h-37.5 rounded-card-lg')}
              key={i}
            />
          ))}
        </div>
      ) : !data && error ? (
        <ErrorState
          {...describeError(error)}
          action={
            <ErrorAction
              iconLeftClassName="me-1"
              onClick={() => void refetch()}
            >
              {m.error_action_retry()}
            </ErrorAction>
          }
          variant="panel"
        />
      ) : !recent || recent.length === 0 ? (
        <div
          // The skeleton row's height, so the empty state sits in its middle.
          className="flex h-37.5 w-full flex-col items-center justify-center gap-4 text-center"
          ref={revealRef}
        >
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

export default function Dashboard() {
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
        <div className="flex flex-col gap-6 px-4 pt-5 pb-6 sm:gap-8 sm:px-6 sm:pt-6">
          {/* <CloudConnectBanner /> */}
          <DashboardBanner />
          <WorkspacesSection />
          <RecentItemsCard />
        </div>
      </PanelWithInvertedRadius>
      {CLERK_ACTIVE && <OnboardingDialog />}
      <CloneLinkDialog />
    </>
  );
}
