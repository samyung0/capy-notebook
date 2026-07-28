import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { isApiError } from '@/api/client';
import {
  type ContentOrderItem,
  useAddChapter,
  useChapters,
  useCloneWorkspace,
  useCreateNote,
  useDeleteChapter,
  useDeleteMaterial,
  useFiles,
  useIngestProgress,
  useMaterials,
  useMoveMaterial,
  useReorderChapters,
  useReorderContent,
  useReviewMaterialSuggestions,
  useUpdateChapter,
  useUpdateWorkspaceSharing,
  useWorkspace,
} from '@/api/hooks';
import type {
  Chapter,
  MaterialRef,
  MaterialRefType,
  SourceFile,
} from '@/api/types';
import { LoadingLarge } from '@/components/app/LoadingLarge';
import { Panel } from '@/components/app/layout';
import { PrivateOrUnavailable } from '@/components/app/PrivateOrUnavailable';
import { TopInsetBar } from '@/components/app/TopInsetBar';
import {
  Button,
  HoverActions,
  Icon,
  IconButton,
  type IconName,
  SkeletonList,
  Spinner,
  Tabs,
} from '@/components/ui';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/Resizable';
import { userToast } from '@/components/ui/userToast';
import { FileListItem } from '@/features/files/FileListItem';
import { CenterContent } from '@/features/materials/CenterContent';
import {
  type OpenItem,
  openItemFromSearch,
  searchFromOpenItem,
  type WorkspaceOpenSearch,
} from '@/features/materials/openItem';
import {
  canShareWorkspace,
  isWorkspaceReadOnly,
} from '@/features/workspace/access';
import { ChatPanel } from '@/features/workspace/ChatPanel';
import type { GenerateMode } from '@/features/workspace/GenerateFormDialog';
import { GeneratePanel } from '@/features/workspace/GeneratePanel';
import { MoveToChapterDialog } from '@/features/workspace/MoveToChapterDialog';
import { ShareDialog } from '@/features/workspace/ShareDialog';
import { m } from '@/i18n';
import { toastCloneError } from '@/lib/authToasts';
import { cn } from '@/lib/cn';
import { userColorPair } from '@/lib/userColor';
import { usePortals } from '@/stores/portals';

const MATERIAL_ICON: Record<MaterialRefType, IconName> = {
  deck: "flashcards",
  diagram: "diagram",
  mindmap: "workspaces",
  note: "write",
  quiz: "quiz",
};

const GENERATING_MATERIAL: Record<
  GenerateMode,
  { type: MaterialRefType; title: string }
> = {
  diagram: { title: "Generating diagram…", type: "diagram" },
  flashcards: { title: "Generating flashcards…", type: "deck" },
  mindmap: { title: "Generating mindmap…", type: "mindmap" },
  quiz: { title: "Generating quiz…", type: "quiz" },
};

type WorkspaceContentItem =
  | {
      type: "file";
      id: string;
      position?: number;
      createdAt: string;
      data: SourceFile;
    }
  | {
      type: "material";
      id: string;
      position?: number;
      createdAt: string;
      data: MaterialRef;
    };

