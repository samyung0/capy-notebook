import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
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
import { toastCloneError } from '@/lib/authToasts';
import { iconUrl } from '@/lib/icon-catalog';
import { trackItemCloned } from '@/lib/observability';
import { Badge } from './Badge';
import { Card } from './Card';
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
          className="relative h-full gap-4 p-4.5 xl:p-5.5"
          interactive
        >
          <span className="size-fit rounded-card">
            <img
              alt=""
              className="size-11 rounded-button"
              height={44}
              src={iconUrl(workspace.iconId)}
              width={44}
            />
          </span>
          <div className="flex-1">
            <h3 className="t-card-title line-clamp-2">{workspace.name}</h3>
            <p className="t-meta mt-1 text-fg-muted">
              {m.workspace_card_meta({
                chapters: String(workspace.chapterCount),
                files: String(workspace.fileCount),
              })}
            </p>
            <div className="mt-3 -ml-1 flex flex-wrap gap-1">
              {workspace.tags.map((t) => (
                <Badge key={t.value} size="sm">
                  # {t.value}
                </Badge>
              ))}
              {workspace.privacy !== 'private' && (
                <Badge
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
        </Card>
      </Link>
      {menuItems.length > 0 && (
        <div className="absolute top-3 right-3 z-50">
          <Menu align="start" items={menuItems} />
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
            link={`/w/${workspace.id}`}
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
      <Skeleton className="size-11 rounded-card" />
      <div className="flex-1">
        <Skeleton className="h-4.5 w-3/5 rounded-button" />
        <Skeleton className="mt-2 h-3 w-2/5 rounded-button" />
        <div className="mt-3.5 flex gap-1.5">
          <Skeleton className="h-5 w-14 rounded-full" />
          <Skeleton className="h-5 w-10 rounded-full" />
        </div>
      </div>
    </Card>
  );
}
