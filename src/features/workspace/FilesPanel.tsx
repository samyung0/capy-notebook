import { type ReactNode, useRef, useState } from 'react';
import {
  useChapters,
  useDeleteChapter,
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
import { SkeletonList } from '@/components/ui/feedback';
import { HoverActions } from '@/components/ui/HoverActions';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Menu } from '@/components/ui/Menu';
import { FileListItem } from '@/features/files/FileListItem';
import { fileIsIngesting } from '@/features/files/fileUtils';
import { MaterialListItem } from '@/features/materials/MaterialListItem';
import type { OpenItem } from '@/features/materials/openItem';
import type { GenerateMode } from '@/features/workspace/GenerateFormDialog';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { AddSourceMode } from './AddSourceDialog';
import { addSourceMenuItems } from './addSourceMenuItems';
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
// content row insert before/after that row; chapter and tree backgrounds append.
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
  contentClassName,
  onAddSource,
  onAddChapter,
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
  contentClassName?: string;
  onAddSource?: (mode: AddSourceMode) => void;
  onAddChapter?: () => void;
}) {
  const { data: chapters } = useChapters(workspaceId);
  const { data: files } = useFiles(workspaceId);
  const { data: materials } = useMaterials(workspaceId);
  const { mutate: reorder } = useReorderChapters(workspaceId);
  const { mutate: delChapter } = useDeleteChapter(workspaceId);
  const { mutate: moveMaterial } = useMoveMaterial(workspaceId);
  const { mutate: reorderContent } = useReorderContent(workspaceId);

  const [openChapters, setOpenChapters] = useState<Record<string, boolean>>({});
  const [dragging, setDragging] = useState(false);
  // Drop-target line while dragging workspace content.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [insertTarget, setInsertTarget] = useState<{
    key: string;
    edge: 'before' | 'after';
  } | null>(null);
  const draggedItemRef = useRef<ContentOrderItem | null>(null);
  const draggedChapterRef = useRef<string | null>(null);

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
    setDragging(false);
    draggedItemRef.current = null;
    draggedChapterRef.current = null;
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
    if (readOnly || !hasDraggedContent(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const dragged = draggedContent(e);
    clearDragState();
    if (dragged) moveContent(dragged, chapterId, contentFor(chapterId).length);
  }
  function dropZone(key: string, chapterId: string | null) {
    if (readOnly) return {};
    return {
      onDragLeave: (e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setDropTarget((t) => (t === key ? null : t));
          setInsertTarget((t) => (t?.key === key ? null : t));
        }
      },
      onDragOver: (e: React.DragEvent) => {
        if (hasDraggedContent(e)) {
          e.preventDefault();
          e.stopPropagation();
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
      onDragLeave: (e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node))
          setInsertTarget((t) => (t?.key === key ? null : t));
      },
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
        if (!hasDraggedContent(e)) return;
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
  function chapterDropZone(chapter: Chapter) {
    const key = `chapter:${chapter.id}`;
    const contentZone = dropZone(key, chapter.id);
    if (readOnly) return {};
    return {
      ...contentZone,
      onDragOver: (e: React.DragEvent) => {
        if (!draggedChapterRef.current) return contentZone.onDragOver?.(e);
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        setDropTarget(null);
        const rect = e.currentTarget.getBoundingClientRect();
        const edge =
          e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
        setInsertTarget((current) =>
          current?.key === key && current.edge === edge
            ? current
            : { edge, key }
        );
      },
      onDrop: (e: React.DragEvent) => {
        const dragged = draggedChapterRef.current;
        if (!dragged) return contentZone.onDrop?.(e);
        e.preventDefault();
        e.stopPropagation();
        clearDragState();
        if (dragged === chapter.id || !chapters) return;
        const ids = chapters.map((ch) => ch.id).filter((id) => id !== dragged);
        const rect = e.currentTarget.getBoundingClientRect();
        const after = e.clientY >= rect.top + rect.height / 2;
        ids.splice(ids.indexOf(chapter.id) + (after ? 1 : 0), 0, dragged);
        reorder(ids);
      },
    };
  }
  function insertionLine(key: string) {
    return (
      insertTarget?.key === key && (
        <div
          className={cn(
            'pointer-events-none absolute right-1 left-1 z-10 h-0 border-solid-accent-1 border-t-2',
            insertTarget.edge === 'before'
              ? 'top-0 -translate-y-1/2'
              : 'bottom-0 translate-y-1/2'
          )}
        />
      )
    );
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
        onDeleted={() => {
          if (openItem?.kind === 'material' && openItem.id === mt.id) {
            onOpenItem(null);
          }
        }}
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
        data-workspace-content-row={key}
        draggable={draggable}
        onDragEnd={clearDragState}
        onDragStart={(e) => {
          if (!draggable) {
            e.preventDefault();
            return;
          }
          // Plate's window-level HTML5 backend cancels unregistered native drags.
          e.stopPropagation();
          setDragging(true);
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
        {insertionLine(key)}
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
    <div
      className={cn(
        'group/file-tree relative flex h-full min-h-0 flex-col',
        dragging && '[&_[data-slot=hover-actions]]:hidden',
        dropTarget === 'unfiled-files' &&
          'outline-2 outline-solid-accent-1 -outline-offset-2'
      )}
      data-dragging={dragging || undefined}
    >
      {renderTabRow(actions)}
      <div
        {...dropZone('unfiled-files', null)}
        className={cn(
          'scroll-fade-y min-h-0 flex-1 overflow-auto px-2.5 pb-(--scroll-fade-bottom-padding) [--scroll-fade-bottom-padding:--spacing(2)]',
          !readOnly &&
            onAddSource &&
            '[--scroll-fade-bottom-padding:--spacing(20)]',
          contentClassName
        )}
        data-workspace-file-tree
      >
        {!chapters && (
          <SkeletonList className="px-1.5 py-2" count={5} rowHeight={36} />
        )}
        {chapters && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col empty:hidden">
              {chapters.map((ch, idx) => {
                const expanded = openChapters[ch.id] ?? true;
                return (
                  <div
                    {...chapterDropZone(ch)}
                    className={cn(
                      'relative rounded-button',
                      dropTarget === `chapter:${ch.id}` && 'bg-tint-accent-1/70'
                    )}
                    data-workspace-chapter={ch.id}
                    key={ch.id}
                  >
                    {insertionLine(`chapter:${ch.id}`)}
                    <div
                      className="group relative flex items-center rounded-button py-1.5 pr-1.5 hover:bg-surface-hover-bg group-data-[dragging]/file-tree:bg-transparent!"
                      draggable={!readOnly}
                      onDragEnd={clearDragState}
                      onDragStart={(e) => {
                        if (readOnly) {
                          e.preventDefault();
                          return;
                        }
                        e.stopPropagation();
                        setDragging(true);
                        draggedChapterRef.current = ch.id;
                        e.dataTransfer.setData(
                          'application/x-capy-chapter',
                          ch.id
                        );
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                    >
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
                          name="chapter"
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
                      <div className="flex flex-col pl-5">
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
                {chapters.length > 0 && (
                  <div className="t-label px-1.5 py-1.5 text-fg-muted">
                    {m.nav_section_others()}
                  </div>
                )}
                <div>
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
      {!readOnly && onAddSource && (
        <div
          className="absolute right-4 bottom-4 z-10 flex"
          data-workspace-add-menu
        >
          <Menu
            items={addSourceMenuItems(onAddSource, onAddChapter)}
            trigger={
              <IconButton
                className="size-11 rounded-full p-2.5 text-solid-accent-1 active:scale-100"
                icon="plus"
                label={m.action_add_file()}
                strokeWidth={2.2}
                variant="ghost-hover"
              />
            }
            variant="morph"
          />
        </div>
      )}
    </div>
  );
}
