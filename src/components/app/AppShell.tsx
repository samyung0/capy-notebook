import { Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { api } from '@/api/client';
import { useEventStream, useMe } from '@/api/hooks';
import { scheduleAutoScroll } from '@/features/schedule/scrollState';
import { useFinishToasts } from '@/features/study/finishToasts';
import { useKeyboardHeight } from '@/lib/useKeyboardHeight';
import { AccountBlockedScreen } from './AccountBlockedScreen';
import { InShellMain } from './AppErrorBoundary';
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

  // Stored edits go to their rooms from any page; those of documents this
  // account no longer has are deleted. Loaded, not imported: the drafts
  // bring Yjs, which the entry leaves to the pages that edit.
  const { data: me } = useMe({ errorBoundary: false });
  const actorId = me?.id;
  useEffect(() => {
    if (actorId)
      void import('@/lib/editDrafts').then((drafts) =>
        drafts.startDraftSweeps(actorId, api)
      );
  }, [actorId]);
  useFinishToasts();
  useKeyboardHeight();

  return (
    <div className="t-body relative flex h-[var(--app-height,100dvh)] overflow-hidden bg-page text-fg">
      {/* Phones open the nav from the page panel's menu button instead. */}
      {!hideSidebar && (
        <>
          <div className="hidden sm:flex lg:hidden">
            <Sidebar rail />
          </div>
          <div className="hidden lg:flex">
            <Sidebar account="below-xl" />
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
    </div>
  );
}
