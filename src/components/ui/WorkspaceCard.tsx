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
import { CardActions } from './CardActions';
import { coverBackground } from './CoverArt';
import { Skeleton } from './feedback';

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
      {/* Centred on a phone's short card; from `sm` on the banner (board K3,
          H2), lifting with the card, which rises on hover (Card interactive). */}
      <CardActions className="top-1/2 right-2 z-50 -translate-y-1/2 transition-[translate] duration-320 ease-(--motion-ease-bounce-strong) sm:top-2 sm:translate-y-0 sm:group-has-[[data-slot=card]:hover]/card:-translate-y-1 sm:group-has-[[data-slot=card]:hover]/card:ease-(--motion-ease-smooth-out)">
        <Menu align="start" items={menuItems} />
      </CardActions>
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
      <div aria-hidden className="invisible h-16 sm:h-auto">
        <div className="hidden sm:block">
          <div className="h-19" />
          <div className="-mt-5 ml-3 size-9" />
          <p className="px-3 pt-1.5 text-sm">&nbsp;</p>
          <p className="t-meta px-3 pt-0.5 pb-3">&nbsp;</p>
        </div>
      </div>
    </Skeleton>
  );
}

/** The fields a card shows; the settings cover picker previews them too. */
export type WorkspaceCardFields = Pick<
  Workspace,
  'iconId' | 'name' | 'privacy' | 'topicCount'
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
  const topics = workspace.topicCount;
  return (
    <Card
      border="solid"
      className="group h-full flex-row gap-0 overflow-hidden border-divider p-0 sm:flex-col"
      interactive={interactive}
    >
      <div className="relative w-16 shrink-0 bg-page-hover sm:h-19 sm:w-auto">
        {paint && (
          <span
            aria-hidden
            className="absolute inset-0 transition-[filter] group-hover:brightness-105"
            style={coverBackground(paint)}
          />
        )}
      </div>
      {/* Phones: the cover at the side and the icon before the name (canvas
          board P1). From `sm` these wrappers dissolve into the card's column. */}
      <div className="min-w-0 flex-1 py-2.5 pr-11 pl-3 sm:contents">
        <div className="flex min-w-0 items-center gap-1.5 sm:contents">
          <img
            alt=""
            className="size-5 shrink-0 -translate-y-px rounded-[5px] sm:relative sm:-mt-5 sm:ml-3 sm:size-9 sm:translate-y-0 sm:rounded-button sm:border-2 sm:border-surface sm:bg-surface sm:shadow-[0_1px_3px_rgba(0,0,0,0.12)]"
            height={36}
            src={iconUrl(workspace.iconId)}
            width={36}
          />
          <h3 className="truncate font-bold text-sm sm:px-3 sm:pt-1.5">
            {workspace.name}
          </h3>
        </div>
        <p className="t-meta pt-0.5 text-fg-muted sm:px-3 sm:pb-3">
          {topics === 1
            ? m.workspace_card_one_topic()
            : m.workspace_card_topics({ count: String(topics) })}
        </p>
        {/* One badge high: badges that do not fit wrap to a hidden second line.
          Access comes first so it is never the one hidden. With no badges the
          card ends under its topics; a taller neighbour still evens a row. */}
        {(workspace.privacy !== 'private' || workspace.tags.length > 0) && (
          <div className="mt-1.5 flex h-5.5 flex-wrap gap-1 overflow-hidden sm:mx-3 sm:-mt-0.5 sm:mb-3">
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
        )}
      </div>
    </Card>
  );
}
