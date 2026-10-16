import { useClerk } from '@clerk/react';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { USE_MSW } from '@/api/auth';
import { useMe } from '@/api/hooks';
import { Avatar } from '@/components/ui/Avatar';
import { Skeleton } from '@/components/ui/feedback';
import { IconButton } from '@/components/ui/IconButton';
import { Menu } from '@/components/ui/Menu';
import { m } from '@/i18n';
import { ProfilePillButton } from './ProfilePillButton';
import { ThemeSwitchDrawer } from './ThemeSwitchDrawer';

const CLERK_ACTIVE = !USE_MSW && !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

type Trigger = 'pill' | 'avatar';

/** The account menu (Settings, Billing, Theme, Log out) behind the profile
 * pill in the top bar or the phone avatar. */
type ProfileMenuProps = {
  dot?: boolean;
  /** Adds a Notifications item first (the phone avatar, which has no bell). */
  notifications?: boolean;
  trigger?: Trigger;
};

export function ProfileMenu(props: ProfileMenuProps) {
  if (!CLERK_ACTIVE) return <ProfileMenuInner {...props} />;
  return <ClerkProfileMenu {...props} />;
}

function ClerkProfileMenu(props: ProfileMenuProps) {
  const { signOut } = useClerk();
  return <ProfileMenuInner onLogout={() => void signOut()} {...props} />;
}

/** `dot` marks unread notifications on the avatar trigger. */
function ProfileMenuInner({
  dot,
  onLogout,
  notifications,
  trigger = 'pill',
}: ProfileMenuProps & { onLogout?: () => void }) {
  const { data: me, isPending } = useMe({ errorBoundary: false });
  const navigate = useNavigate();
  const [themeOpen, setThemeOpen] = useState(false);

  return (
    <>
      <Menu
        align="end"
        alignWidthToTrigger={trigger !== 'avatar'}
        items={[
          ...(notifications
            ? [
                {
                  dot,
                  icon: 'bell' as const,
                  label: m.notifications_title(),
                  onClick: () => navigate({ to: '/notifications' }),
                },
              ]
            : []),
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
          <ProfilePillButton
            avatarUrl={me?.avatarUrl}
            dot={dot}
            name={me?.name}
            pending={isPending}
            variant={trigger}
          />
        }
      />
      <ThemeSwitchDrawer onOpenChange={setThemeOpen} open={themeOpen} />
    </>
  );
}

/** The sidebar's foot: avatar and name with a log out button, no menu, since
 * the sidebar already lists Settings and Billing. */
export function ProfileRow() {
  if (!CLERK_ACTIVE) return <ProfileRowInner />;
  return <ClerkProfileRow />;
}

function ClerkProfileRow() {
  const { signOut } = useClerk();
  return <ProfileRowInner onLogout={() => void signOut()} />;
}

function ProfileRowInner({ onLogout }: { onLogout?: () => void }) {
  const { data: me, isPending } = useMe({ errorBoundary: false });
  return (
    <div className="flex h-9 w-full items-center gap-2.5 overflow-hidden px-2">
      {isPending ? (
        <Skeleton className="size-6.5 shrink-0 rounded-full" />
      ) : (
        <Avatar
          aria-hidden
          className="size-6.5 text-[10.4px]"
          name={me?.name}
          src={me?.avatarUrl}
        />
      )}
      {isPending ? (
        <Skeleton className="h-4 min-w-0 flex-1" />
      ) : (
        <span
          className="t-body min-w-0 flex-1 translate-y-px truncate font-bold leading-none"
          data-label
          title={me?.name}
        >
          {me?.name ?? '—'}
        </span>
      )}
      <span className="-mr-1 shrink-0" data-label>
        <IconButton
          icon="logout"
          label={m.profile_menu_logout()}
          onClick={onLogout}
          size="sm"
          variant="danger-light"
        />
      </span>
    </div>
  );
}
