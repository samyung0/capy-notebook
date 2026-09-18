import { type ReactNode, useRef, useState } from 'react';
import {
  useChapters,
  useCreateNote,
  useDeleteChapter,
  useDeleteMaterial,
  useFiles,
  useMaterials,
  useMoveMaterial,
  useReorderChapters,
  useReorderContent,
} from '@/api/hooks';
import type {
  Chapter,
  ContentOrderItem,
  MaterialRef,
  MaterialRefType,
  SourceFile,
} from '@/api/types';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { SkeletonList } from '@/components/ui/feedback';
import { HoverActions } from '@/components/ui/HoverActions';
import { Icon } from '@/components/ui/Icon';
import { FileListItem } from '@/features/files/FileListItem';
import { fileIsIngesting } from '@/features/files/fileUtils';
import { MaterialListItem } from '@/features/materials/MaterialListItem';
import type { OpenItem } from '@/features/materials/openItem';
import type { GenerateMode } from '@/features/workspace/GenerateFormDialog';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { TabAction } from './PanelTabRow';

const GENERATING_MATERIAL: Record<
  GenerateMode,
  { type: MaterialRefType; title: () => string }
> = {
  diagram: { title: m.generating_diagram, type: 'diagram' },
  flashcards: { title: m.generating_flashcards, type: 'flashcards' },
  mindmap: { title: m.generating_mindmap, type: 'mindmap' },
  quiz: { title: m.generating_quiz, type: 'quiz' },
};

type WorkspaceContentItem =
  | {
      type: 'file';
      id: string;
      position: number;
      createdAt: string;
      data: SourceFile;
    }
  | {
      type: 'material';
      id: string;
      position: number;
      createdAt: string;
      data: MaterialRef;
    };

// Native drag-and-drop: rows expose their content type and id. Drops on a
// content row insert before/after that row; the Others bucket appends.
const DND_TYPES = ['application/x-capy-material', 'application/x-capy-file'];

/** The chapter tree with its files and materials. Lives in the right panel's
 * Files tab, as its own column when pinned, or in the drawer on small screens;
 * `renderTabRow` draws whichever header that placement needs. */
