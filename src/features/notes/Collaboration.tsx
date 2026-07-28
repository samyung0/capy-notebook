import {
  type BaseCommentConfig,
  BaseCommentPlugin,
  getCommentKey,
} from '@platejs/comment';
import { useCommentId } from '@platejs/comment/react';
import {
  type BaseSuggestionConfig,
  BaseSuggestionPlugin,
} from '@platejs/suggestion';
import { CornerDownLeft, MessageSquareText, PencilLine } from 'lucide-react';
import {
  type AnyPluginConfig,
  type ExtendConfig,
  KEYS,
  NodeApi,
  type NodeEntry,
  type Path,
  type TElement,
  TextApi,
  type TInlineSuggestionData,
  type TSuggestionData,
  type TSuggestionText,
} from 'platejs';
import {
  createPlatePlugin,
  type PlateElementProps,
  PlateLeaf,
  type PlateLeafProps,
  type RenderNodeWrapper,
  toTPlatePlugin,
  useEditorPlugin,
  useEditorRef,
  usePluginOption,
} from 'platejs/react';
import { createContext, useContext, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useCommitMaterialSuggestions,
  useCreateMaterialComment,
  useCreateMaterialDiscussion,
  useDeleteMaterialComment,
  useDeleteMaterialDiscussion,
  useResolveMaterialDiscussion,
  useReviewMaterialSuggestions,
  useUpdateMaterialComment,
  useWithdrawMaterialSuggestion,
} from '@/api/hooks';
import type {
  MaterialComment,
  MaterialDiscussion,
  MaterialSuggestion,
  WorkspaceMember,
} from '@/api/types';
import {
  Button,
  InputTitle,
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
  SimpleDialog,
  Textarea,
} from '@/components/ui';
import {
  createMaterialDocument,
  type MaterialDocument,
  type MaterialValue,
} from '@/features/materials/document';
import { cn } from '@/lib/cn';
import { canReplyAtDepth } from './canReplyAtDepth';
import { useEditorRuntime } from './EditorRuntime';
import type { NoteEditorMode } from './editorMode';
import {
  type SuggestionChange,
  scanSuggestions,
  stripCommentDecorations,
} from './suggestions';

export interface EditorCollaborationOptions {
  currentUserId: string | null;
  discussions: MaterialDiscussion[];
  mode: NoteEditorMode;
  users: Record<string, WorkspaceMember>;
}

export interface OrphanSuggestion extends SuggestionChange {
  orphan: true;
}

export interface DraftSuggestion extends SuggestionChange {
  draft: true;
  userId: string;
}

export interface JoinedSuggestion extends SuggestionChange {
  discussion: MaterialDiscussion;
  lifecycle: MaterialSuggestion;
}

type ActiveSuggestionEntry =
  | JoinedSuggestion
  | OrphanSuggestion
  | DraftSuggestion;

type SuggestionEntry = MaterialSuggestion | ActiveSuggestionEntry;

type CommentConfig = ExtendConfig<
  BaseCommentConfig,
  {
    activeId: string | null;
    commentingBlock: Path | null;
    hoverId: string | null;
  }
>;

type SuggestionConfig = ExtendConfig<
  BaseSuggestionConfig,
  {
    activeId: string | null;
    hoverId: string | null;
  }
>;

function isOrphan(entry: SuggestionEntry): entry is OrphanSuggestion {
  return 'orphan' in entry;
}

function isDraft(entry: SuggestionEntry): entry is DraftSuggestion {
  return 'draft' in entry;
}

function isJoined(entry: SuggestionEntry): entry is JoinedSuggestion {
  return 'lifecycle' in entry;
}

function lifecycleSuggestion(
  entry: SuggestionEntry
): MaterialSuggestion | null {
  if (isOrphan(entry) || isDraft(entry)) return null;
  return isJoined(entry) ? entry.lifecycle : entry;
}

function isSlatePoint(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const point = value as Record<string, unknown>;
  return (
    Array.isArray(point.path) &&
    point.path.every((index) => Number.isInteger(index) && index >= 0) &&
    typeof point.offset === 'number' &&
    Number.isInteger(point.offset) &&
    point.offset >= 0
  );
}

export function commentDiscussionAnchor(
  discussion: MaterialDiscussion
): unknown | null {
  if (
    discussion.kind !== 'comment' ||
    !discussion.anchor ||
    typeof discussion.anchor !== 'object' ||
    Array.isArray(discussion.anchor)
  ) {
    return null;
  }
  const anchor = discussion.anchor as Record<string, unknown>;
  if (!(isSlatePoint(anchor.anchor) && isSlatePoint(anchor.focus))) return null;
  const start = anchor.anchor as { offset: number; path: number[] };
  const end = anchor.focus as { offset: number; path: number[] };
  const collapsed =
    start.offset === end.offset &&
    start.path.length === end.path.length &&
    start.path.every((part, index) => part === end.path[index]);
  return collapsed ? null : discussion.anchor;
}

/**
 * SOURCE: Plate metadata in the revision head is authoritative. Discussion
 * rows are a relational projection and may be absent after legacy imports or
 * interrupted migrations, so raw pending IDs must remain reviewable instead
 * of disappearing from the UI.
 */
