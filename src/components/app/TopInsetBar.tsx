import { useState } from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { NotificationsBell } from '@/features/notification/NotificationBell';
import { m } from '@/i18n';
import { TopInsetFrame } from '@/summary/TopInsetFrame';
import { ProfileMenu } from './ProfileMenu';
import { SearchDialog } from './SearchDialog';
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
      <SearchDialog open={open} setOpen={setOpen} />
    </>
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
        <NotificationsBell />
      </div>
      <ProfileMenu />
    </TopInsetFrame>
  );
}
