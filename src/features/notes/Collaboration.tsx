import {
  relativeRangeToSlateRange,
  slateRangeToRelativeRange,
  type YjsEditor,
} from '@slate-yjs/core';
import { MessageSquareText, X } from 'lucide-react';
import { NodeApi, type Path } from 'platejs';
import {
  createPlatePlugin,
  type PlateElementProps,
  PlateLeaf,
  type PlateLeafProps,
  useEditorRef,
} from 'platejs/react';
import { createContext, useContext, useRef, useState } from 'react';
import * as Y from 'yjs';
import {
  useCreateMaterialComment,
  useCreateMaterialDiscussion,
  useDeleteMaterialComment,
  useDeleteMaterialDiscussion,
  useResolveMaterialDiscussion,
  useUpdateMaterialComment,
} from '@/api/hooks';
import type {
  MaterialComment,
  MaterialDiscussion,
  WorkspaceMember,
} from '@/api/types';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { InputTitle } from '@/components/ui/Input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import { Textarea } from '@/components/ui/TextArea';
import type { MaterialValue } from '@/features/materials/document';
import { cn } from '@/lib/cn';
import { canReplyAtDepth } from './canReplyAtDepth';
import { useEditorRuntime } from './EditorRuntime';
import type { NoteEditorMode } from './editorMode';

const COMMENT_DECORATION_KEY = 'evo_comment_highlight';

export interface EditorCollaborationOptions {
  currentUserId: string | null;
  discussions: MaterialDiscussion[];
  mode: NoteEditorMode;
  users: Record<string, WorkspaceMember>;
}

export interface CollaborationActions {
  addComment: (discussionId: string, text: string) => Promise<void>;
  addReply: (
    discussionId: string,
    parentCommentId: string,
    text: string
  ) => Promise<void>;
  canComment: boolean;
  canEdit: boolean;
  collaborationError: string | null;
  currentUserId: string | null;
  deleteComment: (comment: MaterialComment) => void;
  deleteDiscussion: (discussion: MaterialDiscussion) => void;
  discussions: MaterialDiscussion[];
  mutationPending: boolean;
  openComment: () => void;
  resolve: (discussion: MaterialDiscussion) => void;
  updateComment: (commentId: string, text: string) => Promise<void>;
  users: Record<string, WorkspaceMember>;
}

const CollaborationActionsContext = createContext<CollaborationActions | null>(
  null
);

