import { type MouseEvent, type ReactNode, useRef, useState } from 'react';
import {
  useDeleteTopic,
  useFiles,
  useMaterials,
  useMoveMaterial,
  useReorderContent,
  useReorderTopics,
  useRetryFileProcessing,
  useRetryingFileIds,
  useTopics,
  useWorkspace,
} from '@/api/hooks';
import type {
  ContentOrderItem,
  MaterialRef,
  MaterialRefType,
  Topic,
} from '@/api/types';
import { SkeletonList } from '@/components/ui/feedback';
import { HoverActions } from '@/components/ui/HoverActions';
import { Icon } from '@/components/ui/Icon';
import { FileListItem } from '@/features/files/FileListItem';
import { fileCanMoveTo, fileIsIngesting } from '@/features/files/fileUtils';
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
// content row insert before/after that row; topic and tree backgrounds append.
const isTopicMap = (value: unknown): value is Record<string, boolean> =>
  typeof value === 'object' &&
  value !== null &&
  Object.values(value).every((open) => typeof open === 'boolean');

const DND_TYPES = ['application/x-capy-material', 'application/x-capy-file'];

/** The topic tree with its files and materials. Lives in the right panel's
 * Files tab, as its own column when pinned, or in the header's dropdown below lg;
 * `renderTabRow` draws whichever header that placement needs. */