export function FilesPanel({
  workspaceId,
  readOnly,
  openItem,
  onOpenItem,
  generating,
  beforeReplace,
  onRenameChapter,
  renderTabRow,
}: {
  workspaceId: string;
  readOnly: boolean;
  openItem: OpenItem | null;
  onOpenItem: (item: OpenItem | null) => void;
  generating: GenerateMode | null;
  /** Office edit guard: returning false keeps the current viewer. */
  beforeReplace: () => boolean;
  onRenameChapter: (chapter: Chapter) => void;
  renderTabRow: (actions: TabAction[]) => ReactNode;
}) {
  const { data: chapters } = useChapters(workspaceId);
  const { data: files } = useFiles(workspaceId);
  const { data: materials } = useMaterials(workspaceId);
  const { mutate: reorder } = useReorderChapters(workspaceId);
  const { mutate: delChapter } = useDeleteChapter(workspaceId);
  const { mutate: delMaterial } = useDeleteMaterial(workspaceId);
  const { mutate: moveMaterial } = useMoveMaterial(workspaceId);
  const { mutate: reorderContent } = useReorderContent(workspaceId);
  const { mutate: createNote } = useCreateNote(workspaceId);

  const [openChapters, setOpenChapters] = useState<Record<string, boolean>>({});
  // Drop-target line while dragging workspace content.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [insertTarget, setInsertTarget] = useState<{
    key: string;
    edge: 'before' | 'after';
  } | null>(null);
  const draggedItemRef = useRef<ContentOrderItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MaterialRef | null>(null);

  const unfiled = files?.filter((f) => f.chapterId === null) ?? [];
  const unfiledMaterials =
    materials?.filter((mt) => mt.chapterId == null) ?? [];

  function contentFor(chapterId: string | null): WorkspaceContentItem[] {
    const chapterFiles =
      files?.filter((file) => file.chapterId === chapterId) ?? [];
    const chapterMaterials =
      materials?.filter((material) => material.chapterId === chapterId) ?? [];
    return [
      ...chapterFiles.map(
        (file): WorkspaceContentItem => ({
          createdAt: file.addedAt,
          data: file,
          id: file.id,
          position: file.position,
          type: 'file',
        })
      ),
      ...chapterMaterials.map(
        (material): WorkspaceContentItem => ({
          createdAt: material.createdAt,
          data: material,
          id: material.id,
          position: material.position,
          type: 'material',
        })
      ),
    ].sort((a, b) => {
      const positionDiff = a.position - b.position;
      if (positionDiff) return positionDiff;
      if (a.type !== b.type) return a.type === 'file' ? -1 : 1;
      return +new Date(b.createdAt) - +new Date(a.createdAt);
    });
  }

  function hasDraggedContent(e: React.DragEvent) {
    return (
      draggedItemRef.current !== null ||
      DND_TYPES.some((type) => Array.from(e.dataTransfer.types).includes(type))
    );
  }
  function draggedContent(e: React.DragEvent): ContentOrderItem | null {
    if (draggedItemRef.current) return draggedItemRef.current;
    const materialId = e.dataTransfer.getData('application/x-capy-material');
    if (materialId) return { id: materialId, type: 'material' };
    const fileId = e.dataTransfer.getData('application/x-capy-file');
    if (fileId) return { id: fileId, type: 'file' };
    return null;
  }
  function clearDragState() {
    draggedItemRef.current = null;
    setDropTarget(null);
    setInsertTarget(null);
  }
  function moveContent(
    dragged: ContentOrderItem,
    chapterId: string | null,
    targetIndex: number
  ) {
    const items = contentFor(chapterId)
      .map(({ id, type }) => ({ id, type }))
      .filter((item) => item.id !== dragged.id || item.type !== dragged.type);
    items.splice(Math.max(0, Math.min(targetIndex, items.length)), 0, dragged);
    reorderContent({ chapterId, items });
    if (chapterId)
      setOpenChapters((state) => ({ ...state, [chapterId]: true }));
  }
  function onItemDrop(chapterId: string | null, e: React.DragEvent) {
    if (readOnly) return;
    e.preventDefault();
    const dragged = draggedContent(e);
    clearDragState();
    if (dragged) moveContent(dragged, chapterId, contentFor(chapterId).length);
  }
  function dropZone(key: string, chapterId: string | null) {
    if (readOnly) return {};
    return {
      onDragLeave: (e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node))
          setDropTarget((t) => (t === key ? null : t));
      },
      onDragOver: (e: React.DragEvent) => {
        if (hasDraggedContent(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (dropTarget !== key) setDropTarget(key);
          setInsertTarget(null);
        }
      },
      onDrop: (e: React.DragEvent) => onItemDrop(chapterId, e),
    };
  }
  function contentDropZone(
    item: WorkspaceContentItem,
    chapterId: string | null
  ) {
    const key = `${item.type}:${item.id}`;
    if (readOnly) return {};
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!hasDraggedContent(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        const rect = e.currentTarget.getBoundingClientRect();
        const edge =
          e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
        setDropTarget(null);
        setInsertTarget((current) =>
          current?.key === key && current.edge === edge
            ? current
            : { edge, key }
        );
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const dragged = draggedContent(e);
        clearDragState();
        if (dragged) {
          if (dragged.id === item.id && dragged.type === item.type) return;
          const destination = contentFor(chapterId).filter(
            (content) =>
              content.id !== dragged.id || content.type !== dragged.type
          );
          const targetIndex = destination.findIndex(
            (content) => content.id === item.id && content.type === item.type
          );
          const rect = e.currentTarget.getBoundingClientRect();
          const edge =
            e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
          const insertionIndex =
            targetIndex < 0
              ? destination.length
              : targetIndex + (edge === 'after' ? 1 : 0);
          moveContent(dragged, chapterId, insertionIndex);
        }
      },
    };
  }
  function contentListDropZone() {
    if (readOnly) return {};
    return {
      onDragOverCapture: (e: React.DragEvent) => {
        if (!hasDraggedContent(e)) return;
        const target = e.target as HTMLElement;
        if (!target.closest('[data-workspace-content-row]')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      },
      onDropCapture: (e: React.DragEvent) => {
        const target = e.target as HTMLElement;
        if (
          hasDraggedContent(e) &&
          target.closest('[data-workspace-content-row]')
        ) {
          e.preventDefault();
        }
      },
    };
  }
  const isFileActive = (id: string) =>
    openItem?.kind === 'file' && openItem.id === id;
  function onFileDeleted(id: string) {
    if (isFileActive(id)) onOpenItem(null);
  }
  function renderMaterial(mt: MaterialRef) {
    return (
      <MaterialListItem
        active={openItem?.kind === 'material' && openItem.id === mt.id}
        chapters={chapters ?? []}
        color="purple"
        data={mt}
        key={`${mt.type}:${mt.id}`}
        onDelete={readOnly ? undefined : () => setPendingDelete(mt)}
        onMove={(chapterId) => moveMaterial({ chapterId, id: mt.id })}
        onOpen={() => onOpenItem({ id: mt.id, kind: 'material' })}
        readOnly={readOnly}
        workspaceId={workspaceId}
      />
    );
  }
  function renderContentItem(
    item: WorkspaceContentItem,
    chapterId: string | null
  ) {
    const key = `${item.type}:${item.id}`;
    const draggable =
      !readOnly && !(item.type === 'file' && fileIsIngesting(item.data.status));
    return (
      <div
        key={key}
        {...contentDropZone(item, chapterId)}
        className="relative"
        data-workspace-content-row
        draggable={draggable}
        onDragEnd={clearDragState}
        onDragStart={(e) => {
          const dragged: ContentOrderItem = { id: item.id, type: item.type };
          draggedItemRef.current = dragged;
          e.dataTransfer.setData(
            item.type === 'file'
              ? 'application/x-capy-file'
              : 'application/x-capy-material',
            item.id
          );
          e.dataTransfer.effectAllowed = 'move';
        }}
      >
        {insertTarget?.key === key && (
          <div
            className={cn(
              'pointer-events-none absolute right-1 left-1 z-10 h-0 border-line-strong border-t-2',
              insertTarget.edge === 'before' ? 'top-0' : 'bottom-0'
            )}
          />
        )}
        {item.type === 'file' ? (
          <FileListItem
            active={isFileActive(item.id)}
            beforeDelete={isFileActive(item.id) ? beforeReplace : undefined}
            chapters={chapters}
            color="purple"
            file={item.data}
            onDeleted={onFileDeleted}
            onOpen={(id) => onOpenItem({ id, kind: 'file' })}
            readOnly={readOnly}
            workspaceId={workspaceId}
          />
        ) : (
          renderMaterial(item.data)
        )}
      </div>
    );
  }
  function moveChapter(idx: number, dir: -1 | 1) {
    if (!chapters) return;
    const ids = chapters.map((c) => c.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    reorder(ids);
  }

  const actions: TabAction[] = [
    ...(readOnly
      ? []
      : [
          {
            icon: 'newNote' as const,
            label: m.workspace_new_note(),
            onClick: () =>
              createNote(
                {},
                {
                  onSuccess: (mt) =>
                    onOpenItem({ id: mt.id, kind: 'material' }),
                }
              ),
          },
        ]),
    {
      icon: 'folderCollapse',
      label: m.workspace_collapse_chapters(),
      onClick: () =>
        setOpenChapters(
          Object.fromEntries((chapters ?? []).map((c) => [c.id, false]))
        ),
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {renderTabRow(actions)}
      <div className="min-h-0 flex-1 overflow-auto px-2.5 pb-2">
        {!chapters && (
          <SkeletonList className="px-1.5 py-2" count={5} rowHeight={36} />
        )}
        {chapters && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col">
              {chapters.map((ch, idx) => {
                const expanded = openChapters[ch.id] ?? true;
                return (
                  <div className="rounded-button" key={ch.id}>
                    <div className="group relative flex items-center rounded-button py-1.5 pr-1.5 hover:bg-surface-hover-bg">
                      <button
                        aria-expanded={expanded}
                        className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 text-left"
                        onClick={() =>
                          setOpenChapters((s) => ({
                            ...s,
                            [ch.id]: !expanded,
                          }))
                        }
                        type="button"
                      >
                        <Icon
                          className="shrink-0 text-fg-muted"
                          name={expanded ? 'chevronDown' : 'chevronRight'}
                          size={13}
                        />
                        <Icon
                          className="shrink-0 text-fg-secondary"
                          name="archive"
                          size={15}
                        />
                        <span className="line-clamp-1 translate-y-px truncate font-semibold">
                          {ch.name}
                        </span>
                        {!expanded && (
                          <span className="ml-auto pr-1 font-semibold text-fg-muted text-xs">
                            {contentFor(ch.id).length}
                          </span>
                        )}
                      </button>
                      {!readOnly && (
                        <HoverActions
                          className="absolute top-1/2 right-1 -translate-y-1/2"
                          items={[
                            {
                              icon: 'write',
                              label: m.action_rename(),
                              onClick: () => onRenameChapter(ch),
                            },
                            {
                              disabled: idx === 0,
                              icon: 'chevronUp',
                              label: m.workspace_move_up(),
                              onClick: () => moveChapter(idx, -1),
                            },
                            {
                              disabled: idx === chapters.length - 1,
                              icon: 'chevronDown',
                              label: m.workspace_move_down(),
                              onClick: () => moveChapter(idx, 1),
                            },
                            {
                              danger: true,
                              icon: 'trash',
                              label: m.action_delete(),
                              onClick: () => delChapter(ch.id),
                            },
                          ]}
                        />
                      )}
                    </div>
                    {expanded && (
                      <div
                        {...contentListDropZone()}
                        className="flex flex-col pl-5"
                      >
                        {contentFor(ch.id).map((item) =>
                          renderContentItem(item, ch.id)
                        )}
                        {contentFor(ch.id).length === 0 && (
                          <p className="px-1.5 py-1 pl-2 font-semibold text-fg-muted text-xs">
                            {m.common_empty()}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {(unfiled.length > 0 ||
              unfiledMaterials.length > 0 ||
              generating) && (
              <div className="rounded-button">
                <div
                  className={cn(
                    't-label px-1.5 py-1.5 text-fg-muted',
                    dropTarget === 'unfiled-files' &&
                      'border-line-strong border-b-2'
                  )}
                >
                  {m.nav_section_others()}
                </div>
                <div {...dropZone('unfiled-files', null)}>
                  {contentFor(null).map((item) =>
                    renderContentItem(item, null)
                  )}
                  {generating && (
                    <MaterialListItem
                      active={false}
                      chapters={chapters}
                      color="purple"
                      data={{
                        chapterId: null,
                        createdAt: new Date().toISOString(),
                        id: '__generating__',
                        maxDepth: 0,
                        nodeCount: 0,
                        position: Number.MAX_SAFE_INTEGER,
                        sizeBytes: 0,
                        title: GENERATING_MATERIAL[generating].title(),
                        type: GENERATING_MATERIAL[generating].type,
                      }}
                      generating
                      onOpen={() => {}}
                      readOnly
                      workspaceId={workspaceId}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <ConfirmDialog
        body={m.confirm_delete_body()}
        danger
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          const id = pendingDelete.id;
          delMaterial(id, {
            onSuccess: () => {
              if (openItem?.kind === 'material' && openItem.id === id) {
                onOpenItem(null);
              }
            },
          });
        }}
        open={!!pendingDelete}
        title={m.confirm_delete_title({ name: pendingDelete?.title ?? '' })}
      />
    </div>
  );
}