export function synthesizeOrphanSuggestions(
  value: MaterialValue,
  discussions: MaterialDiscussion[]
): OrphanSuggestion[] {
  return joinActiveSuggestions(value, discussions).orphans;
}

export function joinActiveSuggestions(
  value: MaterialValue,
  discussions: MaterialDiscussion[]
): {
  joined: JoinedSuggestion[];
  orphans: OrphanSuggestion[];
} {
  const lifecycleByKey = new Map<
    string,
    { discussion: MaterialDiscussion; lifecycle: MaterialSuggestion }
  >();
  for (const discussion of discussions) {
    if (!discussion.blockId) continue;
    for (const lifecycle of discussion.suggestions) {
      const key = `${discussion.blockId}\u0000${lifecycle.plateSuggestionId}`;
      const current = lifecycleByKey.get(key);
      if (!current || current.lifecycle.updatedAt < lifecycle.updatedAt) {
        lifecycleByKey.set(key, { discussion, lifecycle });
      }
    }
  }

  const joined: JoinedSuggestion[] = [];
  const orphans: OrphanSuggestion[] = [];
  for (const change of scanSuggestions(value)) {
    const match = lifecycleByKey.get(
      `${change.blockId}\u0000${change.plateSuggestionId}`
    );
    if (match) {
      joined.push({ ...change, ...match });
    } else {
      orphans.push({ ...change, orphan: true });
    }
  }
  return { joined, orphans };
}

export function synthesizeDraftSuggestions(
  liveValue: MaterialValue,
  persistedValue: MaterialValue,
  currentUserId: string | null
): DraftSuggestion[] {
  if (!currentUserId) return [];
  const persisted = new Set(
    scanSuggestions(persistedValue).map(
      (change) => `${change.blockId}\u0000${change.plateSuggestionId}`
    )
  );
  return scanSuggestions(liveValue)
    .filter(
      (change) =>
        !persisted.has(`${change.blockId}\u0000${change.plateSuggestionId}`)
    )
    .map((change) => ({ ...change, draft: true, userId: currentUserId }));
}

export function suggestionControlPermissions(
  entry: SuggestionEntry,
  currentUserId: string | null,
  canEdit: boolean
) {
  const orphan = isOrphan(entry);
  const draft = isDraft(entry);
  const lifecycle = lifecycleSuggestion(entry);
  const pending = orphan || draft || lifecycle?.status === 'pending';
  return {
    canReview: !draft && canEdit && pending,
    canWithdraw:
      !orphan &&
      !draft &&
      pending &&
      (lifecycle?.userId === currentUserId || canEdit),
  };
}

interface CollaborationActions {
  addComment: (discussionId: string, text: string) => Promise<void>;
  addReply: (
    discussionId: string,
    parentCommentId: string,
    text: string
  ) => Promise<void>;
  canComment: boolean;
  canEdit: boolean;
  collaborationError: string | null;
  currentRevision: number;
  currentUserId: string | null;
  deleteComment: (comment: MaterialComment) => void;
  deleteDiscussion: (discussion: MaterialDiscussion) => void;
  discardSuggestion: () => void;
  discussions: MaterialDiscussion[];
  drafts: DraftSuggestion[];
  mutationPending: boolean;
  openComment: () => void;
  orphans: OrphanSuggestion[];
  resolve: (discussion: MaterialDiscussion) => void;
  review: (entry: ActiveSuggestionEntry, decision: 'accept' | 'reject') => void;
  submitSuggestion: () => void;
  suggestionDirty: boolean;
  suggestions: JoinedSuggestion[];
  updateComment: (commentId: string, text: string) => Promise<void>;
  users: Record<string, WorkspaceMember>;
  withdraw: (suggestion: MaterialSuggestion) => void;
}

const CollaborationActionsContext = createContext<CollaborationActions | null>(
  null
);

export function useCollaborationActions() {
  return useContext(CollaborationActionsContext);
}

const BlockDiscussion: RenderNodeWrapper<AnyPluginConfig> = () => (props) => (
  <BlockDiscussionContent {...props} />
);

