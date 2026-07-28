import {
  useMaterialDiscussions,
  useUpdateMaterial,
  useWorkspaceMembers
} from "@/api/hooks";
import type { Material } from "@/api/types";
import {
  countMaterialMetrics,
  createMaterialDocumentWithMetrics,
  MATERIAL_DOCUMENT_LIMITS,
  type MaterialDocument,
  type MaterialDocumentMetrics,
  type MaterialValue,
  normalizeMaterialValueWithMetrics,
  parseMaterialDocument,
  parseMaterialDocumentWithMetrics,
} from "@/features/materials/document";
import { cn } from "@/lib/cn";
import { getCommentKey } from "@platejs/comment";
import { BaseSuggestionPlugin } from "@platejs/suggestion";
import { KEYS, TextApi } from "platejs";
import {
  Plate,
  PlateContainer,
  PlateContent,
  useEditorSelector,
  usePlateEditor,
} from "platejs/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AiMenu } from "./ai/AiMenu";
import { VoiceButton } from "./ai/VoiceButton";
import { NoteBlockDialogsProvider } from "./blocks/dialogContext";
import {
  CollaborationProvider,
  commentDiscussionAnchor,
  suggestionPlugin,
} from "./Collaboration";
import {
  contentSizeKilobytes,
  formatContentSize,
  shouldShowDocumentStats,
} from "./documentStats";
import type {
  NoteEditorMode,
  NoteEditorSaveState,
  NoteEditorStatus,
} from "./editorMode";
import { FloatingToolbar } from "./FloatingToolbar";
import { noteComponents } from "./nodeComponents";
import { NoteToolbar } from "./NoteToolbar";
import { buildPlugins } from "./plugins";
import { stripCommentDecorations } from "./suggestions";

const NOTE_PLACEHOLDER = "Type  /  for commands ...";

function materialDocumentSnapshot(
  input: unknown,
  fallbackValue?: MaterialValue,
): {
  document: MaterialDocument;
  metrics: MaterialDocumentMetrics;
} {
  return (
    parseMaterialDocumentWithMetrics(input) ??
    createMaterialDocumentWithMetrics(
      fallbackValue ?? [{ children: [{ text: "" }], type: "p" }],
    )
  );
}

