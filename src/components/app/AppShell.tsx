import { Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { api } from '@/api/client';
import { useEventStream, useMe } from '@/api/hooks';
import { Tour } from '@/features/guide/Tour';
import { useRunningTour } from '@/features/guide/tourStore';
import { useFinishToasts } from '@/features/questions/finishToasts';
import { scheduleAutoScroll } from '@/features/schedule/scrollState';
import { AccountVoiceOverlay } from '@/features/voice/VoiceCard';
import { useKeyboardHeight } from '@/lib/useKeyboardHeight';
import { whenIdle } from '@/lib/whenIdle';
import { workspaceOfPath } from '@/lib/workspacePath';
import { AccountBlockedScreen } from './AccountBlockedScreen';
import { InShellMain } from './AppErrorBoundary';
import { Sidebar } from './Sidebar';
import { ThemeDrawer } from './ThemeDrawer';
import { useThemeDrawer } from './themeDrawerSearch';

export function AppShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Its pages (Assignments, Members, Study) are child routes: the stream keeps
  // its workspace across them.
  useEventStream(workspaceOfPath(pathname));
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
  // account no longer has are deleted, and a deleted item's are offered (Q40).
  const { data: me } = useMe({ errorBoundary: false });
  const actorId = me?.id;
  const filesEditable = !!me?.filesEditable;
  // The sweeps' code (drafts, device copies, Yjs) loads after sign-in once the
  // first page's chunks are in, and stays out of the app's entry (Q908). A
  // chunk that fails to load skips the sweep until the next boot.
  useEffect(() => {
    if (!actorId) return;
    whenIdle(() => {
      Promise.all([
        import('@/lib/editDrafts'),
        import('@/features/collaboration/deletedEditsToast'),
      ])
        .then(([{ startDraftSweeps }, { offerDeletedEdits }]) =>
          startDraftSweeps(actorId, api, offerDeletedEdits, filesEditable)
        )
        .catch(() => undefined);
      import('@/features/collaboration/deviceCopy')
        .then(({ startDeviceCopySweep }) => startDeviceCopySweep(actorId))
        .catch(() => undefined);
    });
  }, [actorId, filesEditable]);
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
      <AccountVoiceOverlay />
      {tour && <Tour key={tour.workspaceId} workspaceId={tour.workspaceId} />}
    </div>
  );
}