function BlockDiscussionContent({
  children,
  editor,
  element,
}: PlateElementProps) {
  const actions = useCollaborationActions();
  const path = editor.api.findPath(element);
  const isTopLevel = path?.length === 1;
  const blockId =
    typeof element.id === "string" && element.id.trim() ? element.id : null;
  const discussions =
    actions?.discussions.filter((item) => item.blockId === blockId) ?? [];
  const drafts =
    actions?.drafts.filter((item) => item.blockId === blockId) ?? [];
  const orphans =
    actions?.orphans.filter((item) => item.blockId === blockId) ?? [];
  const suggestions =
    actions?.suggestions.filter((item) => item.blockId === blockId) ?? [];
  const commentDiscussions = discussions.filter(
    (discussion) =>
      discussion.kind === "comment" && discussion.comments.length > 0,
  );
  const suggestionItems: ActiveSuggestionEntry[] = [
    ...drafts,
    ...orphans,
    ...suggestions,
  ];
  const total = suggestionItems.length + commentDiscussions.length;
  const activeSuggestionId = usePluginOption(suggestionPlugin, "activeId");
  const activeCommentId = usePluginOption(commentPlugin, "activeId");
  const activeSuggestion = suggestionItems.find(
    (item) => item.plateSuggestionId === activeSuggestionId,
  );
  const activeDiscussion = commentDiscussions.find(
    (discussion) => discussion.id === activeCommentId,
  );
  const selected = !!activeSuggestion || !!activeDiscussion;
  const [manuallyOpen, setManuallyOpen] = useState(false);
  const open = manuallyOpen || selected;

  const anchorElement = useMemo(() => {
    if (!(path && selected)) return null;
    let activeNode: NodeEntry | undefined;

    if (activeSuggestion) {
      activeNode = [
        ...editor.getApi(BaseSuggestionPlugin).suggestion.nodes({ at: path }),
      ].find(
        ([node]) =>
          editor.getApi(BaseSuggestionPlugin).suggestion.nodeId(node) ===
          activeSuggestion.plateSuggestionId,
      );
    } else if (activeCommentId) {
      activeNode = [
        ...editor.getApi(BaseCommentPlugin).comment.nodes({ at: path }),
      ].find(
        ([node]) =>
          editor.getApi(BaseCommentPlugin).comment.nodeId(node) ===
          activeCommentId,
      );
    }

    if (!activeNode) return null;
    try {
      return editor.api.toDOMNode(activeNode[0]);
    } catch {
      return null;
    }
  }, [activeCommentId, activeSuggestion, editor, path, selected]);

  const renderedItems = [
    ...suggestionItems.map((entry) => ({
      createdAt: lifecycleSuggestion(entry)?.createdAt ?? entry.createdAt ?? "",
      entry,
      key: `suggestion:${entry.blockId}:${entry.plateSuggestionId}`,
      type: "suggestion" as const,
    })),
    ...commentDiscussions.map((discussion) => ({
      createdAt: discussion.createdAt,
      discussion,
      key: `discussion:${discussion.id}`,
      type: "discussion" as const,
    })),
  ].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.key.localeCompare(right.key),
  );
  const visibleItems = selected
    ? renderedItems.filter((item) =>
        item.type === "suggestion"
          ? item.entry === activeSuggestion
          : item.discussion === activeDiscussion,
      )
    : renderedItems;

  if (!isTopLevel) return <>{children}</>;
  if (!actions || total === 0) return <div className="w-full">{children}</div>;

  return (
    <div className="flex w-full justify-between">
      <Popover onOpenChange={setManuallyOpen} open={open}>
        <div className="min-w-0 flex-1">{children}</div>
        {anchorElement && (
          <PopoverAnchor virtualRef={{ current: anchorElement }} />
        )}
        <PopoverContent
          align="start"
          className="max-h-[min(60dvh,var(--radix-popper-available-height))] w-95 max-w-[calc(100vw-24px)] gap-0 overflow-y-auto border border-line bg-surface p-0 shadow-pop"
          contentEditable={false}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => event.preventDefault()}
          side="left"
          sideOffset={8}
        >
          <div className="sticky top-0 z-10 flex items-center justify-between border-divider border-b bg-surface px-3 py-2">
            <p className="font-semibold text-fg-muted text-xs">
              Comments & suggestions
            </p>
            <span className="text-fg-muted text-xs">{total}</span>
          </div>
          <div className="flex flex-col gap-2 p-2">
            {visibleItems.map((item) =>
              item.type === "suggestion" ? (
                <SuggestionCard entry={item.entry} key={item.key} />
              ) : (
                <DiscussionThread discussion={item.discussion} key={item.key} />
              ),
            )}
          </div>
          {actions.collaborationError && (
            <p className="border-divider border-t px-3 py-2 text-sm text-solid-error">
              {actions.collaborationError}
            </p>
          )}
        </PopoverContent>
        <div className="relative size-0 select-none">
          <PopoverTrigger asChild>
            <Button
              aria-label={`Show ${total} collaboration item${total === 1 ? "" : "s"}`}
              className="mt-1 ml-1 h-7 min-w-7 gap-1 rounded-button px-1.5 py-0 text-fg-muted data-[state=open]:bg-surface-hover-bg"
              contentEditable={false}
              size="sm"
              variant="ghost-hover"
            >
              {suggestionItems.length > 0 ? (
                <PencilLine className="size-4 shrink-0" />
              ) : (
                <MessageSquareText className="size-4 shrink-0" />
              )}
              <span className="font-semibold text-xs">{total}</span>
            </Button>
          </PopoverTrigger>
        </div>
      </Popover>
    </div>
  );
}

export const discussionPlugin = createPlatePlugin({
  key: "evo-discussions",
  options: {
    currentUserId: null as string | null,
    discussions: [] as MaterialDiscussion[],
    users: {} as Record<string, WorkspaceMember>,
  },
  render: { aboveNodes: BlockDiscussion },
});

function collaborationClickTarget(
  target: EventTarget | null,
  selector: string,
): HTMLElement | null {
  return target instanceof HTMLElement ? target.closest(selector) : null;
}

