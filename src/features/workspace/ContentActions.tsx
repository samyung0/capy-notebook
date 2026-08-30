import { useState } from 'react';
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
import type {
  Chapter,
  Material,
  MaterialRef,
  SourceFile,
  UserColor,
} from '@/api/types';
import { ConfirmDialog, SimpleDialog } from '@/components/ui/Dialog';
import { HoverActions } from '@/components/ui/HoverActions';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { NameFormDialog } from '@/components/ui/NameFormDialog';
import { formatFileSize } from '@/features/files/fileUtils';
import { MoveToChapterDialog } from '@/features/workspace/MoveToChapterDialog';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

export interface ContentActionTarget {
  chapterId: string | null;
  createdAt: string;
  id: string;
  kind: string;
  maxDepth?: number;
  name: string;
  nodeCount?: number;
  revision?: number;
  sizeBytes?: number;
  status?: SourceFile['status'];
  type: 'file' | 'material';
}

export function toFileActionTarget(file: SourceFile): ContentActionTarget {
  return {
    chapterId: file.chapterId,
    createdAt: file.addedAt,
    id: file.id,
    kind: file.kind,
    name: file.name,
    sizeBytes: file.sizeBytes,
    status: file.status,
    type: 'file',
  };
}

export function toMaterialActionTarget(
  material: Material | MaterialRef
): ContentActionTarget {
  return {
    chapterId: material.chapterId,
    createdAt: material.createdAt,
    id: material.id,
    kind: 'type' in material ? material.type : material.kind,
    maxDepth: material.maxDepth,
    name: material.title,
    nodeCount: material.nodeCount,
    revision: material.revision,
    type: 'material',
  };
}

export function ContentActions({
  beforeDelete,
  chapters,
  color,
  content,
  display,
  hoverClassName,
  includeDelete = true,
  leadingItems = [],
  menuIconContainerClassName,
  onDeleted,
  onMove,
  onRequestDelete,
  propertiesClassName = 'grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm',
  propertyLabelClassName = 'text-fg-muted',
  renameFieldLabel,
  renameTitle,
  readOnly = false,
  workspaceId,
}: {
  beforeDelete?: () => boolean;
  chapters: Chapter[];
  color?: UserColor;
  content?: ContentActionTarget;
  display: 'hover' | 'menu';
  hoverClassName?: string;
  includeDelete?: boolean;
  leadingItems?: MenuItem[];
  menuIconContainerClassName?: string;
  onDeleted?: () => void;
  onMove?: (chapterId: string | null) => void;
  onRequestDelete?: () => void;
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

  const items: MenuItem[] = [
    ...leadingItems,
    ...(!readOnly && content
      ? [
          {
            icon: 'write' as const,
            label: m.action_rename(),
            onClick: () => {
              setRenameOpen(true);
            },
          },
          {
            icon: 'files' as const,
            label: m.content_move_file(),
            onClick: () => setMoveOpen(true),
          },
          {
            icon: 'help' as const,
            label: m.content_properties(),
            onClick: () => setPropertiesOpen(true),
          },
          ...(includeDelete
            ? [
                {
                  danger: true,
                  icon: 'trash' as const,
                  label: m.action_delete(),
                  onClick: onRequestDelete ?? (() => setConfirmOpen(true)),
                },
              ]
            : []),
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
        patch: {
          expectedRevision: content.revision,
          title: nextName,
        },
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
      {!readOnly && display === 'hover' && (
        <HoverActions className={hoverClassName} items={items} />
      )}
      {display === 'menu' && (
        <Menu
          iconContainerClassName={menuIconContainerClassName}
          items={items}
        />
      )}

      {content && (
        <>
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

          <SimpleDialog
            onClose={() => setPropertiesOpen(false)}
            open={propertiesOpen}
            title={m.content_properties_title({
              kind:
                content.type === 'file' ? m.common_file() : m.common_material(),
            })}
          >
            <dl className={propertiesClassName}>
              <Row
                label={m.common_name()}
                labelClassName={propertyLabelClassName}
                value={content.name}
              />
              <Row
                label={m.common_type()}
                labelClassName={propertyLabelClassName}
                value={content.kind.toUpperCase()}
              />
              {content.type === 'file' ? (
                <>
                  <Row
                    label={m.common_size()}
                    labelClassName={propertyLabelClassName}
                    value={formatFileSize(content.sizeBytes ?? 0)}
                  />
                  <Row
                    label={m.common_status()}
                    labelClassName={propertyLabelClassName}
                    value={content.status ?? 'ready'}
                  />
                  <Row
                    label={m.common_added()}
                    labelClassName={propertyLabelClassName}
                    value={new Date(content.createdAt).toLocaleString()}
                  />
                </>
              ) : (
                <>
                  <Row
                    label={m.content_nodes()}
                    labelClassName={propertyLabelClassName}
                    value={String(content.nodeCount ?? '--')}
                  />
                  <Row
                    label={m.content_max_depth()}
                    labelClassName={propertyLabelClassName}
                    value={String(content.maxDepth ?? '--')}
                  />
                  <Row
                    label={m.common_created()}
                    labelClassName={propertyLabelClassName}
                    value={new Date(content.createdAt).toLocaleString()}
                  />
                </>
              )}
            </dl>
          </SimpleDialog>

          {includeDelete && !onRequestDelete && (
            <ConfirmDialog
              body={m.confirm_delete_body()}
              onClose={() => setConfirmOpen(false)}
              onConfirm={() => {
                if (deleteContent()) setConfirmOpen(false);
              }}
              open={confirmOpen}
              title={m.confirm_delete_title({ name: content.name })}
            />
          )}

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
