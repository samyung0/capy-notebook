import { type MouseEvent, type ReactNode, useRef, useState } from 'react';
import {
  useChapters,
  useDeleteChapter,
  useFiles,
  useMaterials,
  useMoveMaterial,
  useReorderChapters,
  useReorderContent,
  useRetryFileProcessing,
  useRetryingFileIds,
  useWorkspace,
} from '@/api/hooks';
import type {
  Chapter,
  ContentOrderItem,
  MaterialRef,
  MaterialRefType,
} from '@/api/types';
import { SkeletonList } from '@/components/ui/feedback';
import { HoverActions } from '@/components/ui/HoverActions';
import { Icon } from '@/components/ui/Icon';
import { FileListItem } from '@/features/files/FileListItem';
import { fileIsIngesting } from '@/features/files/fileUtils';
import { MaterialListItem } from '@/features/materials/MaterialListItem';
import type { OpenItem } from '@/features/materials/openItem';
import {
  type StudyRow,
  type StudyTarget,
  useStudyActions,
  useStudyStates,
} from '@/features/study/studyItems';
import type { GenerateMode } from '@/features/workspace/GenerateForm';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { PREF_KEYS, useLocalPref } from '@/lib/localPrefs';
import type { AddSourceMode } from './AddSourceDialog';
import { addSourceMenuItems } from './addSourceMenuItems';
import { PanelNewRow } from './PanelNewRow';
import { matchesSearch, PanelSearch } from './PanelSearch';
import type { TabAction } from './PanelTabRow';
import {
  contentFor as sharedContentFor,
  type WorkspaceContentItem,
} from './workspaceContent';

const GENERATING_MATERIAL: Record<
  GenerateMode,
  { type: MaterialRefType; title: () => string }
> = {
  diagram: { title: m.generating_diagram, type: 'diagram' },
  flashcards: { title: m.generating_flashcards, type: 'flashcards' },
  mindmap: { title: m.generating_mindmap, type: 'mindmap' },
  quiz: { title: m.generating_quiz, type: 'quiz' },
};

// Native drag-and-drop: rows expose their content type and id. Drops on a
// content row insert before/after that row; chapter and tree backgrounds append.
const isChapterMap = (value: unknown): value is Record<string, boolean> =>
  typeof value === 'object' &&
  value !== null &&
  Object.values(value).every((open) => typeof open === 'boolean');

const DND_TYPES = ['application/x-capy-material', 'application/x-capy-file'];

/** The chapter tree with its files and materials. Lives in the right panel's
 * Files tab, as its own column when pinned, or in the header's dropdown below lg;
 * `renderTabRow` draws whichever header that placement needs. */
