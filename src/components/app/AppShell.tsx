import { Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { scheduleAutoScroll } from '@/features/schedule/scrollState';
import { cn } from '@/lib/cn';
import { GlobalDialogs } from './GlobalDialogs';
import { Sidebar } from './Sidebar';

const WORKSPACE_PATH_PATTERN = /^\/workspaces\/[^/]+$/;

export function AppShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Opened-workspace view collapses the nav to the icon rail to relieve crowding.
  const hidden = WORKSPACE_PATH_PATTERN.test(pathname);

  useEffect(() => {
    if (pathname !== '/schedule') scheduleAutoScroll.reset();
  }, [pathname]);

  return (
    <div className="flex h-dvh overflow-hidden bg-page t-body text-fg">
      <div className={cn("hidden lg:flex", hidden && "hidden!")}>
        <Sidebar collapsed={false} />
      </div>
      <main className="h-full min-w-0 flex-1 overflow-hidden p-1.5 sm:p-2.5">
        <Outlet />
      </main>
      <GlobalDialogs />
    </div>
  );
}
