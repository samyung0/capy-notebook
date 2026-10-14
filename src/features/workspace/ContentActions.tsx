import { type ReactNode, useState } from 'react';
import {
  updateFileBodyNameMax,
  updateMaterialBodyTitleMax,
} from '@/api/gen/validators';
import {
  useDeleteFile,
  useDeleteMaterial,
  useMoveFile,
  useMoveMaterial,
  useUpdateFile,
  useUpdateMaterial,
} from '@/api/hooks';
import type { Chapter, UserColor } from '@/api/types';
import { TrashConfirmDialog } from '@/components/app/TrashConfirmDialog';
import { SimpleDialog } from '@/components/ui/Dialog';
import { HoverActions } from '@/components/ui/HoverActions';
import { Menu, type MenuItem, type MenuProps } from '@/components/ui/Menu';
import { NameFormDialog } from '@/components/ui/NameFormDialog';
import { formatFileSize } from '@/features/files/fileUtils';
import { MoveToChapterDialog } from '@/features/workspace/MoveToChapterDialog';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { CloneItemDialog } from './CloneItemDialog';
import type { ContentActionTarget } from './contentActionTarget';

export function ContentActions({
  showMove = true,
  beforeDelete,
  canClone = false,
  chapters,
  color,
  content,
  display,
  hoverClassName,
  leadingItems = [],
  menuAlign,
  menuTrigger,
  menuTriggerIcon,
  hoverIconContainerClassName,
  onDeleted,
  onMove,
  onShare,
  propertiesClassName,
  propertyLabelClassName,
  renameFieldLabel,
  renameTitle,
  readOnly = false,
  workspaceId,
}: {
  showMove?: boolean;
  beforeDelete?: () => boolean;
  /** Offers Clone, also to a read-only viewer who may copy (workspace.canClone). */
  canClone?: boolean;
  chapters: Chapter[];
  color?: UserColor;
  content?: ContentActionTarget;
  display: 'hover' | 'menu';
  hoverClassName?: string;
  leadingItems?: MenuItem[];
  menuAlign?: MenuProps['align'];
  menuTrigger?: ReactNode;
  menuTriggerIcon?: MenuProps['triggerIcon'];
  hoverIconContainerClassName?: string;
  onDeleted?: () => void;
  onMove?: (chapterId: string | null) => void;
  /** Offers Share after Rename; the caller owns the dialog. */
  onShare?: () => void;
  propertiesClassName?: string;
  propertyLabelClassName?: string;
  readOnly?: boolean;
  renameFieldLabel?: string;
  renameTitle?: string;
  workspaceId: string;
}) {
  const { mutateAsync: updateFile } = useUpdateFile(workspaceId);
  const { mutate: moveFile } = useMoveFile(workspaceId);
  const { mutate: deleteFile } = useDeleteFile(workspaceId);
  const { mutateAsync: updateMaterial } = useUpdateMaterial(workspaceId);
  const { mutate: moveMaterial } = useMoveMaterial(workspaceId);
  const { mutate: deleteMaterial } = useDeleteMaterial(workspaceId);

  const [renameOpen, setRenameOpen] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);

  // One order on every item menu (cards, rows, the open item's header):
  // open or view, Rename, Share, Clone, Move, Properties, Delete.
  const items: MenuItem[] = [
    ...leadingItems,
    ...(!readOnly && content
      ? [
          {
            icon: 'pencil' as const,
            label: m.action_rename(),
            onClick: () => setRenameOpen(true),
          },
        ]
      : []),
    ...(onShare
      ? [{ icon: 'link' as const, label: m.action_share(), onClick: onShare }]
      : []),
    ...(canClone && content
      ? [
          {
            icon: 'clone' as const,
            label: m.action_clone(),
            onClick: () => setCloneOpen(true),
          },
        ]
      : []),
    ...(!readOnly && content
      ? [
          ...(showMove
            ? [
                {
                  icon: 'files' as const,
                  label: m.content_move_file(),
                  onClick: () => setMoveOpen(true),
                },
              ]
            : []),
          {
            icon: 'help' as const,
            label: m.content_properties(),
            onClick: () => setPropertiesOpen(true),
          },
          {
            danger: true,
            icon: 'trash' as const,
            label: m.action_delete(),
            onClick: () => setConfirmOpen(true),
          },
        ]
      : []),
  ];

  const saveName = async (nextName: string) => {
    if (!content) return;
    if (content.type === 'file') {
      await updateFile({ id: content.id, name: nextName });
    } else {
      await updateMaterial({
        id: content.id,
        patch: { title: nextName },
      });
    }
  };

  const selectChapter = (chapterId: string | null) => {
    if (!content) return;
    if (onMove) {
      onMove(chapterId);
    } else if (content.type === 'file') {
      moveFile({ chapterId, id: content.id });
    } else {
      moveMaterial({ chapterId, id: content.id });
    }
  };

  const deleteContent = () => {
    if (!content || (beforeDelete && !beforeDelete())) return false;
    if (content.type === 'file') {
      deleteFile(content.id);
    } else {
      deleteMaterial(content.id);
    }
    onDeleted?.();
    return true;
  };

  return (
    <>
      {items.length > 0 && display === 'hover' && (
        <HoverActions
          className={hoverClassName}
          iconContainerClassName={hoverIconContainerClassName}
          items={items}
        />
      )}
      {display === 'menu' && (
        <Menu
          align={menuAlign}
          items={items}
          trigger={menuTrigger}
          triggerIcon={menuTriggerIcon}
        />
      )}

      {content && (
        <>
          {cloneOpen && (
            <CloneItemDialog
              item={
                content.type === 'file'
                  ? {
                      id: content.id,
                      name: content.name,
                      type: 'file',
                      workspaceId,
                    }
                  : {
                      id: content.id,
                      kind: content.kind,
                      name: content.name,
                      type: 'material',
                      workspaceId,
                    }
              }
              onClose={() => setCloneOpen(false)}
            />
          )}
          {renameOpen && (
            <NameFormDialog
              defaultName={content.name}
              fieldLabel={renameFieldLabel}
              maxLength={
                content.type === 'file'
                  ? updateFileBodyNameMax
                  : updateMaterialBodyTitleMax
              }
              onClose={() => setRenameOpen(false)}
              onSubmit={saveName}
              open
              title={renameTitle ?? m.action_rename()}
            />
          )}

          <ContentPropertiesDialog
            className={propertiesClassName}
            content={content}
            labelClassName={propertyLabelClassName}
            onClose={() => setPropertiesOpen(false)}
            open={propertiesOpen}
          />

          <TrashConfirmDialog
            name={content.name}
            onClose={() => setConfirmOpen(false)}
            onConfirm={() => {
              if (deleteContent()) setConfirmOpen(false);
            }}
            open={confirmOpen}
          />

          <MoveToChapterDialog
            chapters={chapters}
            color={color}
            currentChapterId={content.chapterId}
            onClose={() => setMoveOpen(false)}
            onSelect={selectChapter}
            open={moveOpen}
          />
        </>
      )}
    </>
  );
}

