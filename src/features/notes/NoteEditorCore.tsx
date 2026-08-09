import { YjsPlugin } from '@platejs/yjs/react';
import { useQueryClient } from '@tanstack/react-query';
import type { PlateEditor } from 'platejs/react';
import {
  Plate,
  PlateContainer,
  PlateContent,
  useEditorRef,
  useEditorSelector,
  usePlateEditor,
} from 'platejs/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { USE_MSW } from '@/api/auth';
import { qk } from '@/api/client';
import {
  getMaterialCollaborationToken,
  type MaterialCollaborationToken,
  type useMaterialDiscussions,
} from '@/api/hooks';
import type { Material } from '@/api/types';
import {
  type MaterialValue,
  parseMaterialDocument,
} from '@/features/materials/document';
import { NoteToolbar } from '@/features/notes/toolbar/NoteToolbar';
import { cn } from '@/lib/cn';
import { MATERIAL_DOCUMENT_LIMITS } from '@/lib/const';
import { AiMenu } from './ai/AiMenu';
import { NoteBlockDialogsProvider } from './blocks/dialogContext';
import {
  CollaborationProvider,
  commentDecorationRangesForEntry,
  resolveCommentDecorations,
} from './Collaboration';
import {
  type MaterialDocumentStats,
  materialLimitMessage,
  parseCollaborationEvent,
} from './collaborationEvents';
import {
  contentSizeKilobytes,
  formatContentSize,
  shouldShowDocumentStats,
} from './documentStats';
import { EditorCommandPalette } from './EditorCommandPalette';
import type { NoteEditorMode, NoteEditorStatus } from './editorMode';
import { FloatingToolbar } from './FloatingToolbar';
import { noteComponents } from './nodeComponents';
import { buildPlugins } from './plugins';
import {
  remoteCursorRangesForEntry,
  useRemoteCursorDecorations,
} from './RemoteCursors';

const NOTE_PLACEHOLDER = 'Type  /  for commands ...';
const COLLABORATION_ROOM_ERROR = /room|schema|stale/i;
const CHECKPOINT_DEBOUNCE_MS = 1000;

interface StatelessProviderWrapper {
  isConnected: boolean;
  provider: { sendStateless: (payload: string) => void };
  type: string;
}

/**
 * Asks the collaboration service for a durability receipt. Kept off the Y.Doc
 * on purpose: a marker written into the document would be an edit in its own
 * right, so acknowledging it would dirty the room and trigger a second store.
 */