export const commentPlugin = toTPlatePlugin<CommentConfig>(BaseCommentPlugin, {
  handlers: {
    onClick: ({ event, setOption, type }) => {
      const target = collaborationClickTarget(event.target, `.slate-${type}`);
      if (!target) {
        setOption("activeId", null);
        return;
      }
      setOption("activeId", target.dataset.commentId ?? null);
    },
  },
  options: {
    activeId: null as string | null,
    commentingBlock: null,
    hoverId: null as string | null,
  },
  render: { node: CommentLeaf },
  shortcuts: { setDraft: { keys: "mod+shift+m" } },
});

function CommentLeaf(props: PlateLeafProps) {
  const commentId =
    useCommentId() ??
    Object.keys(props.leaf)
      .find((key) => key.startsWith("comment_"))
      ?.slice("comment_".length);
  const { setOption } = useEditorPlugin(commentPlugin);
  const activeId = usePluginOption(commentPlugin, "activeId");
  const hoverId = usePluginOption(commentPlugin, "hoverId");
  const highlighted = commentId === activeId || commentId === hoverId;
  return (
    <PlateLeaf
      {...props}
      attributes={{
        ...props.attributes,
        "data-collaboration-mark": "comment",
        ...(commentId ? { "data-comment-id": commentId } : {}),
        onClick: (event) => {
          event.stopPropagation();
          setOption("activeId", commentId ?? null);
        },
        onMouseEnter: () => setOption("hoverId", commentId ?? null),
        onMouseLeave: () => setOption("hoverId", null),
      }}
      className={cn(
        "rounded-sm bg-tint-accent-2 underline decoration-2 decoration-action-accent/50 underline-offset-2 transition-colors",
        highlighted && "bg-action-accent/25 decoration-action-accent",
      )}
    >
      {props.children}
    </PlateLeaf>
  );
}

function getInlineSuggestionData(editor: any, element: TElement) {
  const api = editor.getApi(BaseSuggestionPlugin).suggestion;
  const direct = api.suggestionData(element) as
    | TSuggestionData
    | TInlineSuggestionData
    | undefined;
  if (direct) return direct;
  for (const child of element.children) {
    if (!TextApi.isText(child)) continue;
    const data = api.dataList(child as TSuggestionText).at(-1);
    if (data) return data;
  }
}

function SuggestionLeaf(props: PlateLeafProps<TSuggestionText>) {
  const editor = useEditorRef();
  const { setOption } = useEditorPlugin(suggestionPlugin);
  const data = editor
    .getApi(BaseSuggestionPlugin)
    .suggestion.dataList(props.leaf);
  const leafId =
    editor.getApi(BaseSuggestionPlugin).suggestion.nodeId(props.leaf) ?? null;
  const activeId = usePluginOption(suggestionPlugin, "activeId");
  const hoverId = usePluginOption(suggestionPlugin, "hoverId");
  const remove = data.some((item) => item.type === "remove");
  const highlighted = data.some(
    (item) => item.id === activeId || item.id === hoverId,
  );
  return (
    <PlateLeaf
      {...props}
      as={remove ? "del" : "ins"}
      attributes={{
        ...props.attributes,
        ...(leafId ? { "data-suggestion-id": leafId } : {}),
        onClick: (event) => {
          event.stopPropagation();
          setOption("activeId", leafId);
        },
        onMouseEnter: () => setOption("hoverId", leafId),
        onMouseLeave: () => setOption("hoverId", null),
      }}
      className={cn(
        "rounded-sm bg-tint-accent-2 text-tint-accent-2-fg no-underline transition-colors",
        highlighted && "bg-action-accent/25",
        remove &&
          "bg-tint-error text-solid-error line-through decoration-solid-error",
        remove && highlighted && "bg-solid-error/20",
      )}
    >
      {props.children}
    </PlateLeaf>
  );
}

const UNWRAPPABLE = new Set<string>([KEYS.table, KEYS.tr, KEYS.td, KEYS.th]);
const SuggestionLineBreak: RenderNodeWrapper = ({ api, element }) => {
  if (!(api as any).suggestion.isBlockSuggestion(element)) return;
  const data = (element as TElement & { suggestion: TSuggestionData })
    .suggestion;
  return ({ children }) => (
    <BlockSuggestionDecoration data={data} element={element}>
      {children}
    </BlockSuggestionDecoration>
  );
};

