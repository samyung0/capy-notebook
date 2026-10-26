import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { qk } from '@/api/client';
import { useDeleteWorkspace, useUpdateWorkspaceSharing } from '@/api/hooks';
import type { Workspace } from '@/api/types';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Menu } from '@/components/ui/Menu';
import { canManageWorkspaceSettings } from '@/features/workspace/access';
import { CloneWorkspaceDialog } from '@/features/workspace/CloneWorkspaceDialog';
import { ShareDialog } from '@/features/workspace/ShareDialog';
import { WorkspaceSettingsDialog } from '@/features/workspace/WorkspaceSettingsDialog';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { type CoverPaint, coverPaint } from '@/lib/coverArt';
import { iconUrl } from '@/lib/icon-catalog';
import { Badge } from './Badge';
import { Card } from './Card';
import { CardActions } from './CardActions';
import { CoverArt } from './CoverArt';
import { Skeleton } from './feedback';

export function WorkspaceCard({ workspace }: { workspace: Workspace }) {
  const qc = useQueryClient();
  const { mutate: deleteWorkspace } = useDeleteWorkspace();
  const { isPending: updateSharingIsPending, mutateAsync: updateSharing } =
    useUpdateWorkspaceSharing();
  const [shareOpen, setShareOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
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
            icon: 'clone' as const,
            label: m.action_clone_workspace(),
            onClick: () => setCloneOpen(true),
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
    <div className="group/card relative h-full">
      <Link
        className="block h-full"
        key={workspace.id}
        params={{ workspaceId: workspace.id }}
        preload="intent"
        to="/workspaces/$workspaceId"
      >
        <WorkspaceCardFace
          interactive
          menuSpace={menuItems.length > 0}
          paint={paint}
          workspace={workspace}
        />
      </Link>
      {menuItems.length > 0 && (
        // Lifts with the card, which rises on hover (Card interactive). Below
        // desktop widths the title clears room for it (menuSpace).
        <CardActions
          backing="revealed"
          className="top-3 right-3 z-50 transition-[translate] duration-320 ease-(--motion-ease-bounce-strong) group-has-[[data-slot=card]:hover]/card:-translate-y-1 group-has-[[data-slot=card]:hover]/card:ease-(--motion-ease-smooth-out)"
          ink={ink}
        >
          <Menu align="start" items={menuItems} />
        </CardActions>
      )}
      {editOpen && canSettings && (
        <WorkspaceSettingsDialog
          onClose={() => setEditOpen(false)}
          open
          workspace={workspace}
        />
      )}
      {cloneOpen && (
        <CloneWorkspaceDialog
          open
          setOpen={setCloneOpen}
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
            onConfirm={() =>
              deleteWorkspace(workspace.id, {
                // Back to its page then fetches it and shows its error.
                onSuccess: () =>
                  qc.removeQueries({ queryKey: qk.workspace(workspace.id) }),
              })
            }
            open={confirmDelete}
            title={m.workspace_delete_confirm_title({ name: workspace.name })}
          />
        </>
      )}
    </div>
  );
}

/** A loading card built from the face's padding and line heights, so the
 * row keeps its height when cards arrive. */
export function WorkspaceCardSkeleton({ className }: { className?: string }) {
  return (
    <Skeleton
      className={cn(
        'rounded-card border border-transparent p-3.5 xl:p-4.5',
        className
      )}
    >
      <div aria-hidden className="invisible">
        <p className="t-card-title h-[2lh] leading-tight" />
        <p className="t-meta mt-2.5">&nbsp;</p>
        <div className="mt-2.5 h-5.5" />
      </div>
    </Skeleton>
  );
}

/** The fields a card shows; the settings cover picker previews them too. */
export type WorkspaceCardFields = Pick<
  Workspace,
  'chapterCount' | 'fileCount' | 'iconId' | 'name' | 'privacy'
> & { tags: { value: string }[] };

/**
 * The card itself, without its link and menu. A cover fills the card behind
 * the layout, washed so text stays legible; `paint` comes from coverPaint.
 */
export function WorkspaceCardFace({
  workspace,
  paint,
  interactive = false,
  menuSpace = false,
}: {
  workspace: WorkspaceCardFields;
  paint: CoverPaint | null;
  interactive?: boolean;
  /** The card's ⋮ is always shown (below desktop widths, on touch
   * screens): the title keeps clear of it. */
  menuSpace?: boolean;
}) {
  const ink = paint && (paint.light ? 'light' : 'dark');
  return (
    <Card
      border="solid"
      className={cn(
        '@container group relative h-full gap-4 p-3.5 xl:p-4.5',
        paint && 'overflow-hidden'
      )}
      interactive={interactive}
    >
      {paint && (
        <CoverArt
          className="transition-[filter] group-hover:brightness-105"
          paint={paint}
          shade="card"
        />
      )}
      {/* The icon sits beside the name; counts and tags take their own lines. */}
      <div className="relative grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3">
        <img
          alt=""
          // A step smaller on narrow cards (the dashboard's row, phones).
          className="@min-[19rem]:size-10 size-9 -translate-y-px rounded-button"
          height={40}
          src={iconUrl(workspace.iconId)}
          width={40}
        />
        {/* Always two lines tall, so long names do not grow the card; a
            one-line name stays centred beside the icon. */}
        <h3
          className={cn(
            't-card-title flex h-[2lh] items-center leading-tight',
            menuSpace && 'pointer-coarse:pr-7 max-lg:pr-7',
            ink === 'dark' && 'text-white',
            ink === 'light' && 'text-[#1d1d1f]'
          )}
        >
          <span className="line-clamp-2">{workspace.name}</span>
        </h3>
        <p
          className={cn(
            't-meta col-span-2 mt-2.5 text-fg-muted',
            ink === 'dark' && 'text-white/85',
            ink === 'light' && 'text-[#4b4b4b]'
          )}
        >
          {m.workspace_card_meta({
            chapters: String(workspace.chapterCount),
            files: String(workspace.fileCount),
          })}
        </p>
        {/* One badge high, so every card and the skeleton share a height:
            badges that do not fit wrap to a hidden second line. Access comes
            first so it is never the one hidden. */}
        <div className="col-span-2 mt-2.5 -ml-1 flex h-5.5 flex-wrap gap-1 overflow-hidden">
          {workspace.privacy !== 'private' && (
            // Access keeps its colour on covers so it stands apart from tags.
            <Badge
              size="sm"
              tone={workspace.privacy === 'public' ? 'success' : 'info'}
            >
              {workspace.privacy === 'public'
                ? m.share_public()
                : m.workspace_privacy_shared()}
            </Badge>
          )}
          {workspace.tags.map((t) => (
            <Badge
              className={cn(
                'max-w-full',
                ink === 'dark' && 'bg-white/18 text-white',
                ink === 'light' && 'bg-black/8 text-[#1d1d1f]'
              )}
              key={t.value}
              size="sm"
            >
              {/* A 35-character tag is wider than a phone card. */}
              <span className="truncate"># {t.value}</span>
            </Badge>
          ))}
        </div>
      </div>
    </Card>
  );
}
