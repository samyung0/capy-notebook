import { useContext } from 'react';
import { NotificationsBell } from '@/features/notification/NotificationBell';
import { TopInsetFrame } from '@/summary/TopInsetFrame';
import { useNotionLight } from '@/theme/theme';
import { ProfilePill, SearchButton } from './AccountControls';
import { AppShellContext } from './appShellContext';
import { MobileNavDrawer } from './Sidebar';

/** App pages use the Notion sidebar controls; public pages keep their bar. */
export function TopInsetBar({ className }: { className?: string }) {
  const inAppShell = useContext(AppShellContext);
  const notionLight = useNotionLight();
  if (notionLight && inAppShell) return null;
  return (
    <TopInsetFrame className={className}>
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <MobileNavDrawer className="lg:hidden" />
        <div className="hidden lg:block">
          <SearchButton />
        </div>
        <NotificationsBell />
      </div>
      <ProfilePill />
    </TopInsetFrame>
  );
}

/** Opened workspaces have no permanent app sidebar. */
export function NotionWorkspaceNavigation() {
  return <MobileNavDrawer allowDesktop />;
}
