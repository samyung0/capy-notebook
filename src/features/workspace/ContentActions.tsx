import { useState } from 'react';
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
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, SimpleDialog } from '@/components/ui/Dialog';
import { HoverActions } from '@/components/ui/HoverActions';
import { Input, InputTitle } from '@/components/ui/Input';
import { Menu, type MenuItem } from '@/components/ui/Menu';
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
    type: 'material',
  };
}

export function ContentActions({
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
  renameTitle = 'Rename',
  readOnly = false,
  workspaceId,
}: {
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
  const { mutate: updateFile } = useUpdateFile(workspaceId);
  const { mutate: moveFile } = useMoveFile(workspaceId);
  const { mutate: deleteFile } = useDeleteFile(workspaceId);
  const { mutate: updateMaterial } = useUpdateMaterial(workspaceId);
  const { mutate: moveMaterial } = useMoveMaterial(workspaceId);
  const { mutate: deleteMaterial } = useDeleteMaterial(workspaceId);

  const [renameOpen, setRenameOpen] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [name, setName] = useState(content?.name ?? '');

  const items: MenuItem[] = [
    ...leadingItems,
    ...(!readOnly && content
      ? [
          {
            icon: 'write' as const,
            label: m.action_rename(),
            onClick: () => {
              setName(content.name);
              setRenameOpen(true);
            },
          },
          {
            icon: 'files' as const,
            label: 'Move File',
            onClick: () => setMoveOpen(true),
          },
          {
            icon: 'help' as const,
            label: 'Properties',
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

  const saveName = () => {
    const nextName = name.trim();
    if (content && nextName) {
      if (content.type === 'file') {
        updateFile({ id: content.id, name: nextName });
      } else {
        updateMaterial({ id: content.id, patch: { title: nextName } });
      }
    }
    setRenameOpen(false);
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
    if (!content) return;
    if (content.type === 'file') {
      deleteFile(content.id);
    } else {
      deleteMaterial(content.id);
    }
    onDeleted?.();
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
          <SimpleDialog
            footer={
              <>
                <Button
                  onClick={() => setRenameOpen(false)}
                  size="lg"
                  variant="ghost-hover"
                >
                  Cancel
                </Button>
                <Button onClick={saveName} size="lg">
                  Save
                </Button>
              </>
            }
            onClose={() => setRenameOpen(false)}
            open={renameOpen}
            title={renameTitle}
          >
            {renameFieldLabel ? (
              <label className="flex flex-col gap-1.5">
                <InputTitle>{renameFieldLabel}</InputTitle>
                <Input
                  onChange={(event) => setName(event.target.value)}
                  value={name}
                />
              </label>
            ) : (
              <Input
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            )}
          </SimpleDialog>

          <SimpleDialog
            onClose={() => setPropertiesOpen(false)}
            open={propertiesOpen}
            title={`${content.type === 'file' ? 'File' : 'Material'} properties`}
          >
            <dl className={propertiesClassName}>
              <Row
                label="Name"
                labelClassName={propertyLabelClassName}
                value={content.name}
              />
              <Row
                label="Type"
                labelClassName={propertyLabelClassName}
                value={content.kind.toUpperCase()}
              />
              {content.type === 'file' ? (
                <>
                  <Row
                    label="Size"
                    labelClassName={propertyLabelClassName}
                    value={formatFileSize(content.sizeBytes ?? 0)}
                  />
                  <Row
                    label="Status"
                    labelClassName={propertyLabelClassName}
                    value={content.status ?? 'ready'}
                  />
                  <Row
                    label="Added"
                    labelClassName={propertyLabelClassName}
                    value={new Date(content.createdAt).toLocaleString()}
                  />
                </>
              ) : (
                <>
                  <Row
                    label="Nodes"
                    labelClassName={propertyLabelClassName}
                    value={String(content.nodeCount ?? '--')}
                  />
                  <Row
                    label="Max depth"
                    labelClassName={propertyLabelClassName}
                    value={String(content.maxDepth ?? '--')}
                  />
                  <Row
                    label="Created"
                    labelClassName={propertyLabelClassName}
                    value={new Date(content.createdAt).toLocaleString()}
                  />
                </>
              )}
            </dl>
          </SimpleDialog>

          {includeDelete && !onRequestDelete && (
            <ConfirmDialog
              body={`This removes the ${content.type} from the workspace. This cannot be undone.`}
              onClose={() => setConfirmOpen(false)}
              onConfirm={() => {
                deleteContent();
                setConfirmOpen(false);
              }}
              open={confirmOpen}
              title={`Delete ${content.name}?`}
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
