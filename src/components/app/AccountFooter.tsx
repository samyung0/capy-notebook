import { useState } from 'react';
import { useUnreadNotificationCount } from '@/api/hooks';
import { Icon } from '@/components/ui/Icon';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { ProfileMenu } from './ProfileMenu';
import { SearchDialog } from './SearchDialog';

/** The foot of the workspace's left panel, which replaces the top inset bar
 * there: the profile menu (Notifications first, the unread dot on the avatar)
 * and Search. */
export function AccountFooter({ className }: { className?: string }) {
  const { data: unread } = useUnreadNotificationCount({ errorBoundary: false });
  const [searchOpen, setSearchOpen] = useState(false);
  return (
    <div
      className={cn(
        // The menu's anchor wraps the row trigger, so it takes the width.
        'flex shrink-0 items-center gap-1 border-divider border-t px-2.5 py-2 [&>[data-slot=dropdown-menu-anchor]]:flex-1',
        className
      )}
    >
      <ProfileMenu dot={(unread?.count ?? 0) > 0} notifications trigger="row" />
      <ToolbarButton label={m.nav_search()} onClick={() => setSearchOpen(true)}>
        <Icon name="search" />
      </ToolbarButton>
      <SearchDialog open={searchOpen} setOpen={setSearchOpen} />
    </div>
  );
}
