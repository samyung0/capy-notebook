import { useClerk } from '@clerk/react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { USE_MSW } from '@/api/auth';
import { useMe } from '@/api/hooks';
import { Avatar } from '@/components/ui/Avatar';
import { BASE_BUTTON_STYLE } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { IconButton } from '@/components/ui/IconButton';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { OwnAvatarButton } from './MemberAvatars';
import { ProfilePillButton } from './ProfilePillButton';
import { ThemeSwitchDrawer } from './ThemeSwitchDrawer';

const CLERK_ACTIVE = !USE_MSW && !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

type Trigger = 'pill' | 'avatar' | 'own';

/** The account menu (Settings, Billing, Theme, Log out) behind the profile
 * pill in the top bar, the phone avatar or your avatar in the workspace
 * panel's foot (which opens it upwards, under the workspace's own section). */
type ProfileMenuProps = {
  dot?: boolean;
  /** Adds a Notifications item first (the phone avatar and the workspace
   * panel's foot, which have no bell). */
  notifications?: boolean;
  trigger?: Trigger;
  /** A section above the account items, titled with the workspace name;
   * the account items then sit under a Profile heading. */
  workspace?: { items: MenuItem[]; name: string };
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
  workspace,
}: ProfileMenuProps & { onLogout?: () => void }) {
  const { data: me, isPending } = useMe({ errorBoundary: false });
  const navigate = useNavigate();
  const [themeOpen, setThemeOpen] = useState(false);

  const account: MenuItem[] = [
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
      separated: !!workspace?.items.length,
    },
  ];
  const items: MenuItem[] = workspace?.items.length
    ? [
        ...workspace.items.map((item, i) =>
          i === 0 ? { ...item, heading: workspace.name } : item
        ),
        ...account.map((item, i) =>
          i === 0
            ? { ...item, heading: m.profile_menu_profile(), separated: true }
            : item
        ),
      ]
    : account;

  return (
    <>
      <Menu
        align={trigger === 'own' ? 'start' : 'end'}
        alignWidthToTrigger={trigger === 'pill'}
        className={trigger === 'own' ? 'min-w-56' : undefined}
        items={items}
        side={trigger === 'own' ? 'top' : undefined}
        trigger={
          trigger === 'own' ? (
            <OwnAvatarButton
              aria-label={m.workspace_account_menu()}
              avatarUrl={me?.avatarUrl}
              dot={dot}
              name={me?.name}
              pending={isPending}
            />
          ) : (
            <ProfilePillButton
              avatarUrl={me?.avatarUrl}
              dot={dot}
              name={me?.name}
              pending={isPending}
              variant={trigger}
            />
          )
        }
      />
      <ThemeSwitchDrawer onOpenChange={setThemeOpen} open={themeOpen} />
    </>
  );
}

/** The sidebar's foot: avatar and name linking to account settings, with a
 * log out button, no menu, since the sidebar already lists Settings and
 * Billing. */
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
    <div className="flex h-9 w-full items-center overflow-hidden">
      {/* min-w keeps the avatar whole in the 70px rail, where the log out
          button is clipped instead. */}
      <Link
        aria-label={m.settings_tab_account()}
        className={cn(
          BASE_BUTTON_STYLE,
          'h-full min-w-10.5 flex-1 justify-start gap-2.5 px-2 text-fg hover:bg-page-hover'
        )}
        preload="intent"
        search={{ tab: 'account' }}
        to="/settings"
      >
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
      </Link>
      <span className="shrink-0" data-label>
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