function MaterialListItem({
  data: matRef,
  active,
  onOpen,
  onDelete,
  chapters,
  onMove,
  generating = false,
  readOnly = false,
}: {
  data: MaterialRef;
  active: boolean;
  onOpen: () => void;
  onDelete?: () => void;
  /** All workspace chapters, for the "Move to…" menu. */
  chapters: Chapter[];
  /** File this material under a chapter (null = unfile). */
  onMove?: (chapterId: string | null) => void;
  generating?: boolean;
  readOnly?: boolean;
}) {
  const [moveOpen, setMoveOpen] = useState(false);
  const reviewSuggestions = useReviewMaterialSuggestions(matRef.id);
  const reviewAll = (decision: "accept" | "reject") => {
    if (
      !window.confirm(
        `${decision === "accept" ? "Accept" : "Reject"} all pending suggestions in "${matRef.title}"?`,
      )
    ) {
      return;
    }
    reviewSuggestions.mutate({ decision });
  };
  const items = [
    {
      icon: "files" as IconName,
      label: "Move file",
      onClick: () => setMoveOpen(true),
    },
    ...(matRef.hasPendingSuggestions
      ? [
          {
            icon: "check" as IconName,
            label: "Accept all suggestions",
            onClick: () => reviewAll("accept"),
          },
          {
            danger: true,
            icon: "x" as IconName,
            label: "Reject all suggestions",
            onClick: () => reviewAll("reject"),
          },
        ]
      : []),
    ...(onDelete
      ? [
          {
            danger: true,
            icon: "trash" as IconName,
            label: m.action_delete(),
            onClick: onDelete,
          },
        ]
      : []),
  ];
  return (
    <div
      className={cn(
        "group relative flex items-center rounded-button hover:bg-surface-hover-bg",
        generating ? "pr-1" : "pr-8",
        active && "bg-surface-hover-bg",
      )}
    >
      <button
        className={cn(
          "flex w-full items-center gap-2 rounded-button px-1.5 py-1.5 text-left",
          active && "font-bold",
        )}
        disabled={generating}
        onClick={onOpen}
        type="button"
      >
        <Icon name={MATERIAL_ICON[matRef.type]} size={15} />
        <span className="line-clamp-2 flex-1 translate-y-px">
          {matRef.title}
        </span>
        {generating && <Spinner className="size-4 shrink-0" />}
      </button>
      {!readOnly && !generating && (
        <>
          <HoverActions
            className="absolute top-1/2 right-1 -translate-y-1/2"
            items={items}
          />
          <MoveToChapterDialog
            chapters={chapters}
            currentChapterId={matRef.chapterId}
            onClose={() => setMoveOpen(false)}
            onSelect={(chapterId) => onMove?.(chapterId)}
            open={moveOpen}
          />
        </>
      )}
    </div>
  );
}