export function useCollaborationActions() {
  return useContext(CollaborationActionsContext);
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
      className={cn(
        props.className,
        'rounded-sm bg-tint-accent-2 underline decoration-2 decoration-action-accent/50 underline-offset-2'
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
  editor,
  element,
}: PlateElementProps) {
  const actions = useCollaborationActions();
  const path = editor.api.findPath(element);
  const isTopLevel = path?.length === 1;
  const blockId =
    typeof element.id === 'string' && element.id.trim() ? element.id : null;
  const discussions =
    actions?.discussions.filter((item) => item.blockId === blockId) ?? [];
  const [open, setOpen] = useState(false);

  if (!isTopLevel) return <>{children}</>;
  if (!actions || discussions.length === 0)
    return <div className="w-full">{children}</div>;

  return (
    <div className="flex w-full justify-between">
      <Popover onOpenChange={setOpen} open={open}>
        <div className="min-w-0 flex-1">{children}</div>
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
            <p className="font-semibold text-fg-muted text-xs">Comments</p>
            <Button
              aria-label="Close comments"
              onClick={() => setOpen(false)}
              size="sm"
              variant="ghost"
            >
              <X className="size-4" />
            </Button>
          </div>
          <div className="flex flex-col gap-2 p-2">
            {discussions.map((discussion) => (
              <DiscussionThread discussion={discussion} key={discussion.id} />
            ))}
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
              aria-label={`Show ${discussions.length} comment thread${discussions.length === 1 ? '' : 's'}`}
              className="mt-1 ml-1 h-7 min-w-7 gap-1 rounded-button px-1.5 py-0 text-fg-muted data-[state=open]:bg-surface-hover-bg"
              contentEditable={false}
              size="sm"
              variant="ghost-hover"
            >
              <MessageSquareText className="size-4 shrink-0" />
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
  key: 'evo-discussions',
  options: {
    currentUserId: null as string | null,
    discussions: [] as MaterialDiscussion[],
    users: {} as Record<string, WorkspaceMember>,
  },
  render: { aboveNodes: BlockDiscussion as never },
});

function richComment(text: string): MaterialValue {
  return [{ children: [{ text }], type: 'p' }];
}

export function CollaborationProvider({
  children,
  discussions,
  users,
  currentUserId,
}: {
  children: React.ReactNode;
  discussions: MaterialDiscussion[];
  users: Record<string, WorkspaceMember>;
  currentUserId: string | null;
}) {
  const editor = useEditorRef();
  const { materialId, canEdit, canComment } = useEditorRuntime();
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
  const { isPending: resolveDiscussionIsPending, mutate: resolveDiscussion } =
    useResolveMaterialDiscussion(materialId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const commentSelection = useRef<NonNullable<typeof editor.selection> | null>(
    null
  );
  const mutationPending =
    deleteDiscussionIsPending ||
    createDiscussionIsPending ||
    addCommentIsPending ||
    updateCommentIsPending ||
    deleteCommentIsPending ||
    resolveDiscussionIsPending;

  const fail = (cause: unknown, fallback: string) =>
    setError(cause instanceof Error ? cause.message : fallback);

  async function submitNewComment() {
    const text = comment.trim();
    const selection = commentSelection.current;
    if (!text || !selection) return;
    const yjsEditor = editor as typeof editor & YjsEditor;
    if (!yjsEditor.sharedRoot) {
      setError('The collaborative document is not ready yet.');
      return;
    }
    try {
      const relative = slateRangeToRelativeRange(
        yjsEditor.sharedRoot,
        editor,
        selection
      );
      const blockId = editor.api.node([selection.anchor.path[0]])?.[0]?.id as
        | string
        | undefined;
      const quote = editor.api.string(selection);
      await createDiscussion({
        anchorEnd: bytesToBase64(Y.encodeRelativePosition(relative.focus)),
        anchorQuote: quote.slice(0, 1000),
        anchorStart: bytesToBase64(Y.encodeRelativePosition(relative.anchor)),
        anchorVersion: 1,
        blockId,
        contentRich: richComment(text),
      });
      commentSelection.current = null;
      setDialogOpen(false);
      setComment('');
    } catch (cause) {
      fail(cause, 'Unable to add comment');
    }
  }

  const actions: CollaborationActions = {
    addComment: async (discussionId, text) => {
      await addComment({
        contentRich: richComment(text),
        discussionId,
      });
    },
    addReply: async (discussionId, parentCommentId, text) => {
      await addComment({
        contentRich: richComment(text),
        discussionId,
        parentCommentId,
      });
    },
    canComment,
    canEdit,
    collaborationError: error,
    currentUserId,
    deleteComment: (entry) => {
      if (!window.confirm('Delete this comment?')) return;
      deleteComment(entry.id);
    },
    deleteDiscussion: (discussion) => {
      if (!window.confirm('Delete this comment thread?')) return;
      deleteDiscussion(discussion.id);
    },
    discussions,
    mutationPending,
    openComment: () => {
      if (!canComment || !editor.selection || editor.api.isCollapsed()) return;
      commentSelection.current = structuredClone(editor.selection);
      setComment('');
      setError(null);
      setDialogOpen(true);
    },
    resolve: (discussion) =>
      resolveDiscussion({
        discussionId: discussion.id,
        isResolved: !discussion.isResolved,
      }),
    updateComment: async (commentId, text) => {
      await updateComment({
        commentId,
        contentRich: richComment(text),
      });
    },
    users,
  };

  return (
    <CollaborationActionsContext.Provider value={actions}>
      {children}
      <SimpleDialog
        footer={
          <>
            <Button
              onClick={() => {
                commentSelection.current = null;
                setDialogOpen(false);
              }}
              variant="ghost-hover"
            >
              Cancel
            </Button>
            <Button
              disabled={!comment.trim() || createDiscussionIsPending}
              onClick={() => void submitNewComment()}
            >
              Add comment
            </Button>
          </>
        }
        onClose={() => {
          commentSelection.current = null;
          setDialogOpen(false);
        }}
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
  return actions.users[userId]?.name ?? 'Unknown user';
}

export function DiscussionThread({
  discussion,
}: {
  discussion: MaterialDiscussion;
}) {
  const actions = useCollaborationActions();
  if (!actions) return null;
  const canDeleteThread =
    discussion.userId === actions.currentUserId || actions.canEdit;
  return (
    <section
      className={cn(
        'rounded-card border border-line p-3',
        discussion.isResolved && 'opacity-65'
      )}
    >
      {discussion.anchorQuote && (
        <p className="mb-2 line-clamp-2 border-action-accent border-l-2 pl-2 text-fg-muted text-xs">
          {discussion.anchorQuote}
        </p>
      )}
      <DiscussionComments discussion={discussion} />
      <div className="mt-2 flex flex-wrap gap-1">
        {actions.canComment && (
          <Button
            onClick={() => actions.resolve(discussion)}
            size="sm"
            variant="ghost"
          >
            {discussion.isResolved ? 'Reopen' : 'Resolve'}
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
  const [reply, setReply] = useState('');
  const [comment, setComment] = useState('');
  const actions = useCollaborationActions();

  return (
    <div className="flex flex-col gap-2">
      {discussion.comments.map((entry) => (
        <CommentEntry
          depth={0}
          discussionId={discussion.id}
          entry={entry}
          key={entry.id}
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
                .then(() => setComment(''))
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
  if (!Array.isArray(contentRich)) return '';
  return contentRich
    .filter(
      (node): node is Record<string, unknown> =>
        !!node && typeof node === 'object' && !Array.isArray(node)
    )
    .map((node) => NodeApi.string(node as never))
    .join('\n');
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
    entry.isDeleted ? '' : commentContentText(entry.contentRich)
  );
  const text = entry.isDeleted
    ? 'Deleted comment'
    : commentContentText(entry.contentRich);
  const own = entry.userId === actions.currentUserId;
  const canDelete = own || actions.canEdit;
  return (
    <div
      className={cn(
        'rounded-button bg-surface-hover-bg px-3 py-2',
        depth === 1 && 'ml-5'
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
            'text-fg text-sm',
            entry.isDeleted && 'text-fg-muted italic'
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
                setReply('');
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
                  setReply('');
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

export function commentDecorationRangesForEntry(
  entry: [unknown, Path],
  decorations: Array<Record<string, unknown>>
) {
  const [, path] = entry;
  return decorations.filter((range) => {
    const anchor = range.anchor as { path: Path } | undefined;
    const focus = range.focus as { path: Path } | undefined;
    if (!(anchor && focus)) return false;
    const start = anchor.path.join('.');
    const end = focus.path.join('.');
    const current = path.join('.');
    return current >= start && current <= end;
  });
}
