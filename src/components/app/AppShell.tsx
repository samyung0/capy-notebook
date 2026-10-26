import { Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { api } from '@/api/client';
import { useEventStream, useMe } from '@/api/hooks';
import { Tour } from '@/features/guide/Tour';
import { useRunningTour } from '@/features/guide/tourStore';
import { scheduleAutoScroll } from '@/features/schedule/scrollState';
import { useFinishToasts } from '@/features/study/finishToasts';
import { startDraftSweeps } from '@/lib/editDrafts';
import { useKeyboardHeight } from '@/lib/useKeyboardHeight';
import { AccountBlockedScreen } from './AccountBlockedScreen';
import { InShellMain } from './AppErrorBoundary';
import { Sidebar } from './Sidebar';
import { ThemeDrawer } from './ThemeDrawer';
import { useThemeDrawer } from './themeDrawerSearch';

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

  // Stored edits go to their rooms from any page; those of documents this
  // account no longer has are deleted.
  const { data: me } = useMe({ errorBoundary: false });
  const actorId = me?.id;
  useEffect(() => {
    if (actorId) startDraftSweeps(actorId, api);
  }, [actorId]);
  useFinishToasts();
  useKeyboardHeight();
  const themeDrawer = useThemeDrawer();
  // The guided tour walks across pages, so it lives above them.
  const tour = useRunningTour();

  return (
    <div className="page-frame t-body relative flex h-dvh overflow-hidden bg-page text-fg">
      {/* Phones open the nav from the page panel's menu button instead. */}
      {!hideSidebar && (
        <>
          <div className="hidden sm:flex lg:hidden">
            <Sidebar rail />
          </div>
          <div className="hidden lg:flex">
            <Sidebar account />
          </div>
        </>
      )}
      <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden p-1.5 sm:p-2.5">
        <InShellMain.Provider value>
          <AccountBlockedScreen />
          <div className="min-h-0 min-w-0 flex-1">
            <Outlet />
          </div>
        </InShellMain.Provider>
      </main>
      <ThemeDrawer onOpenChange={themeDrawer.setOpen} open={themeDrawer.open} />
      {tour && <Tour key={tour.workspaceId} workspaceId={tour.workspaceId} />}
    </div>
  );
}
