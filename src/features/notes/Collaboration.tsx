import {
  relativeRangeToSlateRange,
  slateRangeToRelativeRange,
  type YjsEditor,
} from '@slate-yjs/core';
import { NodeApi, type Path, PathApi, RangeApi, type TElement } from 'platejs';
import {
  createPlatePlugin,
  type PlateElementProps,
  PlateLeaf,
  type PlateLeafProps,
  useEditorRef,
} from 'platejs/react';
import {
  createContext,
  Fragment,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as Y from 'yjs';
import {
  useCreateMaterialComment,
  useCreateMaterialDiscussion,
  useDeleteMaterialComment,
  useDeleteMaterialDiscussion,
  useMe,
  useUpdateMaterialComment,
} from '@/api/hooks';
import type { MaterialComment, MaterialDiscussion } from '@/api/types';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { IconButton } from '@/components/ui/IconButton';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import { Textarea } from '@/components/ui/TextArea';
import type { MaterialValue } from '@/features/materials/document';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { EditorIcon } from '@/features/notes/EditorIcon';
import { getLocale, m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';
import { firstLineMiddle } from './BlockInteractions';
import { useEditorRuntime } from './EditorRuntime';

const COMMENT_DECORATION_KEY = 'capy_comment_highlight';

export interface EditorCollaborationOptions {
  currentUserId: string | null;
  discussions: MaterialDiscussion[];
}

export interface CollaborationActions {
  addComment: (discussionId: string, text: string) => Promise<void>;
  canEdit: boolean;
  collaborationError: string | null;
  currentUserId: string | null;
  deleteComment: (comment: MaterialComment) => void;
  deleteDiscussion: (discussion: MaterialDiscussion) => void;
  discussions: MaterialDiscussion[];
  /** Only the workspace owner deletes another user's comment. */
  isOwner: boolean;
  mutationPending: boolean;
  openComment: () => void;
  updateComment: (commentId: string, text: string) => Promise<void>;
}

const CollaborationActionsContext = createContext<CollaborationActions | null>(
  null
);

export function useCollaborationActions() {
  return useContext(CollaborationActionsContext);
}

/**
 * Threads indexed by block. Kept separate from the action context on purpose:
 * `BlockDiscussionContent` renders above *every* node, so whichever context it
 * subscribes to is read thousands of times per document. Subscribing it to the
 * action bag would make an unrelated change — a pending comment mutation, a
 * dialog error — force React to walk and re-render the whole document.
 */
const NO_THREADS = new Map<string, MaterialDiscussion[]>();
const BlockDiscussionsContext =
  createContext<Map<string, MaterialDiscussion[]>>(NO_THREADS);

function discussionsByBlock(discussions: MaterialDiscussion[]) {
  if (discussions.length === 0) return NO_THREADS;
  const index = new Map<string, MaterialDiscussion[]>();
  for (const discussion of discussions) {
    if (!discussion.blockId) continue;
    const existing = index.get(discussion.blockId);
    if (existing) existing.push(discussion);
    else index.set(discussion.blockId, [discussion]);
  }
  return index;
}

function bytesToBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function resolveCommentDecorations(
  editor: YjsEditor & ReturnType<typeof useEditorRef>,
  discussions: MaterialDiscussion[]
) {
  const decorations: Array<Record<string, unknown>> = [];
  if (!editor.sharedRoot) return decorations;
  for (const discussion of discussions) {
    if (!(discussion.anchorStart && discussion.anchorEnd)) continue;
    try {
      const range = relativeRangeToSlateRange(editor.sharedRoot, editor, {
        anchor: Y.decodeRelativePosition(base64ToBytes(discussion.anchorStart)),
        focus: Y.decodeRelativePosition(base64ToBytes(discussion.anchorEnd)),
      });
      if (range) {
        decorations.push({
          ...range,
          [COMMENT_DECORATION_KEY]: true,
          commentId: discussion.id,
        });
      }
    } catch {
      // Deleted or schema-incompatible anchors remain visible as block threads.
    }
  }
  return decorations;
}

function CommentDecorationLeaf(props: PlateLeafProps) {
  return (
    <PlateLeaf
      {...props}
      // text-inherit neutralises the UA `mark { color: MarkText }` default.
      as="mark"
      attributes={{
        ...props.attributes,
        'data-comment-decoration': 'true',
      }}
      className={cn(
        props.className,
        'rounded-sm bg-tint-accent-2 text-inherit underline decoration-2 decoration-action-accent/50 underline-offset-2'
      )}
    >
      {props.children}
    </PlateLeaf>
  );
}

export const commentDecorationPlugin = createPlatePlugin({
  key: COMMENT_DECORATION_KEY,
  node: { isLeaf: true },
  render: { node: CommentDecorationLeaf },
});

const BlockDiscussion = () => (props: PlateElementProps) => (
  <BlockDiscussionContent {...props} />
);

function BlockDiscussionContent({
  children,
  element,
  path,
}: PlateElementProps) {
  const isTopLevel = path.length === 1;
  const blockId =
    typeof element.id === 'string' && element.id.trim() ? element.id : null;
  const threads = useContext(BlockDiscussionsContext).get(
    isTopLevel && blockId ? blockId : ''
  );

  if (!isTopLevel) return <>{children}</>;
  if (!threads?.length) return <div className="w-full">{children}</div>;

  return (
    <BlockDiscussionThreads element={element} threads={threads}>
      {children}
    </BlockDiscussionThreads>
  );
}

/** Only mounted for the handful of blocks that actually carry a thread, so it
 * is free to subscribe to the full action bag. */
function BlockDiscussionThreads({
  children,
  element,
  threads: discussions,
}: {
  children: React.ReactNode;
  element: TElement;
  threads: MaterialDiscussion[];
}) {
  const actions = useCollaborationActions();
  const editor = useEditorRef();
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const [triggerTop, setTriggerTop] = useState(4);
  // Center the 28px trigger on the first line, like the drag handle.
  useLayoutEffect(() => {
    const middle = rowRef.current
      ? firstLineMiddle(editor, element, rowRef.current)
      : null;
    if (middle !== null) setTriggerTop(middle - 14);
  }, [editor, element]);
  if (!actions) return <div className="w-full">{children}</div>;

  return (
    <div className="flex w-full justify-between" ref={rowRef}>
      <Popover onOpenChange={setOpen} open={open}>
        <div className="min-w-0 flex-1">{children}</div>
        <PopoverContent
          align="start"
          className="max-h-[min(60dvh,var(--radix-popper-available-height))] w-90 max-w-[calc(100vw-24px)] gap-0 overflow-y-auto px-1 py-1.5 shadow-card"
          contentEditable={false}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => event.preventDefault()}
          side="left"
          sideOffset={8}
        >
          {discussions.map((discussion, index) => (
            <Fragment key={discussion.id}>
              {index > 0 && (
                <div className="-mx-1 my-1.5 border-divider border-t" />
              )}
              <DiscussionThread discussion={discussion} />
            </Fragment>
          ))}
          {actions.collaborationError && (
            <p className="px-2 py-1.5 text-sm text-solid-error">
              {actions.collaborationError}
            </p>
          )}
        </PopoverContent>
        <div className="relative size-0 select-none">
          <PopoverTrigger asChild>
            <Button
              aria-label={
                discussions.length === 1
                  ? m.editor_show_threads({
                      count: String(discussions.length),
                    })
                  : m.editor_show_threads_plural({
                      count: String(discussions.length),
                    })
              }
              className="ml-0.5 h-7 min-w-7 gap-1 rounded-button px-1.5 py-0 text-fg-muted data-[state=open]:bg-surface-hover-bg"
              contentEditable={false}
              size="sm"
              style={{ marginTop: triggerTop }}
              variant="ghost-hover"
            >
              <EditorIcon className="size-4 shrink-0" name="comment" />
              <span className="font-semibold text-xs">
                {discussions.length}
              </span>
            </Button>
          </PopoverTrigger>
        </div>
      </Popover>
    </div>
  );
}

export const discussionPlugin = createPlatePlugin({
  key: 'capy-discussions',
  options: {
    currentUserId: null as string | null,
    discussions: [] as MaterialDiscussion[],
  },
  render: { aboveNodes: BlockDiscussion as never },
});

function richComment(text: string): MaterialValue {
  return [{ children: [{ text }], type: 'p' }];
}

export function CollaborationProvider({
  children,
  discussions,
  currentUserId,
}: {
  children: React.ReactNode;
  discussions: MaterialDiscussion[];
  currentUserId: string | null;
}) {
  const editor = useEditorRef();
  const { materialId, canEdit, role } = useEditorRuntime();
  const { isPending: deleteDiscussionIsPending, mutate: deleteDiscussion } =
    useDeleteMaterialDiscussion(materialId);
  const {
    isPending: createDiscussionIsPending,
    mutateAsync: createDiscussion,
  } = useCreateMaterialDiscussion(materialId);
  const { isPending: addCommentIsPending, mutateAsync: addComment } =
    useCreateMaterialComment(materialId);
  const { isPending: updateCommentIsPending, mutateAsync: updateComment } =
    useUpdateMaterialComment(materialId);
  const { isPending: deleteCommentIsPending, mutate: deleteComment } =
    useDeleteMaterialComment(materialId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const commentTarget = useRef<{
    blockId: string;
    selection: NonNullable<typeof editor.selection>;
  } | null>(null);
  const mutationPending =
    deleteDiscussionIsPending ||
    createDiscussionIsPending ||
    addCommentIsPending ||
    updateCommentIsPending ||
    deleteCommentIsPending;

  const fail = (cause: unknown, fallback: string) =>
    setError(errorCopy(cause, fallback));

  async function submitNewComment() {
    const text = comment.trim();
    const target = commentTarget.current;
    if (!text || !target) return;
    const { blockId, selection } = target;
    const yjsEditor = editor as typeof editor & YjsEditor;
    if (!yjsEditor.sharedRoot) {
      setError(m.editor_collab_not_ready());
      return;
    }
    try {
      const relative = RangeApi.isCollapsed(selection)
        ? null
        : slateRangeToRelativeRange(yjsEditor.sharedRoot, editor, selection);
      await createDiscussion({
        ...(relative && {
          anchorEnd: bytesToBase64(Y.encodeRelativePosition(relative.focus)),
          anchorQuote: editor.api.string(selection).slice(0, 1000),
          anchorStart: bytesToBase64(Y.encodeRelativePosition(relative.anchor)),
        }),
        anchorVersion: 1,
        blockId,
        contentRich: richComment(text),
      });
      commentTarget.current = null;
      setDialogOpen(false);
      setComment('');
    } catch (cause) {
      fail(cause, m.editor_comment_add_failed());
    }
  }

  const actions = useMemo<CollaborationActions>(
    () => ({
      addComment: async (discussionId, text) => {
        await addComment({
          contentRich: richComment(text),
          discussionId,
        });
      },
      canEdit,
      collaborationError: error,
      currentUserId,
      deleteComment: (entry) => {
        if (!window.confirm(m.editor_delete_comment_confirm())) return;
        deleteComment(entry.id);
      },
      deleteDiscussion: (discussion) => {
        if (!window.confirm(m.editor_delete_thread_confirm())) return;
        deleteDiscussion(discussion.id);
      },
      discussions,
      isOwner: role === 'owner',
      mutationPending,
      openComment: () => {
        if (!canEdit) return;
        // A toolbar click can precede Slate's throttled native selection sync.
        const nativeSelection = editor.api.getWindow()?.getSelection();
        const selection =
          nativeSelection &&
          editor.api.hasSelectableTarget(nativeSelection.anchorNode) &&
          editor.api.hasTarget(nativeSelection.focusNode)
            ? editor.api.toSlateRange(nativeSelection, {
                exactMatch: false,
                suppressThrow: true,
              })
            : editor.selection;
        if (!selection) return;
        const blockId = editor.api.node([selection.anchor.path[0]])?.[0]?.id;
        if (typeof blockId !== 'string' || !blockId) return;
        commentTarget.current = {
          blockId,
          selection: structuredClone(selection),
        };
        setComment('');
        setError(null);
        setDialogOpen(true);
      },
      updateComment: async (commentId, text) => {
        await updateComment({
          commentId,
          contentRich: richComment(text),
        });
      },
    }),
    [
      addComment,
      canEdit,
      currentUserId,
      deleteComment,
      deleteDiscussion,
      discussions,
      editor,
      error,
      mutationPending,
      role,
      updateComment,
    ]
  );
  const threadsByBlock = useMemo(
    () => discussionsByBlock(discussions),
    [discussions]
  );

  return (
    <CollaborationActionsContext.Provider value={actions}>
      <BlockDiscussionsContext.Provider value={threadsByBlock}>
        {children}
      </BlockDiscussionsContext.Provider>
      <SimpleDialog
        footer={
          <>
            <Button
              onClick={() => {
                commentTarget.current = null;
                setDialogOpen(false);
              }}
              size="lg"
              variant="ghost-hover"
            >
              {m.action_cancel()}
            </Button>
            <Button
              disabled={!comment.trim() || createDiscussionIsPending}
              onClick={() => void submitNewComment()}
              size="lg"
              variant="accent"
            >
              {m.editor_add_comment()}
            </Button>
          </>
        }
        onClose={() => {
          commentTarget.current = null;
          setDialogOpen(false);
        }}
        open={dialogOpen}
        title={m.editor_add_comment()}
      >
        <label className="mt-3 flex flex-col gap-1.5">
          <Textarea
            aria-label={m.editor_comment()}
            onChange={(event) => setComment(event.target.value)}
            rows={4}
            value={comment}
          />
        </label>
      </SimpleDialog>
    </CollaborationActionsContext.Provider>
  );
}

// Authors travel with the thread, so a contributor who has since left the
// workspace stays attributed and readers without a member roster still see who
// wrote what.
function authorName(entry: { authorName?: string }) {
  return entry.authorName?.trim() || m.editor_unknown_user();
}

function DiscussionThread({ discussion }: { discussion: MaterialDiscussion }) {
  const actions = useCollaborationActions();
  const [reply, setReply] = useState('');
  const { data: me } = useMe({ errorBoundary: false });
  if (!actions) return null;
  const send = () => {
    const text = reply.trim();
    if (!text || actions.mutationPending) return;
    // Keep anything typed while the request was in flight.
    void actions
      .addComment(discussion.id, text)
      .then(() =>
        setReply((current) => (current.trim() === text ? '' : current))
      );
  };
  return (
    <section>
      {discussion.comments.map((entry, index) => (
        <CommentEntry
          discussion={discussion}
          entry={entry}
          isFirst={index === 0}
          key={entry.id}
        />
      ))}
      {actions.canEdit && (
        <div className="flex items-center gap-2 px-2 py-1.5">
          <Avatar
            className="size-6 text-[10px]"
            name={me?.name}
            src={me?.avatarUrl}
          />
          <Textarea
            aria-label={m.editor_reply()}
            className="min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent px-0 py-0.5 focus:border-0"
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                send();
              }
            }}
            placeholder={m.editor_reply_placeholder()}
            rows={1}
            value={reply}
          />
          <IconButton
            className="size-7 p-0"
            disabled={!reply.trim() || actions.mutationPending}
            icon="arrowRight"
            label={m.editor_reply()}
            onClick={send}
            size="sm"
            variant="ghost-hover"
          />
        </div>
      )}
    </section>
  );
}

