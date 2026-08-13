import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import {
  useDeleteWorkspace,
  useUpdateWorkspace,
  useUpdateWorkspaceSharing,
} from '@/api/hooks';
import type { Workspace } from '@/api/types';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Menu } from '@/components/ui/Menu';
import { ShareDialog } from '@/features/workspace/ShareDialog';
import { WorkspaceFormEditDialog } from '@/features/workspace/WorkspaceFormEditDialog';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { userColorPair } from '@/lib/userColor';
import { Badge } from './Badge';
import { Card } from './Card';
import { Skeleton } from './feedback';
import { Icon } from './Icon';

export function WorkspaceCard({ workspace }: { workspace: Workspace }) {
  const c = userColorPair(workspace.color);
  const { mutate: deleteWorkspace } = useDeleteWorkspace();
  const { mutateAsync: updateWorkspace } = useUpdateWorkspace();
  const { isPending: updateSharingIsPending, mutateAsync: updateSharing } =
    useUpdateWorkspaceSharing();
  const [shareOpen, setShareOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const canManage = workspace.capabilities.canManageMembers;
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
          <span
            className={cn(
              'size-fit rounded-card p-3',
              workspace.color === 'transparent' && 'px-1'
            )}
            style={{ background: c.bg, color: c.fg }}
          >
            <Icon
              className={cn(
                'size-5.5',
                workspace.color === 'transparent' && 'size-6'
              )}
              name="workspaces"
            />
          </span>
          <div className="flex-1">
            <h3 className="t-card-title truncate">{workspace.name}</h3>
            <p className="t-meta mt-1 text-fg-muted">
              {m.workspace_card_meta({
                chapters: String(workspace.chapterCount),
                files: String(workspace.fileCount),
              })}
            </p>
            <div className="mt-3 flex flex-wrap gap-1">
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
      {canManage && (
        <>
          <div className="absolute top-3 right-3 z-50">
            <Menu
              items={[
                {
                  icon: 'settings',
                  label: m.action_edit(),
                  onClick: () => setEditOpen(true),
                },
                {
                  icon: 'link',
                  label: m.action_share(),
                  onClick: () => setShareOpen(true),
                },
                {
                  danger: true,
                  icon: 'trash',
                  label: m.action_delete(),
                  onClick: () => setConfirmDelete(true),
                },
              ]}
            />
          </div>
          <ShareDialog
            link={`/share/workspaces/${workspace.id}`}
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
          {editOpen && (
            <WorkspaceFormEditDialog
              onSubmit={(v) => updateWorkspace({ id: workspace.id, ...v })}
              open
              setOpen={setEditOpen}
              workspace={{
                color: workspace.color,
                name: workspace.name,
                tags: workspace.tags,
              }}
            />
          )}
          <ConfirmDialog
            body={m.confirm_delete_body()}
            onClose={() => setConfirmDelete(false)}
            onConfirm={() => deleteWorkspace(workspace.id)}
            open={confirmDelete}
            title={m.confirm_delete_title({ name: workspace.name })}
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
