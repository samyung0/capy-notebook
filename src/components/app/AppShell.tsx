import { Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useEventStream } from '@/api/hooks';
import { scheduleAutoScroll } from '@/features/schedule/scrollState';
import { cn } from '@/lib/cn';
import { AccountStatusBanner } from './AccountStatusBanner';
import { ConnectionBanner } from './ConnectionBanner';
import { Sidebar } from './Sidebar';

const WORKSPACE_PATH_PATTERN = /^\/workspaces\/([^/]+)$/;

export function AppShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEventStream(WORKSPACE_PATH_PATTERN.exec(pathname)?.[1] ?? '');
  // Opened-workspace view drops the nav to relieve crowding. Selected from the
  // committed matches, not `location`: `location` flips to the target as soon
  // as navigation starts, which would strip the nav off the outgoing page while
  // its replacement is still being fetched.
  const hideSidebar = useRouterState({
    select: (s) => s.matches.some((m) => m.staticData.hideSidebar === true),
  });

  useEffect(() => {
    if (pathname !== '/schedule') scheduleAutoScroll.reset();
  }, [pathname]);

  return (
    <div className="t-body relative flex h-dvh overflow-hidden bg-page text-fg">
      {!hideSidebar && (
        <div className={cn('hidden lg:flex')}>
          <Sidebar collapsed={false} />
        </div>
      )}
      <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden p-1.5 sm:p-2.5">
        <AccountStatusBanner />
        <ConnectionBanner />
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