function sendCheckpointRequest(editor: PlateEditor, id: string) {
  const provider = editor
    .getOptions(YjsPlugin)
    ._providers.find((candidate) =>
      USE_MSW ? candidate.type === 'mock' : candidate.type === 'hocuspocus'
    ) as StatelessProviderWrapper | undefined;
  if (!provider?.isConnected) return;
  provider.provider.sendStateless(
    JSON.stringify({ id, type: 'checkpoint-request' })
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
  if (!(limitError || shouldShowDocumentStats(stats))) return null;
  return (
    <div
      aria-label="Document statistics"
      className="mx-auto mb-20 flex w-full max-w-3xl gap-3 px-10 pb-4 text-fg-muted text-xs max-sm:px-5"
    >
      <span
        className={cn(
          stats.nodeCount >= MATERIAL_DOCUMENT_LIMITS.maxNodes * 0.85 &&
            'text-solid-error'
        )}
      >
        Nodes: {stats.nodeCount.toLocaleString()}/
        {MATERIAL_DOCUMENT_LIMITS.maxNodes.toLocaleString()}
      </span>
      <span
        className={cn(
          stats.maxDepth >= MATERIAL_DOCUMENT_LIMITS.maxDepth * 0.85 &&
            'text-solid-error'
        )}
      >
        Depth: {stats.maxDepth}/{MATERIAL_DOCUMENT_LIMITS.maxDepth}
      </span>
      <span>
        Size: {formatContentSize(stats.contentBytes)}/
        {contentSizeKilobytes(
          MATERIAL_DOCUMENT_LIMITS.maxContentBytes
        ).toLocaleString()}{' '}
        KB
      </span>
      {limitError && (
        <span className="font-medium text-solid-error">{limitError}</span>
      )}
    </div>
  );
}

function NoteEditorContent({
  stats,
  discussions,
  readOnly,
}: {
  stats: MaterialDocumentStats;
  discussions: NonNullable<ReturnType<typeof useMaterialDiscussions>['data']>;
  readOnly: boolean;
}) {
  const editor = useEditorRef();
  const shouldShowStats = shouldShowDocumentStats(stats);
  const showEditorPlaceholder = useEditorSelector(
    (current) => {
      const firstNode = current.children[0];
      return (
        !readOnly &&
        current.children.length === 1 &&
        !!firstNode &&
        current.api.isEmpty(firstNode) &&
        current.api.isElementStateEmpty(firstNode)
      );
    },
    [readOnly]
  );
  const decorations = resolveCommentDecorations(
    editor as Parameters<typeof resolveCommentDecorations>[0],
    discussions
  );
  const remoteCursors = useRemoteCursorDecorations(editor);

  return (
    <PlateContainer className="relative [&_.slate-selection-area]:z-50 [&_.slate-selection-area]:border [&_.slate-selection-area]:border-action-accent/25 [&_.slate-selection-area]:bg-action-accent/15">
      <PlateContent
        className={cn(
          'note-editor mx-auto min-h-75 max-w-3xl px-10 pt-4 pb-36 text-base outline-none **:data-slate-placeholder:translate-y-1 **:data-slate-placeholder:text-placeholder **:data-slate-placeholder:text-sm **:data-slate-placeholder:leading-loose **:data-slate-placeholder:opacity-100! max-sm:px-5',
          shouldShowStats && 'pb-16'
        )}
        decorate={({ entry }) =>
          [
            ...commentDecorationRangesForEntry(entry, decorations),
            ...remoteCursorRangesForEntry(entry, remoteCursors),
          ] as never
        }
        onKeyDown={(event) => {
          // Only the modifier combo jumps to the end of the note. Bare End is
          // end-of-line and Shift+End extends a selection; both stay native.
          const jumpToNoteEnd =
            event.key === 'End' &&
            !event.shiftKey &&
            (event.ctrlKey || event.metaKey);
          if (!jumpToNoteEnd) return;
          event.preventDefault();
          editor.tf.select(editor.api.end([]));
        }}
        placeholder={showEditorPlaceholder ? NOTE_PLACEHOLDER : undefined}
        readOnly={readOnly}
      />
    </PlateContainer>
  );
}

export function NoteEditorCore({
  material,
  mode,
  allowExternalAssets,
  discussions,
  currentUserId,
  currentUserName,
  collaborationToken,
  onEditorStatusChange,
  onDocumentRejected,
}: {
  material: Material;
  mode: NoteEditorMode;
  allowExternalAssets: boolean;
  discussions: NonNullable<ReturnType<typeof useMaterialDiscussions>['data']>;
  currentUserId: string;
  currentUserName: string;
  collaborationToken: MaterialCollaborationToken;
  onEditorStatusChange?: (status: NoteEditorStatus | null) => void;
  onDocumentRejected?: (message: string, stats: MaterialDocumentStats) => void;
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
  const initialValue =
    parseMaterialDocument(material.content)?.value ??
    ([{ children: [{ text: '' }], type: 'p' }] as MaterialValue);
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
  const [_saveState, setSaveState] =
    useState<NoteEditorStatus['saveState']>('connecting');
  const name = currentUserName;

  const setStatus = useCallback(
    (next: NoteEditorStatus['saveState']) => {
      setSaveState(next);
      onEditorStatusChange?.({ mode, saveState: next });
    },
    [mode, onEditorStatusChange]
  );

  // Plugin options are captured before the editor exists, so the handlers they
  // fire are reached through refs instead of becoming plugin dependencies.
  const saveNow = useRef(() => {});
  const resendCheckpoints = useRef(() => {});
  const reportRejection = useRef(onDocumentRejected);

  const handleStatelessEvent = useCallback(
    (payload: string) => {
      const event = parseCollaborationEvent(payload);
      if (!event) return;
      if (
        event.type === 'checkpoint-persisted' &&
        event.materialId === material.id
      ) {
        setDocumentStats(event.metrics);
        setDocumentLimitError(
          event.limitCode
            ? `${materialLimitMessage(event.limitCode)} Only edits that remove content will be saved.`
            : null
        );
        let acknowledged = false;
        for (const id of event.checkpointIds) {
          if (pendingCheckpoints.current.delete(id)) acknowledged = true;
        }
        if (acknowledged && pendingCheckpoints.current.size === 0) {
          setStatus('saved');
        }
        return;
      }
      if (
        event.type === 'document-rejected' &&
        event.materialId === material.id
      ) {
        if (rejected.current) return;
        rejected.current = true;
        pendingCheckpoints.current.clear();
        setStatus('error');
        reportRejection.current?.(
          materialLimitMessage(event.code),
          event.metrics
        );
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
        void qc.invalidateQueries({ queryKey: qk.material(material.id) });
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
    [collaborationToken.room, qc, material.id, setStatus]
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
          onConnect: () => setStatus('connecting'),
          onDisconnect: () => setStatus('offline'),
          onError: ({ error }) => {
            console.warn('Yjs collaboration provider error:', error);
            if (
              error instanceof Error &&
              COLLABORATION_ROOM_ERROR.test(error.message)
            ) {
              void qc.invalidateQueries({
                queryKey: ['material', material.id, 'collaboration-token'],
              });
            }
            setStatus('error');
          },
          onSyncChange: ({ isSynced }) => {
            if (!isSynced) return;
            setStatus('synced');
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
                    onStateless: ({ payload }: { payload: string }) => {
                      handleStatelessEvent(payload);
                    },
                    token: async () =>
                      (await getMaterialCollaborationToken(material.id)).token,
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
        allowExternalAssets: mode === 'edit' && allowExternalAssets,
        currentUserId,
        discussions,
        mode,
        onSave: () => saveNow.current(),
        workspaceId: material.workspaceId,
      }),
    ],
    [
      allowExternalAssets,
      collaborationToken.room,
      collaborationToken.url,
      currentUserId,
      discussions,
      handleStatelessEvent,
      material.id,
      material.workspaceId,
      mode,
      name,
      qc,
      setStatus,
      ydoc,
    ]
  );

  const editor = usePlateEditor({
    components: noteComponents,
    plugins,
    value: initialValue,
  });

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
    const online = () => setStatus('connecting');
    const offline = () => setStatus('offline');
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, [setStatus]);

  const requestCheckpoint = useCallback(() => {
    if (mode !== 'edit' || rejected.current) return;
    // A receipt is only meaningful for work the service has not answered for
    // yet; asking about an already durable document would never be answered,
    // because nothing is left to store.
    if (!unsavedChanges.current && pendingCheckpoints.current.size === 0)
      return;
    const id = crypto.randomUUID();
    pendingCheckpoints.current.add(id);
    unsavedChanges.current = false;
    sendCheckpointRequest(editor, id);
    setStatus('synced');
  }, [editor, mode, setStatus]);

  const scheduleCheckpoint = useCallback(() => {
    if (mode !== 'edit') return;
    unsavedChanges.current = true;
    if (checkpointTimer.current) clearTimeout(checkpointTimer.current);
    checkpointTimer.current = setTimeout(
      requestCheckpoint,
      CHECKPOINT_DEBOUNCE_MS
    );
  }, [mode, requestCheckpoint]);

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
    resendCheckpoints.current = resendPendingCheckpoints;
    saveNow.current = saveImmediately;
  }, [onDocumentRejected, resendPendingCheckpoints, saveImmediately]);

  return (
    <NoteBlockDialogsProvider>
      <div className="flex max-h-full flex-1 flex-col overflow-auto">
        <Plate editor={editor} onValueChange={scheduleCheckpoint}>
          <CollaborationProvider
            currentUserId={currentUserId}
            discussions={discussions}
          >
            <NoteToolbar />
            <div className="min-h-0 flex-1 overflow-auto">
              <div className="mx-auto min-h-full w-full max-w-7xl">
                <NoteEditorContent
                  discussions={discussions}
                  readOnly={mode === 'comment'}
                  stats={documentStats}
                />
                <DocumentStatsFooter
                  limitError={documentLimitError}
                  stats={documentStats}
                />
              </div>
            </div>
            {mode === 'edit' && <FloatingToolbar />}
            <EditorCommandPalette />
            {mode === 'edit' && allowExternalAssets && <AiMenu />}
          </CollaborationProvider>
        </Plate>
      </div>
    </NoteBlockDialogsProvider>
  );
}