/** An item's properties: a file's size, status and upload time; a material's
 * size, structure and creation time, each row only where the item has it. */
export function ContentPropertiesDialog({
  className = 'grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm',
  content,
  labelClassName = 'text-fg-muted',
  onClose,
  open,
}: {
  className?: string;
  content: ContentActionTarget;
  labelClassName?: string;
  onClose: () => void;
  open: boolean;
}) {
  const file = content.type === 'file';
  return (
    <SimpleDialog
      onClose={onClose}
      open={open}
      title={m.content_properties_title({
        kind: file ? m.common_file() : m.common_material(),
      })}
    >
      <dl className={className}>
        <Row
          label={m.common_name()}
          labelClassName={labelClassName}
          value={content.name}
        />
        <Row
          label={m.common_type()}
          labelClassName={labelClassName}
          value={content.kind.toUpperCase()}
        />
        {content.sizeBytes !== undefined && (
          <Row
            label={m.common_size()}
            labelClassName={labelClassName}
            value={formatFileSize(content.sizeBytes)}
          />
        )}
        {file && (
          <Row
            label={m.common_status()}
            labelClassName={labelClassName}
            value={content.status ?? 'ready'}
          />
        )}
        {content.nodeCount !== undefined && (
          <Row
            label={m.content_nodes()}
            labelClassName={labelClassName}
            value={String(content.nodeCount)}
          />
        )}
        {content.maxDepth !== undefined && (
          <Row
            label={m.content_max_depth()}
            labelClassName={labelClassName}
            value={String(content.maxDepth)}
          />
        )}
        <Row
          label={file ? m.common_added() : m.common_created()}
          labelClassName={labelClassName}
          value={new Date(content.createdAt).toLocaleString()}
        />
      </dl>
    </SimpleDialog>
  );
}

function Row({
  label,
  labelClassName,
  value,
}: {
  label: string;
  labelClassName: string;
  value: string;
}) {
  return (
    <>
      <p className={cn(labelClassName)}>{label}</p>
      <p className="truncate">{value}</p>
    </>
  );
}