function DocumentStatsFooter({
  metrics,
  contentBytes,
}: {
  metrics: MaterialDocumentMetrics;
  contentBytes: number | null;
}) {
  if (!shouldShowDocumentStats(metrics, contentBytes)) return null;

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
      <span
        className={cn(
          contentBytes &&
            contentSizeKilobytes(contentBytes) >=
              contentSizeKilobytes(MATERIAL_DOCUMENT_LIMITS.maxContentBytes) *
                0.85 &&
            "text-solid-error",
        )}
      >
        Size: {formatContentSize(contentBytes)}/
        {contentSizeKilobytes(
          MATERIAL_DOCUMENT_LIMITS.maxContentBytes,
        ).toLocaleString()}{" "}
        KB
      </span>
    </div>
  );
}
function NoteEditorContent({
  metrics,
  contentBytes,
}: {
  metrics: MaterialDocumentMetrics;
  contentBytes: number | null;
}) {
  const shouldShowStats = shouldShowDocumentStats(metrics, contentBytes);
  const showEditorPlaceholder = useEditorSelector((editor) => {
    const firstNode = editor.children[0];

    // Keep the editor-level placeholder mutually exclusive with
    // BlockPlaceholderPlugin. List metadata makes an otherwise empty block
    // structurally meaningful, so it must use the block placeholder.
    return (
      editor.children.length === 1 &&
      !!firstNode &&
      editor.api.isEmpty(firstNode) &&
      editor.api.isElementStateEmpty(firstNode)
    );
  }, []);

  return (
    // The relative container registers the ref used by cursor-overlay
    // positioning (selection highlight while the AI menu input has focus).
    // The slate-selection-area rules style BlockSelectionPlugin's marquee
    // rectangle when dragging from the editor margin.
    <PlateContainer className="relative [&_.slate-selection-area]:z-50 [&_.slate-selection-area]:border [&_.slate-selection-area]:border-action-accent/25 [&_.slate-selection-area]:bg-action-accent/15">
      <PlateContent
        className={cn(
          "note-editor mx-auto min-h-75 max-w-3xl px-10 pt-4 pb-36 text-base outline-none **:data-slate-placeholder:translate-y-1 **:data-slate-placeholder:text-placeholder **:data-slate-placeholder:text-sm **:data-slate-placeholder:leading-loose **:data-slate-placeholder:opacity-100! max-sm:px-5",
          shouldShowStats && "pb-16",
        )}
        placeholder={showEditorPlaceholder ? NOTE_PLACEHOLDER : undefined}
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
  onSuggestionDirtyChange,
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
  onSuggestionDirtyChange?: (dirty: boolean) => void;
  onEditorStatusChange?: (status: NoteEditorStatus | null) => void;
  collaborationActionsHost?: HTMLElement | null;
}) {
  const update = useUpdateMaterial(material.workspaceId);
  const mutateRef = useRef(update.mutate);
  mutateRef.current = update.mutate;
  const [saveState, setSaveState] = useState<NoteEditorSaveState>("saved");
  const mounted = useRef(true);
  const applyingDiscussionMarks = useRef(false);
  const saveShortcutRef = useRef<() => void>(() => {});
  const revisionRef = useRef(material.revision ?? 1);
  const [suggestionDirty, setSuggestionDirty] = useState(false);
  const [baseSnapshot, setBaseSnapshot] = useState(() => ({
    ...materialDocumentSnapshot(material.content),
    revision: material.revision ?? 1,
  }));
  const [documentMetrics, setDocumentMetrics] =
    useState<MaterialDocumentMetrics>(() => baseSnapshot.metrics);
  const [savedContentBytes, setSavedContentBytes] = useState<number | null>(
    () => material.contentBytes ?? null,
  );
  const currentDocument = useMemo(
    () =>
      (material.revision ?? 1) === baseSnapshot.revision
        ? baseSnapshot.document
        : (parseMaterialDocument(material.content) ?? baseSnapshot.document),
    [
      baseSnapshot.document,
      baseSnapshot.revision,
      material.content,
      material.revision,
    ],
  );
  const updateDocumentMetrics = useCallback((next: MaterialDocumentMetrics) => {
    setDocumentMetrics((current) =>
      current.nodeCount === next.nodeCount && current.maxDepth === next.maxDepth
        ? current
        : next,
    );
  }, []);
  const initialDocument = baseSnapshot.document;
  const setSuggestionDraftDirty = useCallback(
    (dirty: boolean) => {
      setSuggestionDirty(dirty);
      onSuggestionDirtyChange?.(dirty);
    },
    [onSuggestionDirtyChange],
  );
  const onSaveShortcut = useCallback(() => {
    // Suggestions are submitted through the collaboration workflow rather
    // than persisted as direct material edits.
    if (mode === "edit") saveShortcutRef.current();
  }, [mode]);

  useEffect(() => {
    const status: NoteEditorStatus =
      mode === "suggestion"
        ? { dirty: suggestionDirty, mode: "suggestion" }
        : { mode: "edit", saveState };
    onEditorStatusChange?.(status);
  }, [mode, onEditorStatusChange, saveState, suggestionDirty]);

  useEffect(
    () => () => {
      onEditorStatusChange?.(null);
    },
    [onEditorStatusChange],
  );

  const plugins = useMemo(
    () =>
      buildPlugins({
        allowExternalAssets,
        currentUserId,
        discussions,
        mode,
        onSave: onSaveShortcut,
        users,
        workspaceId: material.workspaceId,
      }),
    [
      allowExternalAssets,
      currentUserId,
      discussions,
      material.workspaceId,
      mode,
      onSaveShortcut,
      users,
    ],
  );

  const editor = usePlateEditor({
    components: noteComponents,
    plugins,
    value: () => structuredClone(initialDocument.value),
  });
  const replaceEditorDocument = useCallback(
    (value: MaterialValue) => {
      const normalized = normalizeMaterialValueWithMetrics(value);
      updateDocumentMetrics(normalized.metrics);
      applyingDiscussionMarks.current = true;
      // withoutSuggestions: replacing the value while isSuggesting is on would
      // otherwise be recorded as "delete whole document + re-insert" marks.
      editor.getApi(BaseSuggestionPlugin).suggestion.withoutSuggestions(() => {
        editor.tf.setValue(structuredClone(normalized.value));
      });
      queueMicrotask(() => {
        applyingDiscussionMarks.current = false;
      });
    },
    [editor, updateDocumentMetrics],
  );

  useEffect(() => {
    const isSuggesting = mode === "suggestion";
    const getOption = editor.getOption as (
      plugin: unknown,
      key: string,
    ) => unknown;
    const setOption = editor.setOption as (
      plugin: unknown,
      key: string,
      value: unknown,
    ) => void;
    if (getOption(suggestionPlugin, "isSuggesting") !== isSuggesting) {
      setOption(suggestionPlugin, "isSuggesting", isSuggesting);
    }
  }, [editor, mode]);

  useEffect(() => {
    if (mode !== "suggestion" || suggestionDirty) return;
    const nextRevision = material.revision ?? 1;
    if (nextRevision === baseSnapshot.revision) return;
    const nextSnapshot = materialDocumentSnapshot(material.content);
    revisionRef.current = nextRevision;
    setBaseSnapshot({ ...nextSnapshot, revision: nextRevision });
    updateDocumentMetrics(nextSnapshot.metrics);
    setSavedContentBytes(material.contentBytes ?? null);
    replaceEditorDocument(nextSnapshot.document.value);
  }, [
    baseSnapshot.revision,
    material.content,
    material.contentBytes,
    material.revision,
    mode,
    replaceEditorDocument,
    updateDocumentMetrics,
    suggestionDirty,
  ]);

  useEffect(() => {
    if ((material.revision ?? 1) >= revisionRef.current) {
      setSavedContentBytes(material.contentBytes ?? null);
    }
  }, [material.contentBytes, material.revision]);

  useEffect(() => {
    if (!suggestionDirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [suggestionDirty]);

  useEffect(() => {
    applyingDiscussionMarks.current = true;
    editor.tf.withoutSaving(() => {
      for (const discussion of discussions) {
        const anchor = commentDiscussionAnchor(discussion);
        if (!anchor) continue;
        try {
          editor.tf.setNodes(
            {
              [KEYS.comment]: true,
              [getCommentKey(discussion.id)]: true,
            },
            {
              at: anchor as never,
              match: TextApi.isText,
              split: true,
            },
          );
        } catch {
          // Anchors are revision-relative; stale anchors remain available in the thread list.
        }
      }
    });
    queueMicrotask(() => {
      applyingDiscussionMarks.current = false;
    });
  }, [discussions, editor]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(false);
  const saveInFlight = useRef(false);

  // Metrics for the stats footer are refreshed on a short debounce with a
  // read-only counting walk. The expensive normalize + validate walk runs only
  // in `flush`, once per debounced save, never per keystroke.
  const metricsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleMetricsRefresh = useCallback(() => {
    if (metricsTimer.current) clearTimeout(metricsTimer.current);
    metricsTimer.current = setTimeout(() => {
      metricsTimer.current = null;
      updateDocumentMetrics(
        countMaterialMetrics(editor.children as MaterialValue),
      );
    }, 1000);
  }, [editor, updateDocumentMetrics]);
  useEffect(
    () => () => {
      if (metricsTimer.current) clearTimeout(metricsTimer.current);
    },
    [],
  );

  const flush = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (saveInFlight.current) return;
    if (!pending.current) return;
    // Serialize the live editor value now rather than a keystroke-time
    // snapshot: repairs (stable ids) and validation happen once per save.
    let snapshot: {
      document: MaterialDocument;
      metrics: MaterialDocumentMetrics;
    };
    try {
      snapshot = createMaterialDocumentWithMetrics(
        stripCommentDecorations(editor.children as MaterialValue),
      );
      updateDocumentMetrics(snapshot.metrics);
    } catch {
      if (mounted.current) setSaveState("error");
      return;
    }
    pending.current = false;
    saveInFlight.current = true;
    if (mounted.current) setSaveState("saving");
    mutateRef.current(
      {
        id: material.id,
        patch: {
          content: snapshot.document,
          expectedRevision: revisionRef.current,
        },
      },
      {
        onError: () => {
          saveInFlight.current = false;
          pending.current = true;
          if (mounted.current) setSaveState("error");
        },
        onSuccess: (saved) => {
          saveInFlight.current = false;
          revisionRef.current = saved.revision ?? revisionRef.current + 1;
          if (mounted.current) {
            // The server validates and stores this envelope without
            // transforming it. Reuse the already-normalized immutable request
            // snapshot instead of parsing an echoed 8k-node response.
            setBaseSnapshot({ ...snapshot, revision: revisionRef.current });
            updateDocumentMetrics(snapshot.metrics);
            setSavedContentBytes(saved.contentBytes ?? null);
          }
          if (pending.current) {
            if (mounted.current) setSaveState("pending");
            // Editor changes already reset this timer in `schedule`. Preserve
            // that debounce instead of saving immediately when this request ends.
            if (!saveTimer.current) queueMicrotask(flush);
          } else if (mounted.current) {
            setSaveState("saved");
          }
        },
      },
    );
  }, [editor, material.id, updateDocumentMetrics]);
  saveShortcutRef.current = flush;

  const schedule = useCallback(() => {
    pending.current = true;
    setSaveState("pending");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, 5000);
  }, [flush]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flush();
    };
  }, [flush]);

  // Kept intentionally cheap: it runs on every value change while typing.
  // Slate's own normalization is incremental (dirty paths only), and repairs
  // plus validation are deferred to the debounced `flush`.
  function onEditorChange() {
    if (applyingDiscussionMarks.current) return;
    scheduleMetricsRefresh();
    if (mode === "suggestion") {
      setSuggestionDraftDirty(true);
      return;
    }
    schedule();
  }

  return (
    <NoteBlockDialogsProvider>
      <div className="flex flex-1 max-h-full overflow-auto flex-col">
        {/* onValueChange, not onChange: the latter also fires for selection-only
            operations (caret moves), which must not schedule saves. */}
        <Plate editor={editor} onValueChange={onEditorChange}>
          <CollaborationProvider
            actionsPortalHost={collaborationActionsHost}
            currentDocument={currentDocument}
            currentRevision={Math.max(
              material.revision ?? 1,
              revisionRef.current,
            )}
            currentUserId={currentUserId}
            discussions={discussions}
            onMaterialState={(document, revision) => {
              // Documents on this path came from parse/create helpers and are
              // already normalized; a read-only count is enough.
              const metrics = countMaterialMetrics(document.value);
              revisionRef.current = revision;
              setBaseSnapshot({ document, metrics, revision });
              updateDocumentMetrics(metrics);
            }}
            onSuggestionReset={() => setSuggestionDraftDirty(false)}
            replaceEditorDocument={replaceEditorDocument}
            suggestionDirty={suggestionDirty}
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
                  contentBytes={savedContentBytes}
                  metrics={documentMetrics}
                />
                <DocumentStatsFooter
                  contentBytes={savedContentBytes}
                  metrics={documentMetrics}
                />
              </div>
            </div>
            <FloatingToolbar />
            {allowExternalAssets && <AiMenu />}
          </CollaborationProvider>
        </Plate>
      </div>
    </NoteBlockDialogsProvider>
  );
}
