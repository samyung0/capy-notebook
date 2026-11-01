import { linkOptions } from '@tanstack/react-router';
import { useState } from 'react';
import {
  useDeleteEditorAsset,
  useEditorAssets,
  useWorkspaces,
} from '@/api/hooks';
import type { EditorAssetAccess, EditorAssetItem } from '@/api/types';
import {
  ItemCard,
  ItemList,
  ItemSkeletonGrid,
  itemMenuIcon,
} from '@/components/app/ItemCard';
import { ListEnd } from '@/components/app/ListEnd';
import { ListToolbar, type ListView } from '@/components/app/ListToolbar';
import { PageBody } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { FormAlert } from '@/components/ui/FormAlert';
import { SkeletonCardGrid } from '@/components/ui/feedback';
import { Menu } from '@/components/ui/Menu';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { m } from '@/i18n';
import { describeError, unexpectedErrorId } from '@/lib/errors';
import { EDITOR_ASSET_ACCESS } from '@/lib/listSearch';
import { waitsForConnection } from '@/lib/online';
import { fileKindLabel } from './fileKindLabel';
import { formatFileSize } from './fileUtils';

/** The Files page's Embeds tab: every image and audio clip the caller pays
 * for (M16), named by its block (note, quiz or set) and drawn as the image's
 * thumbnail, else the image or audio icon. One in a block the caller can open opens it. Any can be deleted for good (Q273), since nothing restores it, and
 * its note then shows it as removed. */
export function EmbedsTab({
  access,
  onAccessChange,
  view,
  onViewChange,
}: {
  access?: EditorAssetAccess;
  onAccessChange: (access?: EditorAssetAccess) => void;
  view: ListView;
  onViewChange: (view: ListView) => void;
}) {
  const {
    data,
    fetchNextPage,
    fetchStatus,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    isLoading,
  } = useEditorAssets(access);
  const {
    error,
    isPending,
    mutateAsync: deleteMedia,
    reset,
  } = useDeleteEditorAsset();
  // For each note's workspace icon, as the Files and Trash tabs look it up.
  const { data: workspaces = [] } = useWorkspaces(
    { sort: 'accessed' },
    { errorBoundary: false }
  );
  const [target, setTarget] = useState<EditorAssetItem | null>(null);
  const items = data?.pages.flatMap((page) => page.items) ?? [];
  const close = () => {
    if (isPending) return;
    setTarget(null);
    reset();
  };
  return (
    <>
      <ListToolbar
        filters={[
          {
            key: 'access',
            label: m.files_filter_access(),
            onToggle: (value) =>
              onAccessChange(
                access === value ? undefined : (value as EditorAssetAccess)
              ),
            options: EDITOR_ASSET_ACCESS.map((value) => ({
              label: m.files_access_lost(),
              value,
            })),
            selected: access ? [access] : [],
          },
        ]}
        onResetFilters={() => onAccessChange(undefined)}
        onViewChange={onViewChange}
        view={view}
        wide
      />
      <PageBody belowToolbar wide>
        {access === 'lost' && (
          <p className="t-meta mb-3 text-fg-muted" role="note">
            {m.files_lost_media_notice()}
          </p>
        )}
        {waitsForConnection(fetchStatus, data) ? (
          <QueryPausedState />
        ) : isLoading ? (
          view === 'grid' ? (
            <ItemSkeletonGrid count={8} />
          ) : (
            <SkeletonCardGrid cardHeight={72} count={6} />
          )
        ) : items.length === 0 ? (
          <p className="py-10 text-center text-fg-muted">
            {access ? m.files_embeds_empty() : m.files_embeds_none()}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <ItemList
              columns={[
                m.files_col_block(),
                m.create_filter_workspace(),
                m.list_col_details(),
                m.files_sort_added(),
              ]}
              view={view}
            >
              {items.map((item) => (
                <EmbedCard
                  item={item}
                  key={item.assetId}
                  onDelete={setTarget}
                  view={view}
                  workspaceIconId={
                    workspaces.find((ws) => ws.id === item.workspaceId)?.iconId
                  }
                />
              ))}
            </ItemList>
            <ListEnd
              fetchNextPage={fetchNextPage}
              hasNextPage={hasNextPage}
              isFetchingNextPage={isFetchingNextPage}
              isFetchNextPageError={isFetchNextPageError}
            />
          </div>
        )}
      </PageBody>
      <ConfirmDialog
        body={
          target ? m.files_lost_media_delete_body({ name: target.name }) : ''
        }
        closeOnConfirm={false}
        confirmLabel={m.trash_delete_forever()}
        isSubmitting={isPending}
        onClose={close}
        onConfirm={async () => {
          if (!target) return;
          try {
            await deleteMedia(target.assetId);
            setTarget(null);
          } catch {
            // Shown below; the confirmation stays open.
          }
        }}
        open={!!target}
        title={m.trash_delete_confirm_title()}
      >
        <FormAlert
          errorId={error ? unexpectedErrorId(error) : null}
          message={error ? describeError(error).title : null}
        />
      </ConfirmDialog>
    </>
  );
}

function EmbedCard({
  item,
  view,
  onDelete,
  workspaceIconId,
}: {
  item: EditorAssetItem;
  view: ListView;
  onDelete: (item: EditorAssetItem) => void;
  workspaceIconId?: string;
}) {
  const kind = item.purpose === 'audio' ? 'audio' : 'image';
  const open = !item.lostAccess && item.materialId;
  return (
    <ItemCard
      actions={
        <Menu
          items={[
            {
              danger: true,
              icon: 'trash',
              label: m.trash_delete_forever(),
              onClick: () => onDelete(item),
            },
          ]}
          triggerIcon={itemMenuIcon(view)}
        />
      }
      details={`${fileKindLabel(kind)} · ${formatFileSize(item.sizeBytes)}`}
      icon={kind}
      link={
        open
          ? linkOptions({
              params: { materialId: open },
              to: '/materials/$materialId',
            })
          : undefined
      }
      meta={relativeTime(item.createdAt)}
      thumbnail={{ fileKind: kind, thumbnailUrl: item.thumbnailUrl }}
      title={item.materialTitle || m.files_note_unavailable()}
      view={view}
      workspace={item.workspaceName}
      workspaceIconId={workspaceIconId}
      workspaceLost={item.lostAccess}
    />
  );
}
