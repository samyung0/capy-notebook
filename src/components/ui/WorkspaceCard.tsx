import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { qk } from '@/api/client';
import {
  useDeleteWorkspace,
  useForgetWorkspace,
  useUpdateWorkspaceSharing,
} from '@/api/hooks';
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
import { coverBackground } from './CoverArt';
import { Skeleton } from './feedback';
import { IconButton } from './IconButton';

export function WorkspaceCard({ workspace }: { workspace: Workspace }) {
  const qc = useQueryClient();
  const { mutate: deleteWorkspace } = useDeleteWorkspace();
  const { mutate: forget } = useForgetWorkspace();
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
  const canManage = workspace.capabilities.canManageMembers;
  const canSettings = canManageWorkspaceSettings(workspace);
  const menuItems = [
    // Everyone has settings (their own Study tab); managers also share.
    {
      icon: 'settings' as const,
      label: m.workspace_settings(),
      onClick: () => setEditOpen(true),
    },
    ...(canSettings
      ? [
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
    // A workspace held only as a visitor (no membership) can be forgotten.
    ...(workspace.role
      ? []
      : [
          {
            icon: 'eraser' as const,
            label: m.action_forget(),
            onClick: () => forget(workspace.id),
          },
        ]),
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
        <WorkspaceCardFace interactive paint={paint} workspace={workspace} />
      </Link>
      {/* On the banner (board K3, H2). From desktop widths with a mouse it
          shows on the card's hover, focus or while its menu is open; below
          them and on touch screens it always shows (V2). It lifts with the
          card, which rises on hover (Card interactive). */}
      <div className="absolute top-2 right-2 z-50 transition-[translate] duration-320 ease-(--motion-ease-bounce-strong) group-has-[[data-slot=card]:hover]/card:-translate-y-1 group-has-[[data-slot=card]:hover]/card:ease-(--motion-ease-smooth-out) lg:[&_button]:opacity-0 lg:pointer-coarse:[&_button]:opacity-100 lg:has-data-[state=open]:[&_button]:opacity-100 lg:group-hover/card:[&_button]:opacity-100 lg:focus-within:[&_button]:opacity-100">
        <Menu
          align="start"
          items={menuItems}
          trigger={
            <IconButton
              className="size-7 rounded-full bg-white/85 p-0 text-[#4b4b4b] hover:bg-white [&>svg]:size-4"
              icon="moreVertical"
              label={m.a11y_open_menu()}
            />
          }
        />
      </div>
      {editOpen && (
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

/** A loading card with the face's banner, icon and line heights, so the
 * row keeps its height when cards arrive. */
export function WorkspaceCardSkeleton({ className }: { className?: string }) {
  return (
    <Skeleton
      className={cn('rounded-card border border-transparent', className)}
    >
      <div aria-hidden className="invisible">
        <div className="h-19" />
        <div className="-mt-5 ml-3 size-9" />
        <p className="px-3 pt-1.5 text-sm">&nbsp;</p>
        <p className="t-meta px-3 pt-0.5">&nbsp;</p>
        <div className="mx-3 mt-2.5 mb-3 h-5.5" />
      </div>
    </Skeleton>
  );
}

/** The fields a card shows; the settings cover picker previews them too. */
export type WorkspaceCardFields = Pick<
  Workspace,
  'chapterCount' | 'iconId' | 'name' | 'privacy'
> & { tags: { value: string }[] };

/** Access and tags share one look on the card: a small 22px box. */
const CARD_BADGE = 'h-5.5 rounded-[6px] px-1.75 py-0 font-semibold';

/**
 * The card itself, without its link and menu (board K3, H2): the cover as a
 * 76px banner, the icon on its bottom edge, then the name, the topic count,
 * and access and tags. `paint` comes from coverPaint; without a cover the
 * banner is plain.
 */
export function WorkspaceCardFace({
  workspace,
  paint,
  interactive = false,
}: {
  workspace: WorkspaceCardFields;
  paint: CoverPaint | null;
  interactive?: boolean;
}) {
  const topics = workspace.chapterCount;
  return (
    <Card
      border="solid"
      className="group h-full gap-0 overflow-hidden border-divider p-0"
      interactive={interactive}
    >
      <div className="relative h-19 shrink-0 bg-page-hover">
        {paint && (
          <span
            aria-hidden
            className="absolute inset-0 transition-[filter] group-hover:brightness-105"
            style={coverBackground(paint)}
          />
        )}
      </div>
      <img
        alt=""
        className="relative -mt-5 ml-3 size-9 rounded-button border-2 border-surface bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.12)]"
        height={36}
        src={iconUrl(workspace.iconId)}
        width={36}
      />
      <h3 className="truncate px-3 pt-1.5 font-bold text-sm">
        {workspace.name}
      </h3>
      <p className="t-meta px-3 pt-0.5 text-fg-muted">
        {topics === 1
          ? m.workspace_card_one_topic()
          : m.workspace_card_topics({ count: String(topics) })}
      </p>
      {/* One badge high, so every card and the skeleton share a height:
          badges that do not fit wrap to a hidden second line. Access comes
          first so it is never the one hidden. */}
      <div className="mx-3 mt-2.5 mb-3 flex h-5.5 flex-wrap gap-1 overflow-hidden">
        {workspace.privacy !== 'private' && (
          <Badge
            className={CARD_BADGE}
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
              CARD_BADGE,
              'max-w-full bg-page-hover text-fg-secondary'
            )}
            key={t.value}
            size="sm"
          >
            {/* A 35-character tag is wider than a phone card. */}
            <span className="truncate"># {t.value}</span>
          </Badge>
        ))}
      </div>
    </Card>
  );
}