function commentContentText(contentRich: unknown): string {
  if (!Array.isArray(contentRich)) return '';
  return contentRich
    .filter(
      (node): node is Record<string, unknown> =>
        !!node && typeof node === 'object' && !Array.isArray(node)
    )
    .map((node) => NodeApi.string(node as never))
    .join('\n');
}

const DAY_MS = 86_400_000;

/** Relative within a day ("10 minutes ago"), a short date after that. */
function commentTime(iso: string) {
  const date = new Date(iso);
  if (Date.now() - date.getTime() < DAY_MS) return relativeTime(iso);
  return date.toLocaleDateString(getLocale(), {
    day: 'numeric',
    month: 'short',
    year:
      date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
}

function CommentEntry({
  discussion,
  entry,
  isFirst,
}: {
  discussion: MaterialDiscussion;
  entry: MaterialComment;
  isFirst: boolean;
}) {
  const actions = useCollaborationActions()!;
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const own = entry.userId === actions.currentUserId;
  const menu: MenuItem[] = [];
  if (!entry.isDeleted && own && actions.canEdit) {
    menu.push({
      icon: 'pencil',
      label: m.action_edit(),
      onClick: () => {
        setEditText(commentContentText(entry.contentRich));
        setEditing(true);
      },
    });
  }
  // The first comment stands for the thread, so deleting it removes the thread.
  if (
    isFirst &&
    (discussion.userId === actions.currentUserId || actions.isOwner)
  ) {
    menu.push({
      danger: true,
      icon: 'trash',
      label: m.editor_delete_thread(),
      onClick: () => actions.deleteDiscussion(discussion),
    });
  } else if (!(isFirst || entry.isDeleted) && (own || actions.isOwner)) {
    menu.push({
      danger: true,
      icon: 'trash',
      label: m.action_delete(),
      onClick: () => actions.deleteComment(entry),
    });
  }
  return (
    <div className="group/comment rounded-lg px-2 py-1.5 hover:bg-surface-hover-bg has-data-[state=open]:bg-surface-hover-bg">
      <div className="flex min-h-6 items-center gap-2">
        <Avatar
          className="size-6 text-[10px]"
          name={authorName(entry)}
          src={entry.authorAvatarUrl}
        />
        <span className="min-w-0 truncate font-bold">{authorName(entry)}</span>
        <time
          className="mr-auto shrink-0 text-fg-muted text-xs"
          dateTime={entry.createdAt}
          title={new Date(entry.createdAt).toLocaleString(getLocale())}
        >
          {commentTime(entry.createdAt)}
        </time>
        {menu.length > 0 && (
          <Menu
            className="min-w-36"
            items={menu}
            trigger={
              <IconButton
                className="size-6 p-0 opacity-0 focus-visible:opacity-100 group-hover/comment:opacity-100 data-[state=open]:opacity-100"
                icon="moreVertical"
                label={m.a11y_open_menu()}
                size="sm"
                variant="ghost-hover"
              />
            }
          />
        )}
      </div>
      <div className="pl-8">
        {isFirst && discussion.anchorQuote && (
          <p className="mt-0.5 mb-1 line-clamp-1 border-action-accent border-l-2 pl-2 text-[13px] text-fg-muted">
            {discussion.anchorQuote}
          </p>
        )}
        {editing ? (
          <div className="mt-1 flex flex-col gap-1.5">
            <Textarea
              aria-label={m.editor_comment()}
              autoFocus
              className="min-h-13 resize-none rounded-lg px-2 py-1.5"
              onChange={(event) => setEditText(event.target.value)}
              value={editText}
            />
            <div className="flex justify-end gap-1">
              <Button
                onClick={() => setEditing(false)}
                size="sm"
                variant="ghost-hover"
              >
                {m.action_cancel()}
              </Button>
              <Button
                disabled={!editText.trim()}
                onClick={() =>
                  void actions
                    .updateComment(entry.id, editText.trim())
                    .then(() => setEditing(false))
                }
                size="sm"
                variant="ghost-hover"
              >
                {m.action_save()}
              </Button>
            </div>
          </div>
        ) : entry.isDeleted ? (
          <p className="text-fg-muted italic">{m.editor_deleted_comment()}</p>
        ) : (
          <p className="whitespace-pre-wrap break-words">
            {commentContentText(entry.contentRich)}
            {entry.isEdited && (
              <span className="text-fg-muted text-xs">
                {' '}
                {m.editor_edited()}
              </span>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

// The comment ranges a node's decorate returns: those from its start path to
// its end path, compared as paths (a block above either end compares equal).
export function commentDecorationRangesForEntry(
  entry: [unknown, Path],
  decorations: Array<Record<string, unknown>>
) {
  const [, path] = entry;
  return decorations.filter((range) => {
    const anchor = range.anchor as { path: Path } | undefined;
    const focus = range.focus as { path: Path } | undefined;
    if (!(anchor && focus)) return false;
    return (
      PathApi.compare(path, anchor.path) >= 0 &&
      PathApi.compare(path, focus.path) <= 0
    );
  });
}
