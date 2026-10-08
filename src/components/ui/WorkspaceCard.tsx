import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import {
  useCloneWorkspace,
  useDeleteWorkspace,
  useUpdateWorkspaceSharing,
} from '@/api/hooks';
import type { Workspace } from '@/api/types';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Menu } from '@/components/ui/Menu';
import { canManageWorkspaceSettings } from '@/features/workspace/access';
import { ShareDialog } from '@/features/workspace/ShareDialog';
import { WorkspaceSettingsDialog } from '@/features/workspace/WorkspaceSettingsDialog';
import { m } from '@/i18n';
import { trackItemCloned } from '@/lib/analytics';
import { toastCloneError } from '@/lib/authToasts';
import { cn } from '@/lib/cn';
import { coverPaint } from '@/lib/coverArt';
import { iconUrl } from '@/lib/icon-catalog';
import { Badge } from './Badge';
import { Card } from './Card';
import { CoverArt } from './CoverArt';
import { Skeleton } from './feedback';

export function WorkspaceCard({ workspace }: { workspace: Workspace }) {
  const { mutate: deleteWorkspace } = useDeleteWorkspace();
  const { isPending: updateSharingIsPending, mutateAsync: updateSharing } =
    useUpdateWorkspaceSharing();
  const [shareOpen, setShareOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { isPending: cloneIsPending, mutate: cloneWorkspace } =
    useCloneWorkspace();
  const navigate = useNavigate();
  // A cover fills the card behind today's layout, washed so text stays legible.
  const paint = useMemo(
    () =>
      workspace.cover
        ? coverPaint(workspace.id, workspace.name, workspace.cover)
        : null,
    [workspace.id, workspace.name, workspace.cover]
  );
  const ink = paint && (paint.light ? 'light' : 'dark');
  const canManage = workspace.capabilities.canManageMembers;
  const canSettings = canManageWorkspaceSettings(workspace);
  const menuItems = [
    ...(canSettings
      ? [
          {
            icon: 'settings' as const,
            label: m.workspace_settings(),
            onClick: () => setEditOpen(true),
          },
          {
            icon: 'link' as const,
            label: m.action_share(),
            onClick: () => setShareOpen(true),
          },
        ]
      : []),
    ...(workspace.canClone
      ? [
          {
            disabled: cloneIsPending,
            icon: 'clone' as const,
            label: m.action_clone_workspace(),
            onClick: () =>
              cloneWorkspace(workspace.id, {
                onError: (err) => toastCloneError(err, 'workspace'),
                onSuccess: ({ workspace: cloned }) => {
                  trackItemCloned('workspace');
                  navigate({
                    params: { workspaceId: cloned.id },
                    to: '/workspaces/$workspaceId',
                  });
                },
              }),
          },
        ]
      : []),
    ...(canManage
      ? [
          {
            danger: true,
            icon: 'trash' as const,
            label: m.action_delete(),
            onClick: () => setConfirmDelete(true),
          },
        ]
      : []),
  ];
  return (
    <div className="relative">
      <Link
        key={workspace.id}
        params={{ workspaceId: workspace.id }}
        preload="intent"
        to="/workspaces/$workspaceId"
      >
        <Card
          border="solid"
          className={cn(
            'group relative h-full gap-4 p-4.5 xl:p-5.5',
            paint && 'overflow-hidden'
          )}
          interactive
        >
          {paint && (
            <CoverArt
              className="transition-[filter] group-hover:brightness-105"
              paint={paint}
              shade="card"
            />
          )}
          {/* Phones put the icon beside the name and the counts on their own
              line; from sm it is the icon above the name. */}
          <div className="relative grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 sm:flex sm:flex-1 sm:flex-col sm:items-stretch sm:gap-4">
            <img
              alt=""
              className="size-10 rounded-button sm:size-11"
              height={44}
              src={iconUrl(workspace.iconId)}
              width={44}
            />
            <div className="contents sm:block sm:flex-1">
              <h3
                className={cn(
                  't-card-title line-clamp-2 pr-8 sm:pr-0',
                  ink === 'dark' && 'text-white',
                  ink === 'light' && 'text-[#1d1d1f]'
                )}
              >
                {workspace.name}
              </h3>
              <p
                className={cn(
                  't-meta col-span-2 mt-2 text-fg-muted sm:mt-1',
                  ink === 'dark' && 'text-white/85',
                  ink === 'light' && 'text-[#4b4b4b]'
                )}
              >
                {m.workspace_card_meta({
                  chapters: String(workspace.chapterCount),
                  files: String(workspace.fileCount),
                })}
              </p>
              <div className="col-span-2 mt-3 -ml-1 flex flex-wrap gap-1">
                {workspace.tags.map((t) => (
                  <Badge
                    className={cn(
                      ink === 'dark' && 'bg-white/18 text-white',
                      ink === 'light' && 'bg-black/8 text-[#1d1d1f]'
                    )}
                    key={t.value}
                    size="sm"
                  >
                    # {t.value}
                  </Badge>
                ))}
                {workspace.privacy !== 'private' && (
                  <Badge
                    className={cn(
                      ink === 'dark' && 'bg-white/18 text-white',
                      ink === 'light' && 'bg-black/8 text-[#1d1d1f]'
                    )}
                    size="sm"
                    tone={workspace.privacy === 'public' ? 'success' : 'info'}
                  >
                    {workspace.privacy === 'public'
                      ? m.share_public()
                      : m.workspace_privacy_shared()}
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </Card>
      </Link>
      {menuItems.length > 0 && (
        <div className="absolute top-3 right-3 z-50">
          <Menu
            align="start"
            iconContainerClassName={cn(
              ink === 'dark' && 'bg-black/25 text-white hover:bg-black/35',
              ink === 'light' && 'bg-white/50 text-[#1d1d1f] hover:bg-white/70'
            )}
            items={menuItems}
          />
        </div>
      )}
      {editOpen && canSettings && (
        <WorkspaceSettingsDialog
          onClose={() => setEditOpen(false)}
          open
          workspace={workspace}
        />
      )}
      {canSettings && (
        <>
          <ShareDialog
            canManageMembers={canManage}
            link={workspace.sharePath}
            onClose={() => setShareOpen(false)}
            onPrivacyChange={(privacy) =>
              updateSharing({ id: workspace.id, privacy })
            }
            onShareRoleChange={(shareRole) =>
              updateSharing({ id: workspace.id, shareRole })
            }
            open={shareOpen}
            privacy={workspace.privacy}
            saving={updateSharingIsPending}
            shareRole={workspace.shareRole}
            title={m.workspace_share_title()}
            workspaceId={workspace.id}
          />
          <ConfirmDialog
            body={m.workspace_delete_confirm_body()}
            confirmLabel={m.trash_delete_forever()}
            onClose={() => setConfirmDelete(false)}
            onConfirm={() => deleteWorkspace(workspace.id)}
            open={confirmDelete}
            title={m.workspace_delete_confirm_title({ name: workspace.name })}
          />
        </>
      )}
    </div>
  );
}

/** Loading placeholder that mirrors {@link WorkspaceCard}'s footprint. */
export function WorkspaceCardSkeleton() {
  return (
    <Card border="solid" className="gap-4 p-4.5 xl:p-5.5">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 sm:flex sm:flex-col sm:items-stretch sm:gap-4">
        <Skeleton className="size-10 rounded-card sm:size-11" />
        <div className="contents sm:block sm:flex-1">
          <Skeleton className="h-4.5 w-3/5 rounded-button" />
          <Skeleton className="col-span-2 mt-2.5 h-3 w-2/5 rounded-button sm:mt-2" />
          <div className="col-span-2 mt-3.5 flex gap-1.5">
            <Skeleton className="h-5 w-14 rounded-full" />
            <Skeleton className="h-5 w-10 rounded-full" />
          </div>
        </div>
      </div>
    </Card>
  );
}
