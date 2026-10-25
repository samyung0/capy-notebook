import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import {
  useMe,
  useUnreadNotificationCount,
  useWorkspaceMembers,
} from '@/api/hooks';
import { Icon } from '@/components/ui/Icon';
import type { MenuItem } from '@/components/ui/Menu';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { MemberAvatars } from './MemberAvatars';
import { ProfileMenu } from './ProfileMenu';
import { SearchDialog } from './SearchDialog';

/** The foot of the workspace's left panel, which replaces the top inset bar
 * there: the members, you first with the unread dot, your avatar opening the
 * menu of workspace and account items; Search and, for managers, Workspace
 * settings beside. A manager alone in the workspace sees Invite members in
 * the row's empty space. */
export function AccountFooter({
  canInvite,
  className,
  items,
  member,
  onOpenSettings,
  workspaceId,
  workspaceName,
}: {
  /** You manage sharing (Workspace settings → Sharing). */
  canInvite: boolean;
  className?: string;
  /** The workspace part of the menu, above the account items. */
  items: MenuItem[];
  /** You hold a membership row: only members may read the roster. */
  member: boolean;
  /** Omitted for roles without workspace settings. */
  onOpenSettings?: () => void;
  workspaceId: string;
  workspaceName: string;
}) {
  const { data: unread } = useUnreadNotificationCount({ errorBoundary: false });
  const { data: me } = useMe({ errorBoundary: false });
  const { data: roster } = useWorkspaceMembers(workspaceId, member, {
    errorBoundary: false,
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const members = (roster ?? [])
    .filter((row) => row.userId !== me?.id)
    .map((row) => ({
      avatarUrl: row.avatarUrl,
      id: row.userId,
      name: row.name,
    }));
  return (
    <div
      className={cn(
        'flex shrink-0 items-center border-divider border-t px-2.5 py-2',
        className
      )}
    >
      <MemberAvatars
        members={members}
        own={
          <ProfileMenu
            dot={(unread?.count ?? 0) > 0}
            notifications
            trigger="own"
            workspace={{ items, name: workspaceName }}
          />
        }
      >
        {canInvite && roster && members.length === 0 && (
          <Link
            className="ml-1.5 min-w-0 truncate font-semibold text-tint-accent-1-fg underline underline-offset-4"
            params={{ workspaceId }}
            replace
            search={(previous) => ({ ...previous, settings: 'sharing' })}
            to="/workspaces/$workspaceId"
          >
            {m.workspace_invite_members()}
          </Link>
        )}
      </MemberAvatars>
      <ToolbarButton label={m.nav_search()} onClick={() => setSearchOpen(true)}>
        <Icon name="search" />
      </ToolbarButton>
      {onOpenSettings && (
        <ToolbarButton label={m.workspace_settings()} onClick={onOpenSettings}>
          <Icon name="settings" />
        </ToolbarButton>
      )}
      <SearchDialog open={searchOpen} setOpen={setSearchOpen} />
    </div>
  );
}
