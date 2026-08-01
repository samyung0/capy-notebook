import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useDeleteWorkspace, useUpdateWorkspaceSharing } from '@/api/hooks';
import type { Workspace } from '@/api/types';
import { Menu } from '@/components/ui/Menu';
import { ShareDialog } from '@/features/workspace/ShareDialog';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { userColorPair } from '@/lib/userColor';
import { usePortals } from '@/stores/portals';
import { Badge } from './Badge';
import { Card } from './Card';
import { Skeleton } from './feedback';
import { Icon } from './Icon';

export function WorkspaceCard({ workspace }: { workspace: Workspace }) {
  const c = userColorPair(workspace.color);
  const del = useDeleteWorkspace();
  const updateSharing = useUpdateWorkspaceSharing();
  const [shareOpen, setShareOpen] = useState(false);
  const canManage = workspace.capabilities.canManageMembers;
  const openWorkspaceEdit = usePortals((s) => s.openWorkspaceEdit);
  // const openWorkspaceStats = usePortals((s) => s.openWorkspaceStats);
  const openConfirm = usePortals((s) => s.openConfirm);
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
              {workspace.chapterCount} chapters · {workspace.fileCount} files
            </p>
            <div className="mt-3 flex flex-wrap gap-1">
              {workspace.tags.slice(0, 3).map((t) => (
                <Badge key={t.value} size="sm">
                  # {t.value}
                </Badge>
              ))}
              {workspace.privacy !== 'private' && (
                <Badge
                  size="sm"
                  tone={workspace.privacy === 'public' ? 'success' : 'info'}
                >
                  {workspace.privacy === 'public' ? 'Public' : 'Shared'}
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
                  onClick: () => openWorkspaceEdit(workspace, workspace.id),
                },
                {
                  icon: 'link',
                  label: 'Share',
                  onClick: () => setShareOpen(true),
                },
                {
                  danger: true,
                  icon: 'trash',
                  label: m.action_delete(),
                  onClick: () =>
                    openConfirm({
                      body: m.confirm_delete_body(),
                      onConfirm: () => del.mutate(workspace.id),
                      title: m.confirm_delete_title({ name: workspace.name }),
                    }),
                },
              ]}
            />
          </div>
          <ShareDialog
            link={`/share/workspaces/${workspace.id}`}
            onClose={() => setShareOpen(false)}
            onPrivacyChange={(privacy) =>
              updateSharing.mutateAsync({ id: workspace.id, privacy })
            }
            onShareRoleChange={(shareRole) =>
              updateSharing.mutateAsync({ id: workspace.id, shareRole })
            }
            open={shareOpen}
            privacy={workspace.privacy}
            saving={updateSharing.isPending}
            shareRole={workspace.shareRole ?? 'viewer'}
            title={`Share ${workspace.name}`}
            workspaceId={workspace.id}
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