export function FilesPanel({
  workspaceId,
  readOnly,
  openItem,
  onOpenItem,
  onNavigate,
  generating,
  onRenameTopic,
  onAddSource,
  onAddTopic,
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
  onRenameTopic: (topic: Topic) => void;
  /** The New file or topic row under the search; left out where adding is
   * not allowed. */
  onAddSource?: (mode: AddSourceMode) => void;
  onAddTopic?: () => void;
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
  const { data: topics } = useTopics(workspaceId);
  const { data: files } = useFiles(workspaceId);
  const { data: workspace } = useWorkspace(workspaceId, {
    errorBoundary: false,
  });
  const { data: materials } = useMaterials(workspaceId);
  const { mutate: reorder } = useReorderTopics(workspaceId);
  // One Retry processing mutation for every row.
  const { mutateAsync: retryProcessing } = useRetryFileProcessing(workspaceId);
  const retryingIds = useRetryingFileIds(workspaceId);
  const { mutate: delTopic } = useDeleteTopic(workspaceId);
  const { mutate: moveMaterial } = useMoveMaterial(workspaceId);
  const { mutate: reorderContent } = useReorderContent(workspaceId);

  // Topics start open; the ones this viewer closed stay closed per workspace.
  const [openTopics, setOpenTopics] = useLocalPref(
    PREF_KEYS.openTopics(workspaceId),
    {},
    isTopicMap
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
  const draggedTopicRef = useRef<string | null>(null);

  const unfiled = files?.filter((f) => f.topicId === null) ?? [];
  const unfiledMaterials = materials?.filter((mt) => mt.topicId == null) ?? [];

  function contentFor(topicId: string | null): WorkspaceContentItem[] {
    return sharedContentFor(files, materials, topicId);
  }
  // While searching: the rows whose name matches, or a matching topic's
  // every row; topics without either hide and the rest show open.
  function shownFor(topic: Topic | null): WorkspaceContentItem[] {
    const items = contentFor(topic?.id ?? null);
    if (!searching || (topic && matchesSearch(topic.name, query))) return items;
    return items.filter((item) =>
      matchesSearch(
        item.type === 'file' ? item.data.name : item.data.title,
        query
      )
    );
  }
  const shownTopics = searching
    ? topics?.filter(
        (ch) => matchesSearch(ch.name, query) || shownFor(ch).length > 0
      )
    : topics;
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
    draggedTopicRef.current = null;
    setDropTarget(null);
    setInsertTarget(null);
  }
  function moveContent(
    dragged: ContentOrderItem,
    topicId: string | null,
    targetIndex: number
  ) {
    const items = contentFor(topicId)
      .map(({ id, type }) => ({ id, type }))
      .filter((item) => item.id !== dragged.id || item.type !== dragged.type);
    items.splice(Math.max(0, Math.min(targetIndex, items.length)), 0, dragged);
    reorderContent({ items, topicId });
    if (topicId) setOpenTopics({ ...openTopics, [topicId]: true });
  }
  function onItemDrop(topicId: string | null, e: React.DragEvent) {
    if (readOnly || !hasDraggedContent(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const dragged = draggedContent(e);
    clearDragState();
    if (dragged) moveContent(dragged, topicId, contentFor(topicId).length);
  }
  function dropZone(key: string, topicId: string | null) {
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
      onDrop: (e: React.DragEvent) => onItemDrop(topicId, e),
    };
  }
  function contentDropZone(item: WorkspaceContentItem, topicId: string | null) {
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
          const destination = contentFor(topicId).filter(
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
          moveContent(dragged, topicId, insertionIndex);
        }
      },
    };
  }
  function topicDropZone(topic: Topic) {
    const key = `topic:${topic.id}`;
    const contentZone = dropZone(key, topic.id);
    if (readOnly) return {};
    return {
      ...contentZone,
      onDragOver: (e: React.DragEvent) => {
        if (!draggedTopicRef.current) return contentZone.onDragOver?.(e);
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
        const dragged = draggedTopicRef.current;
        if (!dragged) return contentZone.onDrop?.(e);
        e.preventDefault();
        e.stopPropagation();
        clearDragState();
        if (dragged === topic.id || !topics) return;
        const ids = topics.map((ch) => ch.id).filter((id) => id !== dragged);
        const rect = e.currentTarget.getBoundingClientRect();
        const after = e.clientY >= rect.top + rect.height / 2;
        ids.splice(ids.indexOf(topic.id) + (after ? 1 : 0), 0, dragged);
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
    onNavigate();
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
        color="purple"
        data={mt}
        key={`${mt.type}:${mt.id}`}
        menu={rowMenus}
        onDeleted={() => {
          if (openItem?.kind === 'material' && openItem.id === mt.id) {
            onOpenItem(null);
          }
        }}
        onMove={(topicId) => moveMaterial({ id: mt.id, topicId })}
        onOpen={openLink}
        readOnly={readOnly}
        study={studyRow({ id: mt.id, kind: 'material' })}
        topics={topics ?? []}
        workspaceId={workspaceId}
      />
    );
  }
  function renderContentItem(
    item: WorkspaceContentItem,
    topicId: string | null
  ) {
    const key = `${item.type}:${item.id}`;
    const draggable =
      !readOnly && !(item.type === 'file' && fileIsIngesting(item.data.status));
    return (
      <div
        key={key}
        {...contentDropZone(item, topicId)}
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
            canClone={!!workspace?.canClone}
            canMoveTo={fileCanMoveTo(item.data, workspace)}
            color="purple"
            file={item.data}
            menu={rowMenus}
            onDeleted={onFileDeleted}
            onOpen={openLink}
            readOnly={readOnly}
            retry={workspace?.isOwner ? retryProcessing : undefined}
            retryPending={retryingIds.includes(item.id)}
            study={studyRow({ id: item.id, kind: 'file' })}
            topics={topics}
            workspaceId={workspaceId}
          />
        ) : (
          renderMaterial(item.data)
        )}
      </div>
    );
  }
  function moveTopic(idx: number, dir: -1 | 1) {
    if (!topics) return;
    const ids = topics.map((c) => c.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    reorder(ids);
  }

  // Collapses all topics, or expands them all once every one is collapsed.
  const allCollapsed =
    !!topics?.length && topics.every((c) => openTopics[c.id] === false);
  const actions: TabAction[] = [
    {
      icon: allCollapsed ? 'folderExpand' : 'folderCollapse',
      label: allCollapsed
        ? m.workspace_expand_topics()
        : m.workspace_collapse_topics(),
      onClick: () =>
        setOpenTopics(
          Object.fromEntries((topics ?? []).map((c) => [c.id, allCollapsed]))
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
            label={m.action_new_file_or_topic()}
            menu={addSourceMenuItems(onAddSource, onAddTopic)}
          />
        </div>
      )}
      <div
        {...dropZone('unfiled-files', null)}
        className="scroll-fade-y min-h-0 flex-1 overflow-auto px-2.5 pb-(--scroll-fade-bottom-padding) [--scroll-fade-bottom-padding:--spacing(2)]"
        data-workspace-file-tree
      >
        {header}
        {!topics && (
          <SkeletonList className="px-1.5 py-2" count={5} rowHeight={36} />
        )}
        {searching && !shownTopics?.length && !shownUnfiled.length && (
          <p className="px-2 py-1.5 text-fg-muted text-sm">
            {m.workspace_no_files_match()}
          </p>
        )}
        {topics && shownTopics && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col empty:hidden">
              {shownTopics.map((ch) => {
                const idx = topics.indexOf(ch);
                const expanded = searching || (openTopics[ch.id] ?? true);
                return (
                  <div
                    {...topicDropZone(ch)}
                    className={cn(
                      'relative rounded-button',
                      dropTarget === `topic:${ch.id}` && 'bg-tint-accent-1/70'
                    )}
                    data-workspace-topic={ch.id}
                    key={ch.id}
                  >
                    {insertionLine(`topic:${ch.id}`)}
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
                        draggedTopicRef.current = ch.id;
                        e.dataTransfer.setData(
                          'application/x-capy-topic',
                          ch.id
                        );
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                    >
                      <button
                        aria-expanded={expanded}
                        className="flex min-w-0 flex-1 items-center gap-2 px-1.5 text-left"
                        onClick={() =>
                          setOpenTopics({
                            ...openTopics,
                            [ch.id]: !expanded,
                          })
                        }
                        type="button"
                      >
                        <Icon
                          className="shrink-0 text-fg-secondary"
                          name="topic"
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
                              onClick: () => onRenameTopic(ch),
                            },
                            {
                              disabled: idx === 0,
                              icon: 'chevronUp',
                              label: m.workspace_move_up(),
                              onClick: () => moveTopic(idx, -1),
                            },
                            {
                              disabled: idx === topics.length - 1,
                              icon: 'chevronDown',
                              label: m.workspace_move_down(),
                              onClick: () => moveTopic(idx, 1),
                            },
                            {
                              danger: true,
                              icon: 'trash',
                              label: m.action_delete(),
                              onClick: () => delTopic(ch.id),
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
                {topics.length > 0 && (
                  <div className="t-label px-1.5 py-1.5 text-fg-muted">
                    {m.nav_section_others()}
                  </div>
                )}
                <div>
                  {shownUnfiled.map((item) => renderContentItem(item, null))}
                  {generating && (
                    <MaterialListItem
                      active={false}
                      color="purple"
                      data={{
                        createdAt: new Date().toISOString(),
                        id: '__generating__',
                        maxDepth: 0,
                        nodeCount: 0,
                        position: Number.MAX_SAFE_INTEGER,
                        sizeBytes: 0,
                        title: GENERATING_MATERIAL[generating].title(),
                        topicId: null,
                        type: GENERATING_MATERIAL[generating].type,
                      }}
                      generating
                      readOnly
                      topics={topics}
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
