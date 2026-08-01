import { Link } from '@tanstack/react-router';
import {
  useDeleteTask,
  useMe,
  useTasks,
  useToggleTask,
  useWorkspaces,
} from '@/api/hooks';
import { CloudConnectBanner } from '@/components/app/CloudConnectBanner';
import { Panel } from '@/components/app/layout';
import { TopInsetBar } from '@/components/app/TopInsetBar';
import DashboardDefaultBanner from '@/components/banners/DashboardDefaultBanner';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { HoverActions } from '@/components/ui/HoverActions';
import { Icon } from '@/components/ui/Icon';
import {
  WorkspaceCard,
  WorkspaceCardSkeleton,
} from '@/components/ui/WorkspaceCard';
import { DashboardCalendar } from '@/features/schedule/DashboardCalendar';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { usePortals } from '@/stores/portals';

function StreakHeading() {
  const { data: me } = useMe();
  const streak = me?.streak ?? 0;
  return (
    <div>
      <h2 className="t-page-title">
        {streak > 0
          ? m.dashboard_streak_days({ count: streak })
          : m.dashboard_streak_none()}
      </h2>
      <p className="t-subtitle mt-1 text-fg-muted">
        Take a look around — your workspaces, notes and itinerary will show up
        here.
      </p>
    </div>
  );
}

const DASHBOARD_WORKSPACE_LIMIT = 12;

function WorkspacesSection() {
  const { data, isLoading } = useWorkspaces({ sort: 'accessed' });
  const recent = data?.slice(0, DASHBOARD_WORKSPACE_LIMIT);
  const hasMore = (data?.length ?? 0) > DASHBOARD_WORKSPACE_LIMIT;
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="t-large-card-title">{m.dashboard_workspaces()}</h2>
        <Button asChild className="p-0" size="md" variant="ghost-link">
          <Link preload="intent" to="/workspaces">
            {m.action_go_workspaces()}
          </Link>
        </Button>
      </div>
      {isLoading && (
        <div className="grid w-full auto-rows-fr grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
          {Array.from({ length: DASHBOARD_WORKSPACE_LIMIT }).map((_, i) => (
            <WorkspaceCardSkeleton key={i} />
          ))}
        </div>
      )}
      {!isLoading && (!recent || recent.length === 0) && (
        <div className="mt-30 flex w-full items-center justify-center">
          <p>
            No workspaces yet.{' '}
            <Link
              className="underline decoration-link decoration-wavy underline-offset-2 hover:decoration-link-hover"
              preload="intent"
              to="/workspaces"
            >
              Go create your first workspace :)
            </Link>
          </p>
        </div>
      )}
      {!isLoading && recent && recent.length > 0 && (
        <div className="grid w-full auto-rows-fr grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
          {recent?.map((w) => (
            <WorkspaceCard key={w.id} workspace={w} />
          ))}
          {hasMore && (
            <div className="flex items-center justify-center p-5">
              <Button asChild className="p-0" size="md" variant="ghost-link">
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

function TasksCard() {
  const { data } = useTasks();
  const toggle = useToggleTask();
  const remove = useDeleteTask();
  const openTaskEdit = usePortals((s) => s.openTaskEdit);
  const openConfirm = usePortals((s) => s.openConfirm);
  const open = data?.filter((t) => !t.done) ?? [];
  const visible = data?.slice(0, 4) ?? [];
  const hasMore = (data?.length ?? 0) > visible.length;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="t-card-title">{m.dashboard_tasks()}</h3>
        <Link
          className="font-semibold text-link text-sm hover:text-link-hover"
          preload="intent"
          to="/tasks"
        >
          {m.action_see_all()}
        </Link>
      </div>
      <div className="flex flex-col gap-1">
        {!open.length && (
          <p className="px-1 pt-2 pb-4 text-center text-fg-muted">
            {m.tasks_empty()}
          </p>
        )}
        {visible.map((t) => (
          <div
            className="group relative flex items-start gap-3 rounded-button px-1 py-2 hover:bg-surface-hover-bg"
            key={t.id}
          >
            <Checkbox
              checked={t.done}
              className={cn(t.meta && 'translate-y-1')}
              size={22}
              tone="purple"
            />
            <button
              className="flex min-w-0 flex-1 items-start gap-3 text-left"
              onClick={() => toggle.mutate({ done: !t.done, id: t.id })}
              type="button"
            >
              <span className="min-w-0">
                <span
                  className={cn(
                    t.done
                      ? 'font-semibold text-fg-muted line-through'
                      : 'font-semibold text-fg',
                    'line-clamp-2',
                    !t.meta && 'translate-y-1'
                  )}
                >
                  {t.title}
                </span>
                {t.meta && (
                  <span className="line-clamp-2 text-fg-muted">{t.meta}</span>
                )}
              </span>
            </button>
            <HoverActions
              className="absolute right-0"
              iconContainerClassName="bg-surface-hover-bg/60 hover:bg-surface-dark"
              items={[
                {
                  icon: 'write',
                  label: m.action_edit(),
                  onClick: () => openTaskEdit(t),
                },
                {
                  icon: 'check',
                  label: t.done ? m.action_mark_undone() : m.action_mark_done(),
                  onClick: () => toggle.mutate({ done: !t.done, id: t.id }),
                },
                {
                  danger: true,
                  icon: 'trash',
                  label: m.action_delete(),
                  onClick: () =>
                    openConfirm({
                      body: m.confirm_delete_body(),
                      onConfirm: () => remove.mutate(t.id),
                      title: m.confirm_delete_title({ name: t.title }),
                    }),
                },
              ]}
            />
          </div>
        ))}
        {hasMore && (
          <Link
            aria-label={m.action_see_all()}
            className="px-1 py-1 text-center font-bold text-fg-muted text-lg leading-none hover:text-fg"
            preload="intent"
            to="/tasks"
          >
            …
          </Link>
        )}
      </div>
    </div>
  );
}

export default function Dashboard() {
  return (
    <div className="flex h-full min-h-full flex-col gap-1.5 sm:gap-2.5 lg:flex-row">
      <Panel
        className="order-last min-h-0 flex-1 rounded-button lg:order-first lg:rounded-card-xl"
        sectionClassName="gap-5 sm:gap-6 p-4 sm:p-6"
      >
        <StreakHeading />
        <CloudConnectBanner />
        <DashboardDefaultBanner />
        <WorkspacesSection />
        {/* <ThinkingSection /> */}
      </Panel>

      <div className="order-first flex h-auto min-h-0 w-(--top-inset-bar-width) shrink-0 flex-col gap-2.5 overflow-visible lg:order-last lg:h-full lg:min-h-full lg:overflow-hidden">
        <TopInsetBar />
        <Panel
          className="hidden min-h-0 flex-1 lg:flex"
          sectionClassName="gap-2.5 p-5"
        >
          <TasksCard />
          <DashboardCalendar />
        </Panel>
      </div>
    </div>
  );
}
