import { linkOptions } from '@tanstack/react-router';
import { memo } from 'react';
import type { EditorAssetItem } from '@/api/types';
import { ItemCard, itemMenuIcon } from '@/components/app/ItemCard';
import type { ListView } from '@/components/app/ListToolbar';
import { Menu } from '@/components/ui/Menu';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { m } from '@/i18n';
import { fileKindLabel } from './fileKindLabel';
import { formatFileSize } from './fileUtils';

/** An image or audio clip the caller pays for (M16) in the Files page's list,
 * named by its block (note, quiz or set) and drawn as the image's thumbnail,
 * else the image or audio icon. One in a block the caller can open opens it.
 * Any can be deleted for good (Q273), since nothing restores it, and its note
 * then shows it as removed. */
export const EmbedItem = memo(function EmbedItem({
  item,
  onDelete,
  pickKey,
  selected,
  view,
  workspaceIconId,
}: {
  item: EditorAssetItem;
  onDelete: (item: EditorAssetItem) => void;
  pickKey: string;
  selected: boolean;
  view: ListView;
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
          ? // A canvas's image opens its workspace's Canvas tab: the canvas has
            // no page of its own.
            item.materialType === 'canvas'
            ? linkOptions({
                params: { workspaceId: item.workspaceId ?? '' },
                search: { panel: 'canvas' },
                to: '/workspaces/$workspaceId',
              })
            : linkOptions({
                params: { materialId: open },
                to: '/materials/$materialId',
              })
          : undefined
      }
      meta={relativeTime(item.createdAt)}
      pickKey={pickKey}
      selected={selected}
      thumbnail={{ fileKind: kind, thumbnailUrl: item.thumbnailUrl }}
      title={item.materialTitle || m.files_note_unavailable()}
      view={view}
      workspace={item.workspaceName}
      workspaceIconId={workspaceIconId}
      workspaceLost={item.lostAccess}
    />
  );
});
