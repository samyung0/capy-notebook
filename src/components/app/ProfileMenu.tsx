import { useClerk } from '@clerk/react';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { USE_MSW } from '@/api/auth';
import { useMe } from '@/api/hooks';
import { Avatar } from '@/components/ui/Avatar';
import { BASE_BUTTON_STYLE } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { OwnAvatarButton } from './MemberAvatars';
import { ProfilePillButton } from './ProfilePillButton';
import { ThemeSwitchDrawer } from './ThemeSwitchDrawer';

const CLERK_ACTIVE = !USE_MSW && !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

type Trigger = 'avatar' | 'own' | 'row';

/** The account menu (Settings, Billing, Theme, Log out) behind the
 * sidebar's profile row, the phone avatar or your avatar in the workspace
 * panel's foot (the row and the foot open it upwards; the foot puts it under
 * the workspace's own section). */
type ProfileMenuProps = {
  dot?: boolean;
  /** Adds a Notifications item first (the phone avatar and the workspace
   * panel's foot, which have no bell). */
  notifications?: boolean;
  trigger: Trigger;
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
  trigger,
  workspace,
}: ProfileMenuProps & { onLogout?: () => void }) {
  const { data: me, isPending } = useMe({ errorBoundary: false });
  const navigate = useNavigate();
  const [themeOpen, setThemeOpen] = useState(false);
  const upwards = trigger === 'own' || trigger === 'row';

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
        align={upwards ? 'start' : 'end'}
        className={upwards ? 'min-w-56' : undefined}
        items={items}
        side={upwards ? 'top' : undefined}
        trigger={
          trigger === 'row' ? (
            <ProfileRowButton
              avatarUrl={me?.avatarUrl}
              name={me?.name}
              pending={isPending}
            />
          ) : trigger === 'own' ? (
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
              variant="avatar"
            />
          )
        }
      />
      <ThemeSwitchDrawer onOpenChange={setThemeOpen} open={themeOpen} />
    </>
  );
}

/** The sidebar's foot: your avatar and name, opening the profile menu
 * upwards. In the 70px rail only the avatar shows. */
function ProfileRowButton({
  avatarUrl,
  name,
  pending,
  ...props
}: React.ComponentProps<'button'> & {
  avatarUrl?: string;
  name?: string;
  pending: boolean;
}) {
  return (
    <button
      aria-label={m.profile_menu_account()}
      className={cn(
        BASE_BUTTON_STYLE,
        'flex h-9 w-full min-w-10.5 items-center justify-start gap-2.5 overflow-hidden px-2 text-fg hover:bg-page-hover'
      )}
      type="button"
      {...props}
    >
      {pending ? (
        <Skeleton className="size-6.5 shrink-0 rounded-full" />
      ) : (
        <Avatar
          aria-hidden
          className="size-6.5 shrink-0 text-[10.4px]"
          name={name}
          src={avatarUrl}
        />
      )}
      {pending ? (
        <Skeleton className="h-4 min-w-0 flex-1" />
      ) : (
        <span
          className="t-body min-w-0 flex-1 translate-y-px truncate text-left font-bold leading-none"
          data-label
          title={name}
        >
          {name ?? '—'}
        </span>
      )}
    </button>
  );
}