function BlockSuggestionDecoration({
  children,
  data,
  element,
}: {
  children: React.ReactNode;
  data: TSuggestionData;
  element: TElement;
}) {
  const { setOption } = useEditorPlugin(suggestionPlugin);
  const activeId = usePluginOption(suggestionPlugin, "activeId");
  const hoverId = usePluginOption(suggestionPlugin, "hoverId");
  const remove = data.type === "remove";
  const highlighted = data.id === activeId || data.id === hoverId;
  const interactionProps = {
    "data-suggestion-id": data.id,
    onClick: (event: React.MouseEvent) => {
      event.stopPropagation();
      setOption("activeId", data.id);
    },
    onMouseEnter: () => setOption("hoverId", data.id),
    onMouseLeave: () => setOption("hoverId", null),
  };

  if (data.isLineBreak) {
    return (
      <>
        {children}
        <span
          {...interactionProps}
          className={cn(
            "inline-flex h-[calc(1lh+2px)] w-[1lh] items-center justify-center rounded-sm transition-colors",
            remove ? "text-solid-error" : "text-solid-success",
            highlighted &&
              (remove ? "bg-solid-error/20" : "bg-action-accent/25"),
          )}
          contentEditable={false}
          data-block-suggestion={data.type}
        >
          <CornerDownLeft className="size-4" />
        </span>
      </>
    );
  }
  if (UNWRAPPABLE.has(element.type)) return <>{children}</>;
  return (
    <div
      {...interactionProps}
      className={cn(
        "rounded-sm bg-tint-accent-2 text-tint-accent-2-fg transition-colors",
        element.type === KEYS.columnGroup && "flex size-full gap-2",
        highlighted && "bg-action-accent/25",
        remove &&
          "bg-tint-error text-solid-error line-through decoration-solid-error",
        remove && highlighted && "bg-solid-error/20",
      )}
      data-block-suggestion={data.type}
    >
      {children}
    </div>
  );
}

function VoidRemoveSuggestionOverlay({ editor, element }: PlateElementProps) {
  const data = editor
    .getApi(BaseSuggestionPlugin)
    .suggestion.suggestionData(element);
  if (
    !editor.api.isVoid(element) ||
    editor.api.isInline(element) ||
    data?.type !== "remove"
  )
    return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 rounded-[inherit] border border-solid-error bg-tint-error/55"
      contentEditable={false}
      data-slot="void-remove-suggestion"
    />
  );
}

export const suggestionPlugin = toTPlatePlugin<SuggestionConfig>(
  BaseSuggestionPlugin,
  {
    handlers: {
      onClick: ({ event, setOption, type }) => {
        const markTarget = collaborationClickTarget(
          event.target,
          `.slate-${type}`,
        );
        const blockTarget = markTarget
          ? null
          : collaborationClickTarget(event.target, "[data-block-suggestion]");
        if (!(markTarget || blockTarget)) {
          setOption("activeId", null);
          return;
        }
        setOption(
          "activeId",
          (markTarget ?? blockTarget)?.dataset.suggestionId ?? null,
        );
      },
    },
    inject: {
      isElement: true,
      nodeProps: {
        nodeKey: "",
        styleKey: "cssText",
        transformProps: ({ editor, element, props }) => {
          if (!element) return props;
          const data = getInlineSuggestionData(editor, element);
          if (!data) return props;
          return {
            ...props,
            className: cn(
              (props as { className?: string }).className,
              "rounded-sm bg-tint-accent-2 text-tint-accent-2-fg",
              data.type === "remove" &&
                "bg-tint-error text-solid-error line-through decoration-solid-error",
            ),
            "data-inline-suggestion": data.type,
            "data-suggestion-id": data.id,
          };
        },
        transformStyle: () => ({}) as CSSStyleDeclaration,
      },
      targetPlugins: [KEYS.inlineEquation, KEYS.link, KEYS.mention],
    },
    options: {
      activeId: null as string | null,
      hoverId: null as string | null,
    },
    render: {
      belowNodes: SuggestionLineBreak,
      belowRootNodes: VoidRemoveSuggestionOverlay,
      node: SuggestionLeaf,
    },
  },
);

function richComment(text: string): MaterialValue {
  return [{ children: [{ text }], type: "p" }];
}