export default function WorkspaceOpen() {
  const params = useParams({ strict: false });
  const workspaceId = (params as { workspaceId: string }).workspaceId;
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as WorkspaceOpenSearch;

  const {
    data: ws,
    isLoading: wsLoading,
    isError: wsError,
    error: wsErr,
  } = useWorkspace(workspaceId);
  const { data: chapters } = useChapters(workspaceId);
  const { data: files } = useFiles(workspaceId);
  const { data: materials } = useMaterials(workspaceId);
  const readOnly = isWorkspaceReadOnly(ws?.capabilities);
  const canShare = canShareWorkspace(ws?.capabilities);
  useIngestProgress(workspaceId, !readOnly);
  const addChapter = useAddChapter(workspaceId);
  const updateChapter = useUpdateChapter(workspaceId);
  const reorder = useReorderChapters(workspaceId);
  const delChapter = useDeleteChapter(workspaceId);
  const delMaterial = useDeleteMaterial(workspaceId);
  const moveMaterial = useMoveMaterial(workspaceId);
  const reorderContent = useReorderContent(workspaceId);
  const createNote = useCreateNote(workspaceId);
  const cloneWorkspace = useCloneWorkspace();
  const updateSharing = useUpdateWorkspaceSharing();
  const openAddSource = usePortals((s) => s.openAddSource);
  const openConfirm = usePortals((s) => s.openConfirm);

  const openItem = openItemFromSearch(search);
  const [suggestionDirty, setSuggestionDirty] = useState(false);

  function setOpenItem(item: OpenItem | null) {
    const changingItem =
      item?.kind !== openItem?.kind || item?.id !== openItem?.id;
    if (
      changingItem &&
      suggestionDirty &&
      !window.confirm(
        "Discard the unsubmitted suggestion draft and open another item?",
      )
    ) {
      return;
    }
    if (changingItem) setSuggestionDirty(false);
    navigate({
      replace: true,
      search: searchFromOpenItem(item),
      to: ".",
    });
  }

  const [generating, setGenerating] = useState<GenerateMode | null>(null);
  const [mode, setMode] = useState("chat");
  const [openChapters, setOpenChapters] = useState<Record<string, boolean>>({});
  // Drop-target line while dragging workspace content.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [insertTarget, setInsertTarget] = useState<{
    key: string;
    edge: "before" | "after";
  } | null>(null);
  const draggedItemRef = useRef<ContentOrderItem | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  const pair = userColorPair(ws?.color);
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
          type: "file",
        }),
      ),
      ...chapterMaterials.map(
        (material): WorkspaceContentItem => ({
          createdAt: material.createdAt,
          data: material,
          id: material.id,
          position: material.position,
          type: "material",
        }),
      ),
    ].sort((a, b) => {
      const positionDiff =
        (a.position ?? Number.MAX_SAFE_INTEGER) -
        (b.position ?? Number.MAX_SAFE_INTEGER);
      if (positionDiff) return positionDiff;
      if (a.type !== b.type) return a.type === "file" ? -1 : 1;
      return +new Date(b.createdAt) - +new Date(a.createdAt);
    });
  }

  // Native drag-and-drop: rows expose their content type and id. Drops on a
  // content row insert before/after that row; the Others bucket appends.
  const DND_TYPES = ["application/x-evo-material", "application/x-evo-file"];
  function hasDraggedContent(e: React.DragEvent) {
    return (
      draggedItemRef.current !== null ||
      DND_TYPES.some((type) => Array.from(e.dataTransfer.types).includes(type))
    );
  }
  function draggedContent(e: React.DragEvent): ContentOrderItem | null {
    if (draggedItemRef.current) return draggedItemRef.current;
    const materialId = e.dataTransfer.getData("application/x-evo-material");
    if (materialId) return { id: materialId, type: "material" };
    const fileId = e.dataTransfer.getData("application/x-evo-file");
    if (fileId) return { id: fileId, type: "file" };
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
    targetIndex: number,
  ) {
    const items = contentFor(chapterId)
      .map(({ id, type }) => ({ id, type }))
      .filter((item) => item.id !== dragged.id || item.type !== dragged.type);
    items.splice(Math.max(0, Math.min(targetIndex, items.length)), 0, dragged);
    reorderContent.mutate({ chapterId, items });
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
          e.dataTransfer.dropEffect = "move";
          if (dropTarget !== key) setDropTarget(key);
          setInsertTarget(null);
        }
      },
      onDrop: (e: React.DragEvent) => onItemDrop(chapterId, e),
    };
  }
  function contentDropZone(
    item: WorkspaceContentItem,
    chapterId: string | null,
  ) {
    const key = `${item.type}:${item.id}`;
    if (readOnly) return {};
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!hasDraggedContent(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        const rect = e.currentTarget.getBoundingClientRect();
        const edge =
          e.clientY < rect.top + rect.height / 2 ? "before" : "after";
        setDropTarget(null);
        setInsertTarget((current) =>
          current?.key === key && current.edge === edge
            ? current
            : { edge, key },
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
              content.id !== dragged.id || content.type !== dragged.type,
          );
          const targetIndex = destination.findIndex(
            (content) => content.id === item.id && content.type === item.type,
          );
          const rect = e.currentTarget.getBoundingClientRect();
          const edge =
            e.clientY < rect.top + rect.height / 2 ? "before" : "after";
          const insertionIndex =
            targetIndex < 0
              ? destination.length
              : targetIndex + (edge === "after" ? 1 : 0);
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
        if (!target.closest("[data-workspace-content-row]")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      },
      onDropCapture: (e: React.DragEvent) => {
        const target = e.target as HTMLElement;
        if (
          hasDraggedContent(e) &&
          target.closest("[data-workspace-content-row]")
        ) {
          e.preventDefault();
        }
      },
    };
  }
  function renderMaterial(mt: MaterialRef) {
    return (
      <MaterialListItem
        active={openItem?.kind === "material" && openItem.id === mt.id}
        chapters={chapters ?? []}
        data={mt}
        key={`${mt.type}:${mt.id}`}
        onDelete={
          readOnly
            ? undefined
            : () => {
                openConfirm({
                  body: m.confirm_delete_body(),
                  danger: true,
                  onConfirm: () =>
                    delMaterial.mutate(mt.id, {
                      onSuccess: () => {
                        if (
                          openItem?.kind === "material" &&
                          openItem.id === mt.id
                        ) {
                          setOpenItem(null);
                        }
                      },
                    }),
                  title: m.confirm_delete_title({ name: mt.title }),
                });
              }
        }
        onMove={(chapterId) => moveMaterial.mutate({ chapterId, id: mt.id })}
        onOpen={() => setOpenItem({ id: mt.id, kind: "material" })}
        readOnly={readOnly}
      />
    );
  }
  function renderContentItem(
    item: WorkspaceContentItem,
    chapterId: string | null,
  ) {
    const key = `${item.type}:${item.id}`;
    const draggable =
      !readOnly && !(item.type === "file" && item.data.status === "processing");
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
            item.type === "file"
              ? "application/x-evo-file"
              : "application/x-evo-material",
            item.id,
          );
          e.dataTransfer.effectAllowed = "move";
        }}
      >
        {insertTarget?.key === key && (
          <div
            className={cn(
              "pointer-events-none absolute right-1 left-1 z-10 h-0 border-line-strong border-t-2",
              insertTarget.edge === "before" ? "top-0" : "bottom-0",
            )}
          />
        )}
        {item.type === "file" ? (
          <FileListItem
            active={isFileActive(item.id)}
            chapters={chapters}
            color={ws?.color}
            file={item.data}
            onDeleted={onFileDeleted}
            onOpen={(id) => setOpenItem({ id, kind: "file" })}
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
    reorder.mutate(ids);
  }
  const isFileActive = (id: string) =>
    openItem?.kind === "file" && openItem.id === id;
  function onFileDeleted(id: string) {
    if (openItem?.kind === "file" && openItem.id === id) setOpenItem(null);
  }

  if (wsLoading) {
    return (
      <LoadingLarge
        backLabel="Back to workspaces"
        backTo="/workspaces"
        title="Loading workspace…"
      />
    );
  }

  if (!wsLoading && (wsError || !ws)) {
    const denied =
      isApiError(wsErr) && (wsErr.status === 404 || wsErr.status === 401);
    return (
      <PrivateOrUnavailable
        backLabel="Back to workspaces"
        backTo="/workspaces"
        description={
          denied
            ? "You may not have access, or the link may no longer be shared."
            : "Ooops, we are not able to load the workspace. Please try again in a bit."
        }
        title={
          denied
            ? "This item is private or unavailable."
            : "Unable to load workspace."
        }
      />
    );
  }

  // overflow-visible WITH important is so that shadow doesnt get clipped
  return (
    <>
      <ResizablePanelGroup
        className="overflow-visible! flex h-full min-h-0 gap-1.5"
        orientation="horizontal"
      >
        <ResizablePanel
          className="overflow-visible! flex w-full flex-col gap-2.5"
          defaultSize="18%"
          maxSize="550px"
          minSize="250px"
        >
          {/* Left column */}
          <div
            className="rounded-card-lg p-4"
            style={{
              background:
                pair.bg === "transparent"
                  ? "var(--color-surface-dark)"
                  : pair.bg,
              color: pair.fg,
            }}
          >
            <Link
              className="mb-3 inline-flex items-center gap-1 font-semibold text-sm opacity-80 hover:opacity-100"
              preload="intent"
              to="/workspaces"
            >
              <Icon className="-translate-y-px" name="chevronLeft" size={15} />{" "}
              {m.workspace_back()}
            </Link>
            <h1 className="t-large-card-title wrap-break-word line-clamp-4 text-ellipsis text-inherit">
              {ws?.name ?? "…"}
            </h1>
            {readOnly ? (
              <Button
                className="mt-4 w-full py-2"
                disabled={cloneWorkspace.isPending}
                iconLeft="plus"
                onClick={() =>
                  cloneWorkspace.mutate(workspaceId, {
                    onError: (err) => toastCloneError(err, "workspace"),
                    onSuccess: ({ workspace, ragCloned }) => {
                      // TODO: when is rag cloned?
                      userToast({
                        description: ragCloned
                          ? ""
                          : "Files copied. Parsed knowledge needs rebuilding.",
                        title: "Workspace cloned successfully",
                        variant: "success",
                      });
                      navigate({
                        params: { workspaceId: workspace.id },
                        to: "/workspaces/$workspaceId",
                      });
                    },
                  })
                }
                size="md"
                variant="surface"
              >
                {cloneWorkspace.isPending ? "Cloning…" : "Clone workspace"}
              </Button>
            ) : (
              <div
                className={`mt-4 grid gap-2 ${canShare ? "grid-cols-2" : "grid-cols-1"}`}
              >
                <Button
                  className="py-2"
                  onClick={() => openAddSource(workspaceId)}
                  size="md"
                  variant="surface"
                >
                  <Icon className="-translate-y-px" name="plus" size={16} />{" "}
                  {m.action_add_file()}
                </Button>
                {/* TODO: change share to settings or configure since there will be more workspace settings in future */}
                {canShare && (
                  <Button
                    className="py-2"
                    iconLeft="link"
                    onClick={() => setShareOpen(true)}
                    size="md"
                    variant="surface"
                  >
                    Share
                  </Button>
                )}
              </div>
            )}
          </div>

          <Panel
            className="min-h-0 flex-1 flex-col p-1"
            sectionClassName="h-full gap-0"
          >
            <div className="min-h-0 flex-1 overflow-auto px-1.5 pt-0 pb-1.5">
              {!chapters && (
                <SkeletonList
                  className="px-1.5 py-2"
                  count={5}
                  rowHeight={36}
                />
              )}
              {chapters && (
                <div className="flex flex-col gap-3 pt-1 pb-2">
                  <div className="flex flex-col">
                    <div className="relative flex items-center justify-between mx-2 mt-3 pb-1.5">
                      <div className="t-label text-fg-muted">Content</div>
                      {!readOnly && (
                        <div className="absolute top-1/2 right-0 flex -translate-y-1/2 gap-1">
                          <IconButton
                            className="rounded-md px-1 py-1.5"
                            icon="write"
                            onClick={() =>
                              createNote.mutate(
                                {},
                                {
                                  onSuccess: (mt) =>
                                    setOpenItem({
                                      id: mt.id,
                                      kind: "material",
                                    }),
                                },
                              )
                            }
                            size={"xs"}
                            strokeWidth={1.5}
                            variant={"neutral"}
                          />
                          <IconButton
                            className="rounded-md px-1 py-1.5"
                            icon="collapse"
                            onClick={() =>
                              setOpenChapters({
                                ...Object.fromEntries(
                                  chapters.map((c) => [c.id, false]),
                                ),
                              })
                            }
                            size={"xs"}
                            strokeWidth={1.5}
                            variant={"neutral"}
                          />
                        </div>
                      )}
                    </div>
                    {chapters.map((ch, idx) => {
                      const expanded = openChapters[ch.id] ?? true;
                      return (
                        <div className="rounded-button" key={ch.id}>
                          <div className="group relative flex items-center rounded-button py-1.5 pr-8 hover:bg-surface-hover-bg">
                            <button
                              className="flex min-w-0 flex-1 items-center gap-1 px-1 text-left"
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
                                name={expanded ? "chevronDown" : "chevronRight"}
                                size={15}
                              />
                              <span className="translate-y-px truncate font-semibold">
                                {ch.name}
                              </span>
                            </button>
                            {!readOnly && (
                              <HoverActions
                                className="absolute top-1/2 right-1 -translate-y-1/2"
                                items={[
                                  {
                                    icon: "write",
                                    label: m.action_rename(),
                                    onClick: () => {
                                      // TODO: use dialog
                                      const n = prompt(
                                        "Rename chapter",
                                        ch.name,
                                      );
                                      if (n)
                                        updateChapter.mutate({
                                          id: ch.id,
                                          name: n,
                                        });
                                    },
                                  },
                                  {
                                    disabled: idx === 0,
                                    icon: "chevronLeft",
                                    label: "Move up",
                                    onClick: () => moveChapter(idx, -1),
                                  },
                                  {
                                    disabled: idx === chapters.length - 1,
                                    icon: "chevronRight",
                                    label: "Move down",
                                    onClick: () => moveChapter(idx, 1),
                                  },
                                  {
                                    danger: true,
                                    icon: "trash",
                                    label: m.action_delete(),
                                    onClick: () => delChapter.mutate(ch.id),
                                  },
                                ]}
                              />
                            )}
                          </div>
                          {expanded && (
                            <div
                              {...contentListDropZone()}
                              className="flex flex-col pl-4"
                            >
                              {contentFor(ch.id).map((item) =>
                                renderContentItem(item, ch.id),
                              )}
                              {contentFor(ch.id).length === 0 && (
                                <div className="px-1.5 py-1 text-fg-muted text-xs">
                                  Empty
                                </div>
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
                    <div
                      {...dropZone("unfiled-files", null)}
                      className="rounded-button"
                    >
                      <div
                        className={cn(
                          "t-label px-1.5 py-1.5 text-fg-muted",
                          dropTarget === "unfiled-files" &&
                            "border-line-strong border-b-2",
                        )}
                      >
                        Others
                      </div>
                      <div>
                        {contentFor(null).map((item) =>
                          renderContentItem(item, null),
                        )}
                        {generating && (
                          <MaterialListItem
                            active={false}
                            chapters={chapters}
                            data={{
                              chapterId: null,
                              createdAt: new Date().toISOString(),
                              id: "__generating__",
                              position: Number.MAX_SAFE_INTEGER,
                              title: GENERATING_MATERIAL[generating].title,
                              type: GENERATING_MATERIAL[generating].type,
                            }}
                            generating
                            onOpen={() => {}}
                            readOnly
                          />
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
            {!readOnly && (
              <Button
                className="m-2 py-2"
                onClick={() => {
                  const n = prompt("New chapter name");
                  if (n) addChapter.mutate(n);
                }}
                variant="outline"
              >
                <Icon className="-translate-y-px" name="plus" size={15} />{" "}
                {m.action_add_chapter()}
              </Button>
            )}
          </Panel>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel
          className="overflow-visible!"
          defaultSize={readOnly ? "82%" : "52%"}
          minSize="400px"
        >
          {/* Center: content viewer */}
          <Panel className="w-full" sectionClassName="h-full gap-0">
            <CenterContent
              color={ws?.color}
              item={openItem}
              onSuggestionDirtyChange={setSuggestionDirty}
              readOnly={readOnly}
            />
          </Panel>
        </ResizablePanel>
        {!readOnly && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel
              className="overflow-visible!"
              defaultSize="30%"
              maxSize="900px"
              minSize="350px"
            >
              {/* Right column: top bar + AI */}
              <div className="flex h-full w-full flex-col gap-2.5">
                <TopInsetBar className="w-full" />
                <Panel
                  className="flex-1"
                  sectionClassName="gap-0 min-h-full overflow-hidden"
                >
                  <div className="flex items-center justify-between py-2.5">
                    <Tabs
                      className="px-3"
                      onChange={setMode}
                      tabs={[
                        { label: "Chat", value: "chat" },
                        { label: "Generate", value: "generate" },
                      ]}
                      value={mode}
                    />
                  </div>
                  <div className="h-full flex-1 overflow-hidden">
                    {mode === "chat" ? (
                      <ChatPanel color={ws?.color} workspaceId={workspaceId} />
                    ) : (
                      <GeneratePanel
                        chapters={chapters ?? []}
                        files={files ?? []}
                        onGeneratingChange={setGenerating}
                        onOpenItem={setOpenItem}
                        workspaceId={workspaceId}
                      />
                    )}
                  </div>
                </Panel>
              </div>
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
      {ws && (
        <ShareDialog
          link={`/share/workspaces/${ws.id}`}
          onClose={() => setShareOpen(false)}
          onPrivacyChange={(privacy) =>
            updateSharing.mutateAsync({ id: ws.id, privacy })
          }
          onShareRoleChange={(shareRole) =>
            updateSharing.mutateAsync({ id: ws.id, shareRole })
          }
          open={shareOpen}
          privacy={ws.privacy}
          saving={updateSharing.isPending}
          shareRole={ws.shareRole ?? "viewer"}
          title={`Share ${ws.name}`}
          workspaceId={ws.id}
        />
      )}
    </>
  );
}