export function FilesPanel({
  workspaceId,
  readOnly,
  openItem,
  onOpenItem,
  onNavigate,
  generating,
  beforeReplace,
  onRenameChapter,
  onAddSource,
  onAddChapter,
  renderTabRow,
  header,
  footer,
  className,
  rowMenus = true,
  searchable = false,
}: {
  workspaceId: string;
  readOnly: boolean;
  openItem: OpenItem | null;
  onOpenItem: (item: OpenItem | null) => void;
  onNavigate: () => void;
  generating: GenerateMode | null;
  /** Office edit guard: returning false keeps the current viewer. */
  beforeReplace: () => boolean;
  onRenameChapter: (chapter: Chapter) => void;
  /** The New file or chapter row under the search; left out where adding is
   * not allowed. */
  onAddSource?: (mode: AddSourceMode) => void;
  onAddChapter?: () => void;
  renderTabRow: (actions: TabAction[]) => ReactNode;
  /** The tree's first row, scrolling with it, e.g. the workspace switcher. */
  header?: ReactNode;
  /** Pinned under the tree, e.g. the dropdown's Workspace settings row. */
  footer?: ReactNode;
  className?: string;
  /** Rows' hover ⋮; the dropdown leaves them out. */
  rowMenus?: boolean;
  /** A search above the tree that filters it by name (the side panels). */
  searchable?: boolean;
}) {
  const { data: chapters } = useChapters(workspaceId);
  const { data: files } = useFiles(workspaceId);
  const { data: workspace } = useWorkspace(workspaceId, {
    errorBoundary: false,
  });
  const { data: materials } = useMaterials(workspaceId);
  const { mutate: reorder } = useReorderChapters(workspaceId);
  // One Retry processing mutation for every row.
  const { mutateAsync: retryProcessing } = useRetryFileProcessing(workspaceId);
  const retryingIds = useRetryingFileIds(workspaceId);
  const { mutate: delChapter } = useDeleteChapter(workspaceId);
  const { mutate: moveMaterial } = useMoveMaterial(workspaceId);
  const { mutate: reorderContent } = useReorderContent(workspaceId);

  // Chapters start open; the ones this viewer closed stay closed per workspace.
  const [openChapters, setOpenChapters] = useLocalPref(
    PREF_KEYS.openChapters(workspaceId),
    {},
    isChapterMap
  );
  const [dragging, setDragging] = useState(false);
  // Drop-target line while dragging workspace content.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [insertTarget, setInsertTarget] = useState<{
    key: string;
    edge: 'before' | 'after';
  } | null>(null);
  const [query, setQuery] = useState('');
  const searching = searchable && query.trim() !== '';
  const draggedItemRef = useRef<ContentOrderItem | null>(null);
  const draggedChapterRef = useRef<string | null>(null);

  const unfiled = files?.filter((f) => f.chapterId === null) ?? [];
  const unfiledMaterials =
    materials?.filter((mt) => mt.chapterId == null) ?? [];

  function contentFor(chapterId: string | null): WorkspaceContentItem[] {
    return sharedContentFor(files, materials, chapterId);
  }
  // While searching: the rows whose name matches, or a matching chapter's
  // every row; chapters without either hide and the rest show open.
  function shownFor(chapter: Chapter | null): WorkspaceContentItem[] {
    const items = contentFor(chapter?.id ?? null);
    if (!searching || (chapter && matchesSearch(chapter.name, query)))
      return items;
    return items.filter((item) =>
      matchesSearch(
        item.type === 'file' ? item.data.name : item.data.title,
        query
      )
    );
  }
  const shownChapters = searching
    ? chapters?.filter(
        (ch) => matchesSearch(ch.name, query) || shownFor(ch).length > 0
      )
    : chapters;
  const shownUnfiled = shownFor(null);

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
    if (chapterId) setOpenChapters({ ...openChapters, [chapterId]: true });
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
  function openLink(event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    if (beforeReplace()) onNavigate();
    else event.preventDefault();
  }
  function onFileDeleted(id: string) {
    if (isFileActive(id)) onOpenItem(null);
  }
  // The reader's own progress marks and menu items, while progress is on.
  const { enabled: studying, states } = useStudyStates(workspaceId);
  const { menuItems: studyMenu } = useStudyActions(workspaceId);
  function studyRow(target: StudyTarget): StudyRow | undefined {
    if (!studying) return;
    const state = states.get(target.id);
    return { menuItems: studyMenu(target, state), state };
  }
  function renderMaterial(mt: MaterialRef) {
    return (
      <MaterialListItem
        active={openItem?.kind === 'material' && openItem.id === mt.id}
        canClone={!!workspace?.canClone}
        chapters={chapters ?? []}
        color="purple"
        data={mt}
        key={`${mt.type}:${mt.id}`}
        menu={rowMenus}
        onDeleted={() => {
          if (openItem?.kind === 'material' && openItem.id === mt.id) {
            onOpenItem(null);
          }
        }}
        onMove={(chapterId) => moveMaterial({ chapterId, id: mt.id })}
        onOpen={openLink}
        readOnly={readOnly}
        study={studyRow({ id: mt.id, kind: 'material' })}
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
            canClone={!!workspace?.canClone}
            chapters={chapters}
            color="purple"
            file={item.data}
            menu={rowMenus}
            onDeleted={onFileDeleted}
            onOpen={openLink}
            readOnly={readOnly}
            retry={workspace?.isOwner ? retryProcessing : undefined}
            retryPending={retryingIds.includes(item.id)}
            study={studyRow({ id: item.id, kind: 'file' })}
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

  // Collapses all chapters, or expands them all once every one is collapsed.
  const allCollapsed =
    !!chapters?.length && chapters.every((c) => openChapters[c.id] === false);
  const actions: TabAction[] = [
    {
      icon: allCollapsed ? 'folderExpand' : 'folderCollapse',
      label: allCollapsed
        ? m.workspace_expand_chapters()
        : m.workspace_collapse_chapters(),
      onClick: () =>
        setOpenChapters(
          Object.fromEntries((chapters ?? []).map((c) => [c.id, allCollapsed]))
        ),
    },
  ];

  return (
    <div
      className={cn(
        'group/file-tree relative flex h-full min-h-0 flex-col',
        className,
        dragging && '[&_[data-slot=hover-actions]]:hidden',
        dropTarget === 'unfiled-files' &&
          'outline-2 outline-solid-accent-1 -outline-offset-2'
      )}
      data-dragging={dragging || undefined}
    >
      {renderTabRow(actions)}
      {searchable && (
        <PanelSearch
          label={m.workspace_search_files()}
          onChange={setQuery}
          value={query}
        />
      )}
      {onAddSource && (
        <div className="contents" data-workspace-add-menu>
          <PanelNewRow
            icon="plus"
            label={m.action_new_file_or_chapter()}
            menu={addSourceMenuItems(onAddSource, onAddChapter)}
          />
        </div>
      )}
      <div
        {...dropZone('unfiled-files', null)}
        className="scroll-fade-y min-h-0 flex-1 overflow-auto px-2.5 pb-(--scroll-fade-bottom-padding) [--scroll-fade-bottom-padding:--spacing(2)]"
        data-workspace-file-tree
      >
        {header}
        {!chapters && (
          <SkeletonList className="px-1.5 py-2" count={5} rowHeight={36} />
        )}
        {searching && !shownChapters?.length && !shownUnfiled.length && (
          <p className="px-2 py-1.5 text-fg-muted text-sm">
            {m.workspace_no_files_match()}
          </p>
        )}
        {chapters && shownChapters && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col empty:hidden">
              {shownChapters.map((ch) => {
                const idx = chapters.indexOf(ch);
                const expanded = searching || (openChapters[ch.id] ?? true);
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
                        className="flex min-w-0 flex-1 items-center gap-2 px-1.5 text-left"
                        onClick={() =>
                          setOpenChapters({
                            ...openChapters,
                            [ch.id]: !expanded,
                          })
                        }
                        type="button"
                      >
                        <Icon
                          className="shrink-0 text-fg-secondary"
                          name="chapter"
                          size={15}
                        />
                        <span className="line-clamp-1 translate-y-px truncate font-semibold">
                          {ch.name}
                        </span>
                        {/* Drawn like the workspace picker's chevron above. */}
                        <Icon
                          className="shrink-0 -translate-y-px text-fg-muted"
                          name={expanded ? 'chevronDown' : 'chevronRight'}
                        />
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
                      <div className="flex flex-col pl-3">
                        {shownFor(ch).map((item) =>
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

            {(searching
              ? shownUnfiled.length > 0
              : unfiled.length > 0 ||
                unfiledMaterials.length > 0 ||
                generating) && (
              <div className="rounded-button">
                {chapters.length > 0 && (
                  <div className="t-label px-1.5 py-1.5 text-fg-muted">
                    {m.nav_section_others()}
                  </div>
                )}
                <div>
                  {shownUnfiled.map((item) => renderContentItem(item, null))}
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
      {footer}
    </div>
  );
}