export function CollaborationProvider({
  children,
  currentDocument,
  currentRevision,
  discussions,
  users,
  currentUserId,
  suggestionDirty,
  onSuggestionReset,
  onMaterialState,
  replaceEditorDocument,
  actionsPortalHost,
}: {
  children: React.ReactNode;
  currentDocument: MaterialDocument;
  currentRevision: number;
  discussions: MaterialDiscussion[];
  users: Record<string, WorkspaceMember>;
  currentUserId: string | null;
  suggestionDirty: boolean;
  onSuggestionReset: () => void;
  onMaterialState: (
    document: MaterialDocument,
    revision: number,
    hasPending: boolean,
  ) => void;
  replaceEditorDocument: (value: MaterialValue) => void;
  actionsPortalHost?: HTMLElement | null;
}) {
  const editor = useEditorRef();
  const { materialId, mode, canEdit, canComment } = useEditorRuntime();
  const commit = useCommitMaterialSuggestions(materialId);
  const review = useReviewMaterialSuggestions(materialId);
  const withdraw = useWithdrawMaterialSuggestion(materialId);
  const deleteDiscussionMutation = useDeleteMaterialDiscussion(materialId);
  const createDiscussion = useCreateMaterialDiscussion(materialId);
  const addComment = useCreateMaterialComment(materialId);
  const updateComment = useUpdateMaterialComment(materialId);
  const deleteComment = useDeleteMaterialComment(materialId);
  const resolveDiscussion = useResolveMaterialDiscussion(materialId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { joined: suggestions, orphans } = joinActiveSuggestions(
    currentDocument.value,
    discussions,
  );
  const drafts = synthesizeDraftSuggestions(
    editor.children as MaterialValue,
    currentDocument.value,
    currentUserId,
  );
  const mutationPending =
    commit.isPending ||
    review.isPending ||
    withdraw.isPending ||
    deleteDiscussionMutation.isPending;

  const applyReturnedMaterial = (
    material: Awaited<ReturnType<typeof commit.mutateAsync>>["material"],
  ) => {
    replaceEditorDocument(material.content.value);
    onMaterialState(
      material.content,
      material.revision ?? currentRevision,
      material.hasPendingSuggestions ?? false,
    );
    onSuggestionReset();
  };

  const fail = (cause: unknown, fallback: string) =>
    setError(cause instanceof Error ? cause.message : fallback);

  async function submitSuggestion() {
    if (mode !== "suggestion" || (!canEdit && !canComment) || !suggestionDirty)
      return;
    setError(null);
    try {
      const content = createMaterialDocument(
        stripCommentDecorations(editor.children as MaterialValue),
      );
      const result = await commit.mutateAsync({
        content,
        expectedRevision: currentRevision,
      });
      applyReturnedMaterial(result.material);
    } catch (cause) {
      fail(cause, "Unable to submit suggestion");
    }
  }

  async function reviewEntry(
    entry: ActiveSuggestionEntry,
    decision: "accept" | "reject",
  ) {
    if (!canEdit || mutationPending) return;
    setError(null);
    try {
      const result = await review.mutateAsync({
        decision,
        expectedRevision: currentRevision,
        suggestionIds: [entry.plateSuggestionId],
      });
      applyReturnedMaterial(result.material);
    } catch (cause) {
      fail(cause, `Unable to ${decision} suggestion`);
    }
  }

  async function submitNewComment() {
    const text = comment.trim();
    if (!text || !editor.selection || editor.api.isCollapsed()) return;
    const selection = structuredClone(editor.selection);
    const blockId = editor.api.block()?.[0]?.id as string | undefined;
    try {
      const discussion = await createDiscussion.mutateAsync({
        anchor: selection as unknown as Record<string, unknown>,
        blockId,
        contentRich: richComment(text),
      });
      editor.tf.withoutSaving(() => {
        editor.tf.setNodes(
          { [KEYS.comment]: true, [getCommentKey(discussion.id)]: true },
          { at: selection, match: TextApi.isText, split: true },
        );
      });
      setDialogOpen(false);
    } catch (cause) {
      fail(cause, "Unable to add comment");
    }
  }

  const actions: CollaborationActions = {
    addComment: async (discussionId, text) => {
      await addComment.mutateAsync({
        contentRich: richComment(text),
        discussionId,
      });
    },
    addReply: async (discussionId, parentCommentId, text) => {
      await addComment.mutateAsync({
        contentRich: richComment(text),
        discussionId,
        parentCommentId,
      });
    },
    canComment,
    canEdit,
    collaborationError: error,
    currentRevision,
    currentUserId,
    deleteComment: (entry) => {
      if (!window.confirm("Delete this comment?")) return;
      deleteComment.mutate(entry.id);
    },
    deleteDiscussion: (discussion) => {
      const hasPending = discussion.suggestions.some(
        (item) => item.status === "pending",
      );
      if (
        !window.confirm(
          hasPending
            ? "Delete this thread? Its pending suggestions will be rejected."
            : "Delete this discussion thread?",
        )
      )
        return;
      void deleteDiscussionMutation
        .mutateAsync({
          discussionId: discussion.id,
          expectedRevision: hasPending ? currentRevision : undefined,
        })
        .then((result) => applyReturnedMaterial(result.material))
        .catch((cause) => fail(cause, "Unable to delete discussion"));
    },
    discardSuggestion: () => {
      replaceEditorDocument(currentDocument.value);
      onSuggestionReset();
    },
    discussions,
    drafts,
    mutationPending,
    openComment: () => {
      if (!canComment || !editor.selection || editor.api.isCollapsed()) return;
      setComment("");
      setError(null);
      setDialogOpen(true);
    },
    orphans,
    resolve: (discussion) =>
      resolveDiscussion.mutate({
        discussionId: discussion.id,
        isResolved: !discussion.isResolved,
      }),
    review: (entry, decision) => void reviewEntry(entry, decision),
    submitSuggestion: () => void submitSuggestion(),
    suggestionDirty,
    suggestions,
    updateComment: async (commentId, text) => {
      await updateComment.mutateAsync({
        commentId,
        contentRich: richComment(text),
      });
    },
    users,
    withdraw: (suggestion) => {
      if (
        !window.confirm(
          "Withdraw this pending suggestion? Its marked changes will be rejected.",
        )
      )
        return;
      void withdraw
        .mutateAsync({
          expectedRevision: currentRevision,
          suggestionId: suggestion.id,
        })
        .then((result) => applyReturnedMaterial(result.material))
        .catch((cause) => fail(cause, "Unable to withdraw suggestion"));
    },
  };

  return (
    <CollaborationActionsContext.Provider value={actions}>
      {children}
      {actionsPortalHost &&
        createPortal(<CommentToolbarActions />, actionsPortalHost)}
      <SimpleDialog
        footer={
          <>
            <Button onClick={() => setDialogOpen(false)} variant="ghost-hover">
              Cancel
            </Button>
            <Button
              disabled={!comment.trim() || createDiscussion.isPending}
              onClick={() => void submitNewComment()}
            >
              Add comment
            </Button>
          </>
        }
        onClose={() => setDialogOpen(false)}
        open={dialogOpen}
        title="Add comment"
      >
        <label className="flex flex-col gap-1.5">
          <InputTitle>Comment</InputTitle>
          <Textarea
            onChange={(event) => setComment(event.target.value)}
            rows={4}
            value={comment}
          />
        </label>
      </SimpleDialog>
    </CollaborationActionsContext.Provider>
  );
}

function userName(actions: CollaborationActions, userId: string) {
  return actions.users[userId]?.name ?? "Unknown user";
}

export function SuggestionCard({ entry }: { entry: ActiveSuggestionEntry }) {
  const actions = useCollaborationActions();
  const { setOption } = useEditorPlugin(suggestionPlugin);
  if (!actions) return null;
  const orphan = isOrphan(entry);
  const draft = isDraft(entry);
  const lifecycle = lifecycleSuggestion(entry);
  const discussion = isJoined(entry) ? entry.discussion : null;
  const status = draft ? "draft" : orphan ? "pending" : lifecycle?.status;
  const permissions = suggestionControlPermissions(
    entry,
    actions.currentUserId,
    actions.canEdit,
  );
  return (
    <section
      className={cn(
        "rounded-card border border-line p-3",
        orphan && "border-solid-warning",
      )}
      onMouseEnter={() => setOption("hoverId", entry.plateSuggestionId)}
      onMouseLeave={() => setOption("hoverId", null)}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium text-fg-muted text-xs">
          {orphan
            ? entry.userId
              ? `Suggestion from ${userName(actions, entry.userId)} · missing lifecycle`
              : "Unknown user · missing lifecycle"
            : `Suggestion from ${userName(
                actions,
                draft ? entry.userId : (lifecycle?.userId ?? ""),
              )}`}
        </p>
        <span className="rounded-full bg-surface-hover-bg px-2 py-0.5 text-fg-muted text-xs">
          {status}
        </span>
      </div>
      <SuggestionPreview
        after={entry.previewAfter}
        before={entry.previewBefore}
        operation={entry.operation}
      />
      {permissions.canReview && (
        <div className="mt-3 flex gap-2">
          <Button
            disabled={actions.mutationPending}
            onClick={() => actions.review(entry, "accept")}
            size="sm"
            variant="accent"
          >
            Accept
          </Button>
          <Button
            disabled={actions.mutationPending}
            onClick={() => actions.review(entry, "reject")}
            size="sm"
            variant="outline"
          >
            Reject
          </Button>
        </div>
      )}
      {lifecycle && permissions.canWithdraw && (
        <Button
          className="mt-2"
          onClick={() => actions.withdraw(lifecycle)}
          size="sm"
          variant="ghost"
        >
          Withdraw
        </Button>
      )}
      {discussion && (discussion.comments.length > 0 || actions.canComment) && (
        <div className="mt-3 border-divider border-t pt-3">
          <DiscussionComments discussion={discussion} />
        </div>
      )}
    </section>
  );
}

function SuggestionPreview({
  operation,
  before,
  after,
}: {
  operation: string;
  before: string;
  after: string;
}) {
  return (
    <div className="mt-2 flex flex-col gap-1 text-sm">
      {before && (
        <p className="line-clamp-3 whitespace-pre-wrap text-solid-error line-through">
          {before}
        </p>
      )}
      {after && (
        <p className="line-clamp-3 whitespace-pre-wrap text-solid-success">
          {after}
        </p>
      )}
      {!before && !after && <p className="text-fg-muted">{operation} change</p>}
    </div>
  );
}

export function DiscussionThread({
  discussion,
}: {
  discussion: MaterialDiscussion;
}) {
  const actions = useCollaborationActions();
  const { setOption } = useEditorPlugin(commentPlugin);
  if (!actions) return null;
  const canDeleteThread =
    discussion.userId === actions.currentUserId || actions.canEdit;
  const isCommentDiscussion = discussion.kind === "comment";
  return (
    <section
      className={cn(
        "rounded-card border border-line p-3",
        discussion.isResolved && "opacity-65",
      )}
      onClick={() => setOption("activeId", discussion.id)}
      onMouseEnter={() => setOption("hoverId", discussion.id)}
      onMouseLeave={() => setOption("hoverId", null)}
    >
      <DiscussionComments discussion={discussion} />
      <div className="mt-2 flex flex-wrap gap-1">
        {isCommentDiscussion && actions.canComment && (
          <Button
            onClick={() => actions.resolve(discussion)}
            size="sm"
            variant="ghost"
          >
            {discussion.isResolved ? "Reopen" : "Resolve"}
          </Button>
        )}
        {canDeleteThread && (
          <Button
            onClick={() => actions.deleteDiscussion(discussion)}
            size="sm"
            variant="ghost"
          >
            Delete thread
          </Button>
        )}
      </div>
    </section>
  );
}

function DiscussionComments({
  discussion,
}: {
  discussion: MaterialDiscussion;
}) {
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [comment, setComment] = useState("");
  const actions = useCollaborationActions();

  return (
    <div className="flex flex-col gap-2">
      {discussion.comments.map((comment) => (
        <CommentEntry
          depth={0}
          discussionId={discussion.id}
          entry={comment}
          key={comment.id}
          reply={reply}
          replyTo={replyTo}
          setReply={setReply}
          setReplyTo={setReplyTo}
        />
      ))}
      {actions?.canComment && (
        <div className="flex gap-2">
          <Textarea
            aria-label="Add comment"
            className="min-h-14 flex-1"
            onChange={(event) => setComment(event.target.value)}
            placeholder="Add a comment…"
            rows={2}
            value={comment}
          />
          <Button
            disabled={!comment.trim()}
            onClick={() =>
              void actions
                .addComment(discussion.id, comment.trim())
                .then(() => setComment(""))
            }
            size="sm"
            variant="outline"
          >
            Comment
          </Button>
        </div>
      )}
    </div>
  );
}

function commentContentText(contentRich: unknown): string {
  if (!Array.isArray(contentRich)) return "";
  return contentRich
    .filter(
      (node): node is Record<string, unknown> =>
        !!node && typeof node === "object" && !Array.isArray(node),
    )
    .map((node) => NodeApi.string(node as never))
    .join("\n");
}

function CommentEntry({
  entry,
  discussionId,
  depth,
  replyTo,
  reply,
  setReplyTo,
  setReply,
}: {
  entry: MaterialComment;
  discussionId: string;
  depth: 0 | 1;
  replyTo: string | null;
  reply: string;
  setReplyTo: (id: string | null) => void;
  setReply: (text: string) => void;
}) {
  const actions = useCollaborationActions()!;
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(() =>
    entry.isDeleted ? "" : commentContentText(entry.contentRich),
  );
  const text = entry.isDeleted
    ? "Deleted comment"
    : commentContentText(entry.contentRich);
  const own = entry.userId === actions.currentUserId;
  const canDelete = own || actions.canEdit;
  return (
    <div
      className={cn(
        "rounded-button bg-surface-hover-bg px-3 py-2",
        depth === 1 && "ml-5",
      )}
    >
      <p className="font-medium text-fg-muted text-xs">
        {userName(actions, entry.userId)}
      </p>
      {editing ? (
        <div className="mt-1 flex flex-col gap-1">
          <Textarea
            onChange={(event) => setEditText(event.target.value)}
            rows={2}
            value={editText}
          />
          <div className="flex gap-1">
            <Button
              onClick={() =>
                void actions
                  .updateComment(entry.id, editText.trim())
                  .then(() => setEditing(false))
              }
              size="sm"
            >
              Save
            </Button>
            <Button onClick={() => setEditing(false)} size="sm" variant="ghost">
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p
          className={cn(
            "text-fg text-sm",
            entry.isDeleted && "text-fg-muted italic",
          )}
        >
          {text}
        </p>
      )}
      {!entry.isDeleted && (
        <div className="mt-1 flex gap-1">
          {canReplyAtDepth(depth, actions.canComment) && (
            <Button
              onClick={() => {
                setReplyTo(entry.id);
                setReply("");
              }}
              size="sm"
              variant="ghost"
            >
              Reply
            </Button>
          )}
          {own && (
            <Button onClick={() => setEditing(true)} size="sm" variant="ghost">
              Edit
            </Button>
          )}
          {canDelete && (
            <Button
              onClick={() => actions.deleteComment(entry)}
              size="sm"
              variant="ghost"
            >
              Delete
            </Button>
          )}
        </div>
      )}
      {replyTo === entry.id && depth === 0 && (
        <div className="mt-2 flex gap-2">
          <Textarea
            aria-label="Reply"
            className="min-h-14 flex-1"
            onChange={(event) => setReply(event.target.value)}
            rows={2}
            value={reply}
          />
          <Button
            disabled={!reply.trim()}
            onClick={() =>
              void actions
                .addReply(discussionId, entry.id, reply.trim())
                .then(() => {
                  setReply("");
                  setReplyTo(null);
                })
            }
            size="sm"
            variant="outline"
          >
            Reply
          </Button>
        </div>
      )}
      {entry.replies.map((child) => (
        <CommentEntry
          depth={1}
          discussionId={discussionId}
          entry={child}
          key={child.id}
          reply={reply}
          replyTo={replyTo}
          setReply={setReply}
          setReplyTo={setReplyTo}
        />
      ))}
    </div>
  );
}

export function CommentToolbarActions() {
  const actions = useCollaborationActions();
  const { mode } = useEditorRuntime();
  if (!actions || mode !== 'suggestion') return null;
  return (
    <>
      <Button
        disabled={!actions.suggestionDirty || actions.mutationPending}
        onClick={actions.submitSuggestion}
        size="sm"
        variant="accent"
      >
        Submit suggestion
      </Button>
      <Button
        disabled={!actions.suggestionDirty || actions.mutationPending}
        onClick={actions.discardSuggestion}
        size="sm"
        variant="ghost"
      >
        Discard
      </Button>
    </>
  );
}
