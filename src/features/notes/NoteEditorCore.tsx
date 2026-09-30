import { YjsPlugin } from '@platejs/yjs/react';
import { useQueryClient } from '@tanstack/react-query';
import type { Path } from 'platejs';
import type { PlateEditor } from 'platejs/react';
import {
  Plate,
  PlateContainer,
  PlateContent,
  useEditorRef,
  useEditorSelector,
  usePlateEditor,
} from 'platejs/react';
import {
  type ComponentProps,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { defaultScrollSelectionIntoView, type ReactEditor } from 'slate-react';
import * as Y from 'yjs';
import { USE_MSW } from '@/api/auth';
import { qk } from '@/api/client';
import {
  getMaterialCollaborationToken,
  type useMaterialDiscussions,
} from '@/api/hooks';
import type { Material, MaterialCollaborationToken } from '@/api/types';
import { FileLoading } from '@/features/files/FileStates';
import {
  type MaterialValue,
  parseMaterialDocument,
} from '@/features/materials/document';
import { NoteToolbar } from '@/features/notes/toolbar/NoteToolbar';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { MATERIAL_DOCUMENT_LIMITS } from '@/lib/const';
import { editorAiEnabled } from '@/lib/features';
import { AiMenu } from './ai/AiMenu';
import { NoteBlockDialogsProvider } from './blocks/dialogContext';
import {
  CollaborationProvider,
  commentDecorationRangesForEntry,
  resolveCommentDecorations,
} from './Collaboration';
import {
  COLLABORATION_READ_ONLY_REASON,
  type MaterialDocumentStats,
  type MaterialLimitCode,
  materialLimitMessage,
  parseCollaborationEvent,
} from './collaborationEvents';
import {
  contentSizeKilobytes,
  formatContentSize,
  shouldShowDocumentStats,
} from './documentStats';
import { EditorCommandPalette } from './EditorCommandPalette';
import type { NoteEditorStatus } from './editorMode';
import { FloatingToolbar } from './FloatingToolbar';
import { noteComponents } from './nodeComponents';
import { useNoteEditorPrefs } from './noteEditorPrefs';
import { buildPlugins } from './plugins';
import {
  remoteCursorRangesForEntry,
  useRemoteCursorDecorations,
} from './RemoteCursors';
import {
  type RoomReconnector,
  roomReconnector,
  roomRefusal,
  socketOpen,
} from './roomConnection';

const CHECKPOINT_DEBOUNCE_MS = 1000;

interface StatelessProviderWrapper {
  isConnected: boolean;
  isSynced: boolean;
  provider: {
    connect(): unknown;
    disconnect(): void;
    sendStateless: (payload: string) => void;
  };
  type: string;
}

function roomProvider(editor: PlateEditor) {
  return editor
    .getOptions(YjsPlugin)
    ._providers.find((candidate) =>
      USE_MSW ? candidate.type === 'mock' : candidate.type === 'hocuspocus'
    ) as StatelessProviderWrapper | undefined;
}

/**
 * Asks the collaboration service for a durability receipt. Kept off the Y.Doc
 * on purpose: a marker written into the document would be an edit in its own
 * right, so acknowledging it would dirty the room and trigger a second store.
 */
function sendCheckpointRequest(editor: PlateEditor, id: string) {
  const provider = roomProvider(editor);
  if (!provider?.isConnected) return;
  provider.provider.sendStateless(
    JSON.stringify({ id, type: 'checkpoint-request' })
  );
}

function sameStats(a: MaterialDocumentStats, b: MaterialDocumentStats) {
  return (
    a.contentBytes === b.contentBytes &&
    a.maxDepth === b.maxDepth &&
    a.nodeCount === b.nodeCount
  );
}

function cursorColor(userId: string | null) {
  let hash = 0;
  for (const character of userId ?? 'anonymous') {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return `hsl(${hash % 360} 72% 48%)`;
}

function DocumentStatsFooter({
  limitError,
  stats,
}: {
  limitError: string | null;
  stats: MaterialDocumentStats;
}) {
  const displayWidth = useNoteEditorPrefs((state) => state.displayWidth);
  if (!(limitError || shouldShowDocumentStats(stats))) return null;
  return (
    <div
      aria-label={m.editor_doc_stats()}
      className={cn(
        'mx-auto mb-20 flex w-full gap-3 px-5 pb-4 text-fg-muted text-xs sm:px-10',
        displayWidth === 'half' && 'md:max-w-3xl'
      )}
    >
      <span
        className={cn(
          stats.nodeCount >= MATERIAL_DOCUMENT_LIMITS.maxNodes * 0.85 &&
            'text-solid-error'
        )}
      >
        {m.editor_stats_nodes({
          current: stats.nodeCount.toLocaleString(),
          max: MATERIAL_DOCUMENT_LIMITS.maxNodes.toLocaleString(),
        })}
      </span>
      <span
        className={cn(
          stats.maxDepth >= MATERIAL_DOCUMENT_LIMITS.maxDepth * 0.85 &&
            'text-solid-error'
        )}
      >
        {m.editor_stats_depth({
          current: String(stats.maxDepth),
          max: String(MATERIAL_DOCUMENT_LIMITS.maxDepth),
        })}
      </span>
      <span>
        {m.editor_stats_size({
          current: formatContentSize(stats.contentBytes),
          max: contentSizeKilobytes(
            MATERIAL_DOCUMENT_LIMITS.maxContentBytes
          ).toLocaleString(),
        })}
      </span>
      {limitError && (
        <span className="font-medium text-solid-error">{limitError}</span>
      )}
    </div>
  );
}

// Keep this component identity stable: changing Editable's `as` remounts Slate.
function NoteEditorSurface({ children, ...props }: ComponentProps<'div'>) {
  const displayWidth = useNoteEditorPrefs((state) => state.displayWidth);
  return (
    <div {...props}>
      <div
        className={cn(
          'mx-auto w-full px-5 sm:px-10',
          displayWidth === 'half' && 'md:max-w-3xl'
        )}
        data-note-content=""
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Memoized deliberately. Every prop change here re-renders all ~7k nodes of a
 * near-limit document, and the checkpoint acknowledgement updates footer stats
 * once per save — so the footer must not be able to reach this subtree. It only
 * needs to know whether the footer reserves space, not what the footer says.
 */
const NoteEditorContent = memo(function NoteEditorContent({
  discussions,
  shouldShowStats,
}: {
  discussions: NonNullable<ReturnType<typeof useMaterialDiscussions>['data']>;
  shouldShowStats: boolean;
}) {
  const editor = useEditorRef();
  const showEditorPlaceholder = useEditorSelector((current) => {
    const firstNode = current.children[0];
    return (
      current.children.length === 1 &&
      !!firstNode &&
      current.api.isEmpty(firstNode) &&
      current.api.isElementStateEmpty(firstNode)
    );
  }, []);
  const remoteCursors = useRemoteCursorDecorations(editor);
  // Read through refs so `decorate` keeps one identity: Plate treats a new
  // decorate function as new editable props and re-renders the whole document.
  const latest = useRef({ discussions, remoteCursors });
  latest.current = { discussions, remoteCursors };
  // Comment anchors resolve to Slate ranges that shift with the document, so
  // they are recomputed once per document version rather than once per node.
  const anchors = useRef<{
    discussions: unknown;
    ranges: ReturnType<typeof resolveCommentDecorations>;
    version: unknown;
  } | null>(null);

  const decorate = useCallback(
    ({ entry }: { entry: [unknown, Path] }) => {
      const { discussions: current, remoteCursors: cursors } = latest.current;
      if (
        anchors.current?.version !== editor.children ||
        anchors.current.discussions !== current
      ) {
        anchors.current = {
          discussions: current,
          ranges: resolveCommentDecorations(
            editor as Parameters<typeof resolveCommentDecorations>[0],
            current
          ),
          version: editor.children,
        };
      }
      return [
        ...commentDecorationRangesForEntry(entry, anchors.current.ranges),
        ...remoteCursorRangesForEntry(entry, cursors),
      ] as never;
    },
    [editor]
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Only the modifier combo jumps to the end of the note. Bare End is
      // end-of-line and Shift+End extends a selection; both stay native.
      const jumpToNoteEnd =
        event.key === 'End' &&
        !event.shiftKey &&
        (event.ctrlKey || event.metaKey);
      if (!jumpToNoteEnd) return;
      event.preventDefault();
      editor.tf.select(editor.api.end([]));
    },
    [editor]
  );

  return (
    <PlateContainer className="relative [&_.slate-selection-area]:z-50 [&_.slate-selection-area]:border [&_.slate-selection-area]:border-action-accent/25 [&_.slate-selection-area]:bg-action-accent/15">
      <PlateContent
        as={NoteEditorSurface}
        className={cn(
          'note-editor min-h-75 w-full pt-4 pb-36 text-base outline-none **:data-slate-placeholder:translate-y-1 **:data-slate-placeholder:text-placeholder **:data-slate-placeholder:text-sm **:data-slate-placeholder:leading-loose **:data-slate-placeholder:opacity-100!',
          shouldShowStats && 'pb-16'
        )}
        decorate={decorate}
        onKeyDown={onKeyDown}
        placeholder={showEditorPlaceholder ? m.editor_placeholder() : undefined}
        scrollSelectionIntoView={scrollSelectionIntoView}
      />
      {/* Share the editor's containing block so scrolling moves both natively. */}
      <FloatingToolbar />
    </PlateContainer>
  );
});

/**
 * A void block's caret (diagram, image, embed) sits at its top-left corner, so
 * the default scroll jumped a tall block back to its top whenever it
 * re-rendered, e.g. after a theme change. A void on screen stays put.
 */
const scrollSelectionIntoView: NonNullable<
  React.ComponentProps<typeof PlateContent>['scrollSelectionIntoView']
> = (editor, domRange) => {
  const block = domRange.startContainer.parentElement?.closest(
    '[data-slate-void="true"]'
  );
  const rect = block?.getBoundingClientRect();
  if (rect && rect.bottom > 0 && rect.top < window.innerHeight) return;
  // Plate types its editor narrowly; at runtime it is the slate-react one.
  defaultScrollSelectionIntoView(editor as unknown as ReactEditor, domRange);
};

export function NoteEditorCore({
  material,
  allowExternalAssets,
  discussions,
  currentUserId,
  currentUserName,
  collaborationToken,
  onEditorStatusChange,
  onDocumentRejected,
  onReadOnly,
  onSaveFailed,
  onUnavailable,
}: {
  material: Material;
  allowExternalAssets: boolean;
  discussions: NonNullable<ReturnType<typeof useMaterialDiscussions>['data']>;
  currentUserId: string;
  currentUserName: string;
  collaborationToken: MaterialCollaborationToken;
  onEditorStatusChange?: (status: NoteEditorStatus | null) => void;
  /** The room refused this editor's copy for good (a limit, an invalid
   * document, or an update from a writer who lost access): the caller
   * remounts onto the last saved version. `lostEdits`: unsaved work went. */
  onDocumentRejected?: (
    code: MaterialLimitCode | 'invalid_document' | 'revoked',
    lostEdits: boolean
  ) => void;
  /** The room turned read-only (a frozen account or an owner at its storage
   * limit): the caller drops to view, discarding unsaved edits. */
  onReadOnly?: () => void;
  /** Saving failed and the server (or the reconnect) is retrying. */
  onSaveFailed?: () => void;
  /** The note was trashed or deleted, or this user lost access to it. */
  onUnavailable?: (kind: 'notFound' | 'forbidden') => void;
}) {
  const qc = useQueryClient();
  const ydoc = useMemo(
    () => new Y.Doc({ gc: true }),
    [collaborationToken.room]
  );
  const checkpointTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Every unacknowledged receipt has to be tracked: a second edit before the
  // service answers the first must not orphan the earlier request.
  const pendingCheckpoints = useRef(new Set<string>());
  const unsavedChanges = useRef(false);
  const rejected = useRef(false);
  // After the first sync a dropped connection keeps the editor on screen.
  const hasSynced = useRef(false);
  const reconnector = useRef<RoomReconnector | null>(null);
  // The token request that failed, if one did: the provider only reports its
  // own "Failed to get token" text.
  const tokenError = useRef<unknown>(null);
  // Parsing normalizes and copies every node, so on a near-limit document this
  // costs seconds. It is the *initial* value — the room is authoritative from
  // sync onwards — so it is computed once per mount rather than on every
  // render that a status change or a projection refetch causes.
  const [initialValue] = useState<MaterialValue>(
    () =>
      parseMaterialDocument(material.content)?.value ??
      ([{ children: [{ text: '' }], type: 'p' }] as MaterialValue)
  );
  // Seeded from the last projection so the footer has numbers before the first
  // checkpoint receipt; the service owns every value after that.
  const [documentStats, setDocumentStats] = useState<MaterialDocumentStats>(
    () => ({
      contentBytes: material.contentBytes,
      maxDepth: material.maxDepth,
      nodeCount: material.nodeCount,
    })
  );
  const [documentLimitError, setDocumentLimitError] = useState<string | null>(
    null
  );
  const [saveState, setSaveState] =
    useState<NoteEditorStatus['saveState']>('connecting');
  const name = currentUserName;

  // The parent stores the reported status in state, so re-announcing a status it
  // already holds re-renders the whole document for nothing.
  const reportedStatus = useRef<string | null>(null);
  const setStatus = useCallback(
    (next: NoteEditorStatus['saveState']) => {
      setSaveState(next);
      if (reportedStatus.current === next) return;
      reportedStatus.current = next;
      onEditorStatusChange?.({ saveState: next });
    },
    [onEditorStatusChange]
  );

  const markSyncing = useCallback(() => {
    // Pending work must not hide connection failures or finish the handshake.
    if (
      reportedStatus.current === 'synced' ||
      reportedStatus.current === 'saved'
    ) {
      setStatus('syncing');
    }
  }, [setStatus]);

  const hasUnsavedWork = useCallback(
    () => unsavedChanges.current || pendingCheckpoints.current.size > 0,
    []
  );
  const connecting = useCallback(
    () => setStatus(hasSynced.current ? 'reconnecting' : 'connecting'),
    [setStatus]
  );

  // Plugin options are captured before the editor exists, so the handlers they
  // fire are reached through refs instead of becoming plugin dependencies.
  const saveNow = useRef(() => {});
  const resendCheckpoints = useRef(() => {});
  const reportRejection = useRef(onDocumentRejected);
  const reportSaveFailed = useRef(onSaveFailed);
  const reportUnavailable = useRef(onUnavailable);
  // Set once the editor exists; reports a room that turned read-only once.
  const readOnlyNow = useRef(() => {});
  const projectionStale = useRef(false);

  useEffect(
    () => () => {
      if (!projectionStale.current) return;
      projectionStale.current = false;
      void qc.invalidateQueries({ queryKey: qk.material(material.id) });
    },
    [qc, material.id]
  );

  const handleStatelessEvent = useCallback(
    (payload: string) => {
      const event = parseCollaborationEvent(payload);
      if (!event) return;
      if (
        event.type === 'checkpoint-persisted' &&
        event.materialId === material.id
      ) {
        setDocumentStats((previous) =>
          sameStats(previous, event.metrics) ? previous : event.metrics
        );
        setDocumentLimitError(
          event.limitCode
            ? `${materialLimitMessage(event.limitCode)} ${m.editor_limit_remove_only()}`
            : null
        );
        let acknowledged = false;
        for (const id of event.checkpointIds) {
          if (pendingCheckpoints.current.delete(id)) acknowledged = true;
        }
        if (
          acknowledged &&
          pendingCheckpoints.current.size === 0 &&
          !unsavedChanges.current &&
          (reportedStatus.current === 'syncing' ||
            reportedStatus.current === 'unsaved')
        ) {
          setStatus('saved');
        }
        return;
      }
      if (
        event.type === 'checkpoint-failed' &&
        event.materialId === material.id
      ) {
        // The receipts stay pending: the server's retry answers them.
        setStatus('unsaved');
        reportSaveFailed.current?.();
        return;
      }
      if (
        (event.type === 'document-rejected' &&
          event.materialId === material.id) ||
        (event.type === 'authorization-revoked' &&
          event.room === collaborationToken.room)
      ) {
        if (rejected.current) return;
        rejected.current = true;
        const lostEdits = hasUnsavedWork();
        pendingCheckpoints.current.clear();
        setStatus('error');
        reportRejection.current?.(
          event.type === 'document-rejected' ? event.code : 'revoked',
          lostEdits
        );
        return;
      }
      if (
        event.type === 'room-read-only' &&
        event.room === collaborationToken.room
      ) {
        readOnlyNow.current();
        return;
      }
      if (
        event.type === 'comments-invalidated' &&
        event.materialId === material.id
      ) {
        void qc.invalidateQueries({
          queryKey: qk.materialDiscussions(material.id),
        });
        return;
      }
      if (
        event.type === 'projection-updated' &&
        event.materialId === material.id
      ) {
        // The room is the content authority while this editor is mounted, so
        // refetching now would re-download and re-parse the whole document for
        // a reader that does not exist. Mark it stale and flush on teardown,
        // when static previews and exports start reading the projection again.
        projectionStale.current = true;
        void qc.invalidateQueries({
          queryKey: qk.material(material.id),
          refetchType: 'none',
        });
        return;
      }
      if (
        (event.type === 'compaction-evict' ||
          event.type === 'compaction-complete') &&
        (event.room === collaborationToken.room ||
          event.materialId === material.id)
      ) {
        void qc.invalidateQueries({
          queryKey: ['material', material.id, 'collaboration-token'],
        });
      }
    },
    [collaborationToken.room, hasUnsavedWork, qc, material.id, setStatus]
  );

  const plugins = useMemo(
    () => [
      YjsPlugin.configure({
        options: {
          cursors: {
            autoSend: true,
            data: {
              color: cursorColor(currentUserId),
              name,
            },
          },
          onConnect: connecting,
          onDisconnect: () => {
            reconnector.current?.disconnected();
            if (navigator.onLine) connecting();
            else setStatus('offline');
          },
          onError: ({ error }) => {
            console.warn('Yjs collaboration provider error:', error);
            setStatus('error');
          },
          onSyncChange: ({ isSynced }) => {
            if (!isSynced || rejected.current) return;
            hasSynced.current = true;
            reconnector.current?.connected();
            setStatus(
              unsavedChanges.current || pendingCheckpoints.current.size > 0
                ? 'syncing'
                : 'synced'
            );
            // Receipts requested while offline never reached the service.
            resendCheckpoints.current();
          },
          providers: [
            USE_MSW
              ? ({
                  options: {
                    initialValue,
                    materialId: material.id,
                    name: collaborationToken.room,
                    onStateless: ({ payload }: { payload: string }) => {
                      handleStatelessEvent(payload);
                    },
                  },
                  type: 'mock',
                } as never)
              : {
                  options: {
                    name: collaborationToken.room,
                    onAuthenticationFailed: ({
                      reason,
                    }: {
                      reason: string;
                    }) => {
                      const refusal = roomRefusal(reason, tokenError.current);
                      tokenError.current = null;
                      if (refusal === 'readOnly') readOnlyNow.current();
                      else if (refusal === 'retry')
                        reconnector.current?.refused();
                      else reportUnavailable.current?.(refusal);
                    },
                    onClose: () => {
                      reconnector.current?.closed(
                        socketOpen(roomProvider(editorRef.current)?.provider)
                      );
                    },
                    onStateless: ({ payload }: { payload: string }) => {
                      handleStatelessEvent(payload);
                    },
                    token: async () => {
                      let token: MaterialCollaborationToken;
                      try {
                        token = await getMaterialCollaborationToken(
                          material.id
                        );
                      } catch (error) {
                        tokenError.current = error;
                        throw error;
                      }
                      // A reconnect after the account froze gets a read token.
                      if (token.access === 'read') {
                        readOnlyNow.current();
                        throw new Error(COLLABORATION_READ_ONLY_REASON);
                      }
                      return token.token;
                    },
                    url: collaborationToken.url,
                  },
                  type: 'hocuspocus' as const,
                },
          ],
          userId: currentUserId,
          ydoc,
        },
      }),
      ...buildPlugins({
        allowExternalAssets,
        currentUserId,
        discussions,
        onSave: () => saveNow.current(),
        workspaceId: material.workspaceId,
      }),
    ],
    [
      allowExternalAssets,
      collaborationToken.room,
      collaborationToken.url,
      connecting,
      currentUserId,
      discussions,
      handleStatelessEvent,
      material.id,
      material.workspaceId,
      name,
      setStatus,
      ydoc,
    ]
  );

  const editor = usePlateEditor({
    // slate-react re-creates the element descriptors of every block in a
    // modified chunk, so the chunk size is the number of blocks a keystroke
    // costs. Plate's default of 1000 leaves a near-limit note in four chunks:
    // one character re-created ~1000 descriptors, all of which then bailed out
    // of `MemoizedElement` without rendering. It is also the granularity of the
    // `content-visibility: auto` boxes that carry scrolling.
    chunking: { chunkSize: 32 },
    components: noteComponents,
    plugins,
    value: initialValue,
  });
  // Provider callbacks are configured before the editor exists.
  const editorRef = useRef(editor);
  editorRef.current = editor;

  useEffect(() => {
    const current = roomReconnector({
      onStuck: () => {
        setStatus('error');
        if (hasUnsavedWork()) reportSaveFailed.current?.();
      },
      provider: () => roomProvider(editor)?.provider,
    });
    reconnector.current = current;
    return () => {
      current.dispose();
      if (reconnector.current === current) reconnector.current = null;
    };
  }, [editor, hasUnsavedWork, setStatus]);

  useEffect(() => {
    let active = true;
    let initialized = false;
    setStatus('connecting');
    // Delay initialization by one task so React Strict Mode's development-only
    // setup/cleanup probe cannot initialize the same Slate-Yjs editor twice.
    const initializeTimer = setTimeout(() => {
      initialized = true;
      void editor
        .getApi(YjsPlugin)
        .yjs.init({
          autoConnect: true,
          id: collaborationToken.room,
          value: null,
        })
        .catch((error) => {
          console.warn('Yjs collaboration initialization failed:', error);
          if (active) setStatus('error');
        });
    }, 0);
    return () => {
      active = false;
      clearTimeout(initializeTimer);
      if (checkpointTimer.current) clearTimeout(checkpointTimer.current);
      if (initialized) editor.getApi(YjsPlugin).yjs.destroy();
      onEditorStatusChange?.(null);
    };
  }, [collaborationToken.room, editor, onEditorStatusChange, setStatus]);

  useEffect(() => {
    // A blip the socket survived brings no provider event, so the status comes
    // back from the provider's own state; a dropped one reconnects by itself.
    const online = () => {
      if (reportedStatus.current !== 'offline') return;
      if (roomProvider(editor)?.isSynced)
        setStatus(hasUnsavedWork() ? 'syncing' : 'synced');
      else connecting();
    };
    const offline = () => setStatus('offline');
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, [connecting, editor, hasUnsavedWork, setStatus]);

  const requestCheckpoint = useCallback(() => {
    if (rejected.current) return;
    // A receipt is only meaningful for work the service has not answered for
    // yet; asking about an already durable document would never be answered,
    // because nothing is left to store.
    if (!unsavedChanges.current && pendingCheckpoints.current.size === 0)
      return;
    const id = crypto.randomUUID();
    pendingCheckpoints.current.add(id);
    unsavedChanges.current = false;
    // Enter the pending state before dispatching: a provider that answers
    // synchronously — the mock one does — would otherwise have its `saved`
    // acknowledgement overwritten by this line.
    markSyncing();
    sendCheckpointRequest(editor, id);
  }, [editor, markSyncing]);

  const scheduleCheckpoint = useCallback(() => {
    if (rejected.current) return;
    unsavedChanges.current = true;
    markSyncing();
    if (checkpointTimer.current) clearTimeout(checkpointTimer.current);
    checkpointTimer.current = setTimeout(
      requestCheckpoint,
      CHECKPOINT_DEBOUNCE_MS
    );
  }, [markSyncing, requestCheckpoint]);

  // `mod+s` stays registered so the browser's own save dialog never opens, and
  // it flushes the debounce rather than running a second checkpoint path.
  const saveImmediately = useCallback(() => {
    if (checkpointTimer.current) clearTimeout(checkpointTimer.current);
    requestCheckpoint();
  }, [requestCheckpoint]);

  const resendPendingCheckpoints = useCallback(() => {
    for (const id of pendingCheckpoints.current) {
      sendCheckpointRequest(editor, id);
    }
  }, [editor]);

  useEffect(() => {
    reportRejection.current = onDocumentRejected;
    reportSaveFailed.current = onSaveFailed;
    reportUnavailable.current = onUnavailable;
    let reported = false;
    readOnlyNow.current = () => {
      if (reported) return;
      reported = true;
      onReadOnly?.();
    };
    resendCheckpoints.current = resendPendingCheckpoints;
    saveNow.current = saveImmediately;
  }, [
    onDocumentRejected,
    onReadOnly,
    onSaveFailed,
    onUnavailable,
    resendPendingCheckpoints,
    saveImmediately,
  ]);

  return (
    <NoteBlockDialogsProvider noteId={material.id}>
      <div className="flex max-h-full flex-1 flex-col overflow-auto">
        <Plate editor={editor} onValueChange={scheduleCheckpoint}>
          <CollaborationProvider
            currentUserId={currentUserId}
            discussions={discussions}
          >
            <NoteToolbar />
            <div className="min-h-0 flex-1 overflow-auto">
              <div className="mx-auto flex min-h-full w-full max-w-7xl flex-col">
                {/* The room replaces the projection copy the moment it syncs,
                 * so painting that copy first renders the whole document
                 * twice — seconds of it on a near-limit note. Anything other
                 * than a healthy handshake still paints, otherwise a broken
                 * collaboration service would leave a readable note hidden
                 * behind a spinner. */}
                {saveState === 'connecting' ? (
                  <FileLoading message={m.editor_connecting()} />
                ) : (
                  <>
                    <NoteEditorContent
                      discussions={discussions}
                      shouldShowStats={shouldShowDocumentStats(documentStats)}
                    />
                    <DocumentStatsFooter
                      limitError={documentLimitError}
                      stats={documentStats}
                    />
                  </>
                )}
              </div>
            </div>
            <EditorCommandPalette />
            {editorAiEnabled(allowExternalAssets) && <AiMenu />}
          </CollaborationProvider>
        </Plate>
      </div>
    </NoteBlockDialogsProvider>
  );
}
