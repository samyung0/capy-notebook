import { useClerk } from '@clerk/react';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { USE_MSW } from '@/api/auth';
import { useMe } from '@/api/hooks';
import { Menu } from '@/components/ui/Menu';
import { m } from '@/i18n';
import { ProfilePillButton } from './ProfilePillButton';
import { ThemeSwitchDrawer } from './ThemeSwitchDrawer';

const CLERK_ACTIVE = !USE_MSW && !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

type Trigger = 'pill' | 'row' | 'avatar';

/** The account menu (Settings, Billing, Theme, Log out) behind the profile
 * pill in the top bar, the sidebar's profile row or the phone avatar. */
type ProfileMenuProps = {
  dot?: boolean;
  /** Adds a Notifications item first (the phone avatar, which has no bell). */
  onNotifications?: () => void;
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
  onNotifications,
  trigger = 'pill',
}: ProfileMenuProps & { onLogout?: () => void }) {
  const { data: me, isPending } = useMe({ errorBoundary: false });
  const navigate = useNavigate();
  const [themeOpen, setThemeOpen] = useState(false);

  return (
    <>
      <Menu
        align={trigger === 'row' ? 'start' : 'end'}
        alignWidthToTrigger={trigger !== 'avatar'}
        items={[
          ...(onNotifications
            ? [
                {
                  icon: 'bell' as const,
                  label: m.notifications_title(),
                  onClick: onNotifications,
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
