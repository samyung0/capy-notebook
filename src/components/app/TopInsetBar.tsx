import { Link, useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import { useUnreadNotificationCount } from '@/api/hooks';
import { IconButton } from '@/components/ui/IconButton';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { TopInsetFrame } from '@/summary/TopInsetFrame';
import { LazySearchDialog } from './LazySearchDialog';
import { ProfileMenu } from './ProfileMenu';
import { MobileNavDrawer } from './Sidebar';

function SearchButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton
        className="shrink-0"
        icon="search"
        label={m.search_placeholder()}
        onClick={() => setOpen(true)}
        size="md"
        variant="dark"
      />
      <LazySearchDialog open={open} setOpen={setOpen} />
    </>
  );
}

/** Opens the notifications page; accent while on it. */
function NotificationsButton() {
  const active = useRouterState({
    select: (s) => s.location.pathname === '/notifications',
  });
  const { data } = useUnreadNotificationCount({ errorBoundary: false });
  const count = data?.count ?? 0;
  return (
    <IconButton
      asChild
      // The top bar is the hover color in Frappe/Mocha, so lift past it.
      className={cn(
        'shrink-0',
        !active &&
          '[[data-style=classroom][data-theme=frappe]_&]:hover:bg-surface-dark-hover-bg [[data-style=classroom][data-theme=mocha]_&]:hover:bg-surface-dark-hover-bg'
      )}
      // NOTE: dont include unread notification numbers in ui display, labelling is OK for accessibility
      data-unread-count={count}
      dot={count > 0}
      icon="bell"
      label={
        count
          ? m.notifications_unread_count({ count: String(count) })
          : m.notifications_title()
      }
      size="md"
      variant={active ? 'accent' : 'surface'}
    >
      <Link to="/notifications" />
    </IconButton>
  );
}

export function TopInsetBar({ className }: { className?: string }) {
  return (
    <TopInsetFrame className={className}>
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <MobileNavDrawer className="lg:hidden" />
        <div className="hidden lg:block">
          <SearchButton />
        </div>
        <NotificationsButton />
      </div>
      <ProfileMenu />
    </TopInsetFrame>
  );
}
