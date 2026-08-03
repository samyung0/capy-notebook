import { YjsPlugin } from '@platejs/yjs/react';
import { useQueryClient } from '@tanstack/react-query';
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
import { qk } from '@/api/client';
import {
  getMaterialCollaborationToken,
  type MaterialCollaborationToken,
  type useMaterialDiscussions,
  type useWorkspaceMembers,
} from '@/api/hooks';
import type { Material } from '@/api/types';
import {
  countMaterialMetrics,
  type MaterialDocumentMetrics,
  type MaterialValue,
  parseMaterialDocument,
} from "@/features/materials/document";
import { cn } from "@/lib/cn";
import { AiMenu } from "./ai/AiMenu";
import { VoiceButton } from "./ai/VoiceButton";
import { NoteBlockDialogsProvider } from "./blocks/dialogContext";
import {
  CollaborationProvider,
  commentDecorationRangesForEntry,
  resolveCommentDecorations,
} from "./Collaboration";
import {
  contentSizeKilobytes,
  formatContentSize,
  shouldShowDocumentStats,
} from "./documentStats";
import { EditorCommandPalette } from "./EditorCommandPalette";
import type { NoteEditorMode, NoteEditorStatus } from "./editorMode";
import { FloatingToolbar } from "./FloatingToolbar";
import { NoteToolbar } from "./NoteToolbar";
import { noteComponents } from "./nodeComponents";
import { buildPlugins } from "./plugins";
import {
  remoteCursorRangesForEntry,
  useRemoteCursorDecorations,
} from "./RemoteCursors";
import { EDITOR_CHECKPOINT_MAP, MATERIAL_DOCUMENT_LIMITS } from "@/lib/const";

const NOTE_PLACEHOLDER = "Type  /  for commands ...";
const COLLABORATION_ROOM_ERROR = /room|schema|stale/i;

function materialValueSizeBytes(value: MaterialValue) {
  return new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, value }))
    .byteLength;
}

