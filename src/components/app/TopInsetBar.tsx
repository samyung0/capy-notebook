import { useClerk } from '@clerk/react';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { USE_MSW } from '@/api/auth';
import { useMe } from '@/api/hooks';
import { Avatar } from '@/components/ui/Avatar';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Menu } from '@/components/ui/Menu';
import { NotificationsBell } from '@/features/notification/NotificationBell';
import { m } from '@/i18n';
import { TopInsetFrame } from '@/summary/TopInsetFrame';
import { SearchDialog } from './SearchDialog';
import { MobileNavDrawer } from './Sidebar';
import { ThemeSwitchDrawer } from './ThemeSwitchDrawer';

const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as
  | string
  | undefined;
const CLERK_ACTIVE = !USE_MSW && !!CLERK_PUBLISHABLE_KEY;

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

function ProfilePillInner({ onLogout }: { onLogout?: () => void }) {
  const { data: me } = useMe({ errorBoundary: false });
  const navigate = useNavigate();
  const [themeOpen, setThemeOpen] = useState(false);

  return (
    <>
      <Menu
        align="end"
        alignWidthToTrigger
        items={[
          {
            icon: 'settings',
            label: m.profile_menu_settings(),
            onClick: () => navigate({ to: '/settings' }),
          },
          {
            icon: 'chart',
            label: m.profile_menu_billing(),
            onClick: () => navigate({ to: '/billing' }),
          },
          {
            icon: 'palette',
            label: m.settings_theme(),
            onClick: () => setThemeOpen(true),
          },
          {
            danger: true,
            icon: 'logout',
            label: m.profile_menu_logout(),
            onClick: onLogout,
          },
        ]}
        trigger={
          <button
            className="flex items-center gap-2.5 rounded-full bg-surface py-1 pr-3 pl-1 hover:bg-surface-hover-bg"
            type="button"
          >
            <Avatar
              className="size-9.5 text-[15.2px]"
              name={me?.name}
              src={me?.avatarUrl}
            />
            <span className="text-left">
              <span className="block font-bold">{me?.name ?? '—'}</span>
            </span>
            <Icon className="text-fg-muted" name="chevronDown" size={16} />
          </button>
        }
      />
      <ThemeSwitchDrawer onOpenChange={setThemeOpen} open={themeOpen} />
    </>
  );
}

function ClerkProfilePill() {
  const { signOut } = useClerk();
  return <ProfilePillInner onLogout={() => void signOut()} />;
}

function ProfilePill() {
  if (!CLERK_ACTIVE) return <ProfilePillInner />;
  return <ClerkProfilePill />;
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
      <ProfilePill />
    </TopInsetFrame>
  );
}
