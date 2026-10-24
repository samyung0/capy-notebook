import { linkOptions } from '@tanstack/react-router';
import { useState } from 'react';
import { useDeleteEditorAsset, useEditorAssets } from '@/api/hooks';
import type { EditorAssetAccess, EditorAssetItem } from '@/api/types';
import {
  ItemCard,
  ItemList,
  ItemSkeletonGrid,
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
import { fileIconName } from '@/lib/fileIcons';
import { EDITOR_ASSET_ACCESS } from '@/lib/listSearch';
import { waitsForConnection } from '@/lib/online';
import { fileKindLabel } from './fileKindLabel';
import { formatFileSize } from './fileUtils';

const accessLabel = (access: EditorAssetAccess) =>
  access === 'open' ? m.files_access_open() : m.files_access_lost();

/** The Files page's Embeds tab: every image and audio clip the caller pays
 * for (M16), named by its note. One in a note the caller can open opens that
 * note. Any can be deleted for good (Q273), since nothing restores it, and
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
              label: accessLabel(value),
              value,
            })),
            selected: access ? [access] : [],
          },
        ]}
        onResetFilters={() => onAccessChange(undefined)}
        onViewChange={onViewChange}
        view={view}
      />
      <PageBody belowToolbar>
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
                m.files_col_note(),
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
}: {
  item: EditorAssetItem;
  view: ListView;
  onDelete: (item: EditorAssetItem) => void;
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
          triggerIcon="moreHorizontal"
        />
      }
      details={`${fileKindLabel(kind)} · ${formatFileSize(item.sizeBytes)}`}
      icon={fileIconName({ kind, name: item.name })}
      link={
        open
          ? linkOptions({
              params: { materialId: open },
              to: '/materials/$materialId',
            })
          : undefined
      }
      meta={relativeTime(item.createdAt)}
      thumbnail={{ fileKind: kind }}
      title={item.materialTitle || m.files_note_unavailable()}
      view={view}
      workspace={item.workspaceName}
      workspaceLost={item.lostAccess}
    />
  );
}