function cursorColor(userId: string | null) {
  let hash = 0;
  for (const character of userId ?? "anonymous") {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return `hsl(${hash % 360} 72% 48%)`;
}

function DocumentStatsFooter({
  limitError,
  metrics,
  contentBytes,
}: {
  limitError: string | null;
  metrics: MaterialDocumentMetrics;
  contentBytes: number | null;
}) {
  if (!limitError && !shouldShowDocumentStats(metrics, contentBytes))
    return null;
  return (
    <div
      aria-label="Document statistics"
      className="mx-auto mb-20 flex w-full max-w-3xl gap-3 px-10 pb-4 text-fg-muted text-xs max-sm:px-5"
    >
      <span
        className={cn(
          metrics.nodeCount >= MATERIAL_DOCUMENT_LIMITS.maxNodes * 0.85 &&
            "text-solid-error",
        )}
      >
        Nodes: {metrics.nodeCount.toLocaleString()}/
        {MATERIAL_DOCUMENT_LIMITS.maxNodes.toLocaleString()}
      </span>
      <span
        className={cn(
          metrics.maxDepth >= MATERIAL_DOCUMENT_LIMITS.maxDepth * 0.85 &&
            "text-solid-error",
        )}
      >
        Depth: {metrics.maxDepth}/{MATERIAL_DOCUMENT_LIMITS.maxDepth}
      </span>
      <span>
        Size: {formatContentSize(contentBytes)}/
        {contentSizeKilobytes(
          MATERIAL_DOCUMENT_LIMITS.maxContentBytes,
        ).toLocaleString()}{" "}
        KB
      </span>
      {limitError && (
        <span className="font-medium text-solid-error">{limitError}</span>
      )}
    </div>
  );
}

function NoteEditorContent({
  metrics,
  contentBytes,
  discussions,
  readOnly,
}: {
  metrics: MaterialDocumentMetrics;
  contentBytes: number | null;
  discussions: NonNullable<ReturnType<typeof useMaterialDiscussions>["data"]>;
  readOnly: boolean;
}) {
  const editor = useEditorRef();
  const shouldShowStats = shouldShowDocumentStats(metrics, contentBytes);
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
    [readOnly],
  );
  const decorations = resolveCommentDecorations(
    editor as Parameters<typeof resolveCommentDecorations>[0],
    discussions,
  );
  const remoteCursors = useRemoteCursorDecorations(editor);

  return (
    <PlateContainer className="relative [&_.slate-selection-area]:z-50 [&_.slate-selection-area]:border [&_.slate-selection-area]:border-action-accent/25 [&_.slate-selection-area]:bg-action-accent/15">
      <PlateContent
        className={cn(
          "note-editor mx-auto min-h-75 max-w-3xl px-10 pt-4 pb-36 text-base outline-none **:data-slate-placeholder:translate-y-1 **:data-slate-placeholder:text-placeholder **:data-slate-placeholder:text-sm **:data-slate-placeholder:leading-loose **:data-slate-placeholder:opacity-100! max-sm:px-5",
          shouldShowStats && "pb-16",
        )}
        decorate={({ entry }) =>
          [
            ...commentDecorationRangesForEntry(entry, decorations),
            ...remoteCursorRangesForEntry(entry, remoteCursors),
          ] as never
        }
        onKeyDown={(event) => {
          if (event.key !== "End" || event.shiftKey) return;
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
  users,
  discussions,
  currentUserId,
  currentUserName,
  collaborationToken,
  onEditorStatusChange,
  collaborationActionsHost,
}: {
  material: Material;
  mode: NoteEditorMode;
  allowExternalAssets: boolean;
  users: Record<
    string,
    NonNullable<ReturnType<typeof useWorkspaceMembers>["data"]>[number]
  >;
  discussions: NonNullable<ReturnType<typeof useMaterialDiscussions>["data"]>;
  currentUserId: string | null;
  currentUserName: string | null;
  collaborationToken: MaterialCollaborationToken;
  onEditorStatusChange?: (status: NoteEditorStatus | null) => void;
  collaborationActionsHost?: HTMLElement | null;
}) {
  const queryClient = useQueryClient();
  const ydoc = useMemo(
    () => new Y.Doc({ gc: true }),
    [collaborationToken.room],
  );
  const checkpointTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCheckpoint = useRef<string | null>(null);
  const initialValue =
    parseMaterialDocument(material.content)?.value ??
    ([{ children: [{ text: "" }], type: "p" }] as MaterialValue);
  const [documentMetrics, setDocumentMetrics] =
    useState<MaterialDocumentMetrics>(() => countMaterialMetrics(initialValue));
  const [documentLimitError, setDocumentLimitError] = useState<string | null>(
    null,
  );
  const [_saveState, setSaveState] =
    useState<NoteEditorStatus["saveState"]>("connecting");
  const name = currentUserId
    ? (users[currentUserId]?.name ?? currentUserName ?? "Collaborator")
    : "Collaborator";

  const setStatus = useCallback(
    (next: NoteEditorStatus["saveState"]) => {
      setSaveState(next);
      onEditorStatusChange?.({ mode, saveState: next });
    },
    [mode, onEditorStatusChange],
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
          onConnect: () => setStatus("connecting"),
          onDisconnect: () => setStatus("offline"),
          onError: ({ error }) => {
            console.warn("Yjs collaboration provider error:", error);
            if (
              error instanceof Error &&
              COLLABORATION_ROOM_ERROR.test(error.message)
            ) {
              void queryClient.invalidateQueries({
                queryKey: ["material", material.id, "collaboration-token"],
              });
            }
            setStatus("error");
          },
          onSyncChange: ({ isSynced }) => {
            if (isSynced) setStatus("synced");
          },
          providers: [
            {
              options: {
                name: collaborationToken.room,
                onStateless: ({ payload }: { payload: string }) => {
                  try {
                    const event = JSON.parse(payload) as {
                      checkpointIds?: string[];
                      materialId?: string;
                      newRoom?: string;
                      room?: string;
                      type?: string;
                    };
                    if (
                      event.type === "checkpoint-persisted" &&
                      pendingCheckpoint.current &&
                      event.checkpointIds?.includes(pendingCheckpoint.current)
                    ) {
                      ydoc
                        .getMap(EDITOR_CHECKPOINT_MAP)
                        .delete(pendingCheckpoint.current);
                      pendingCheckpoint.current = null;
                      setStatus("saved");
                    }
                    if (
                      event.type === "comments-invalidated" &&
                      event.materialId === material.id
                    ) {
                      queryClient.invalidateQueries({
                        queryKey: qk.materialDiscussions(material.id),
                      });
                    }
                    if (
                      event.type === "projection-updated" &&
                      event.materialId === material.id
                    ) {
                      queryClient.invalidateQueries({
                        queryKey: qk.material(material.id),
                      });
                    }
                    if (
                      (event.type === "compaction-evict" ||
                        event.type === "compaction-complete") &&
                      (event.room === collaborationToken.room ||
                        event.materialId === material.id)
                    ) {
                      void queryClient.invalidateQueries({
                        queryKey: [
                          "material",
                          material.id,
                          "collaboration-token",
                        ],
                      });
                    }
                  } catch {
                    // Unknown stateless events are intentionally ignored.
                  }
                },
                token: async () =>
                  (await getMaterialCollaborationToken(material.id)).token,
                url: collaborationToken.url,
              },
              type: "hocuspocus" as const,
            },
          ],
          userId: currentUserId,
          ydoc,
        },
      }),
      ...buildPlugins({
        allowExternalAssets: mode === "edit" && allowExternalAssets,
        currentUserId,
        discussions,
        mode,
        onSave: () => {
          if (mode !== "edit") return;
          const marker = crypto.randomUUID();
          pendingCheckpoint.current = marker;
          ydoc.getMap(EDITOR_CHECKPOINT_MAP).set(marker, {
            at: Date.now(),
            userId: currentUserId,
          });
          setStatus("synced");
        },
        users,
        workspaceId: material.workspaceId,
      }),
    ],
    [
      allowExternalAssets,
      collaborationToken.room,
      collaborationToken.url,
      currentUserId,
      discussions,
      material.id,
      material.workspaceId,
      mode,
      name,
      queryClient,
      setStatus,
      users,
      ydoc,
    ],
  );

  const editor = usePlateEditor({
    components: noteComponents,
    plugins,
    value: initialValue,
  });

  useEffect(() => {
    let active = true;
    let initialized = false;
    setStatus("connecting");
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
          console.warn("Yjs collaboration initialization failed:", error);
          if (active) setStatus("error");
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
    const online = () => setStatus("connecting");
    const offline = () => setStatus("offline");
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, [setStatus]);

  const scheduleCheckpoint = useCallback(() => {
    if (mode !== "edit") return;
    const value = editor.children as MaterialValue;
    const metrics = countMaterialMetrics(value);
    setDocumentMetrics(metrics);
    if (
      materialValueSizeBytes(value) > MATERIAL_DOCUMENT_LIMITS.maxContentBytes
    ) {
      setDocumentLimitError(
        `Document exceeds the ${contentSizeKilobytes(
          MATERIAL_DOCUMENT_LIMITS.maxContentBytes,
        ).toLocaleString()} KB limit. Undo or remove content to continue.`,
      );
      if (checkpointTimer.current) clearTimeout(checkpointTimer.current);
      return;
    }
    if (metrics.nodeCount > MATERIAL_DOCUMENT_LIMITS.maxNodes) {
      setDocumentLimitError(
        `Document exceeds the ${MATERIAL_DOCUMENT_LIMITS.maxNodes.toLocaleString()} node limit.`,
      );
      if (checkpointTimer.current) clearTimeout(checkpointTimer.current);
      return;
    }
    if (metrics.maxDepth > MATERIAL_DOCUMENT_LIMITS.maxDepth) {
      setDocumentLimitError(
        `Document exceeds the ${MATERIAL_DOCUMENT_LIMITS.maxDepth}-level nesting limit.`,
      );
      if (checkpointTimer.current) clearTimeout(checkpointTimer.current);
      return;
    }
    setDocumentLimitError(null);
    if (checkpointTimer.current) clearTimeout(checkpointTimer.current);
    checkpointTimer.current = setTimeout(() => {
      const marker = crypto.randomUUID();
      pendingCheckpoint.current = marker;
      ydoc.getMap(EDITOR_CHECKPOINT_MAP).set(marker, {
        at: Date.now(),
        userId: currentUserId,
      });
      setStatus("synced");
    }, 1000);
  }, [currentUserId, editor, mode, setStatus, ydoc]);

  return (
    <NoteBlockDialogsProvider>
      <div className="flex max-h-full flex-1 flex-col overflow-auto">
        <Plate editor={editor} onValueChange={scheduleCheckpoint}>
          <CollaborationProvider
            actionsPortalHost={collaborationActionsHost}
            currentUserId={currentUserId}
            discussions={discussions}
            users={users}
          >
            <NoteToolbar
              right={
                mode === "edit" && allowExternalAssets ? (
                  <VoiceButton />
                ) : undefined
              }
            />
            <div className="min-h-0 flex-1 overflow-auto">
              <div className="mx-auto min-h-full w-full max-w-7xl">
                <NoteEditorContent
                  contentBytes={material.contentBytes ?? null}
                  discussions={discussions}
                  metrics={documentMetrics}
                  readOnly={mode === "comment"}
                />
                <DocumentStatsFooter
                  contentBytes={material.contentBytes ?? null}
                  limitError={documentLimitError}
                  metrics={documentMetrics}
                />
              </div>
            </div>
            {mode === "edit" && <FloatingToolbar />}
            <EditorCommandPalette />
            {mode === "edit" && allowExternalAssets && <AiMenu />}
          </CollaborationProvider>
        </Plate>
      </div>
    </NoteBlockDialogsProvider>
  );
}
