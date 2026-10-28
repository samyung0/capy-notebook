import { YjsPlugin } from '@platejs/yjs/react';
import { captureException } from '@sentry/react';
import {
  type CursorEditor,
  type YHistoryEditor,
  YjsEditor,
  yTextToSlateElement,
} from '@slate-yjs/core';
import { useQueryClient } from '@tanstack/react-query';
import type { Path, TRange } from 'platejs';
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
  useContext,
  useEffect,
  useLayoutEffect,
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
import type {
  Material,
  MaterialCollaborationToken,
  Provenance,
} from '@/api/types';
import { FloatingBarContext } from '@/components/ui/floatingBarContext';
import { userToast } from '@/components/ui/userToast';
import {
  CollaborationHold,
  EditorHoldScope,
} from '@/features/collaboration/CollaborationHold';
import {
  applyMerged,
  hiddenDocument,
  holdsUnsent,
  joinedFrom,
  LateMergeUnloaded,
  type MarkedRoom,
  mergeBase,
  mergeLate,
} from '@/features/collaboration/lateMerge/lateMerge';
import { NoteSeat, NoteSeatContext } from '@/features/collaboration/noteSeat';
import '@/features/collaboration/platePlugin';
import {
  createPresenceStore,
  type PresenceConnection,
  type PresenceStore,
} from '@/features/collaboration/presence';
import { RoomProvider } from '@/features/collaboration/roomProvider';
import { limitUndo } from '@/features/collaboration/undo';
import { FileLoading } from '@/features/files/FileStates';
import {
  createMaterialDocument,
  type MaterialDocument,
  type MaterialValue,
  parseMaterialDocument,
} from '@/features/materials/document';
import { MaterialAttributionFooter } from '@/features/materials/MaterialAttributionFooter';
import { MaterialPreview } from '@/features/materials/MaterialPreview';
import { embedKey, useNoteFooter } from '@/features/materials/useNoteFooter';
import { NoteDisplayToggles } from '@/features/notes/NoteDisplayToggles';
import { NoteToolbar } from '@/features/notes/toolbar/NoteToolbar';
import { m } from '@/i18n';
import { markUpdateAvailable } from '@/lib/appRelease';
import { cn } from '@/lib/cn';
import { MATERIAL_DOCUMENT_LIMITS } from '@/lib/const';
import { type DraftRef, mergedRows } from '@/lib/draftStore';
import {
  applyDrafts,
  DRAFT_EXPIRY_MS,
  DRAFT_SEND_WAIT_MS,
  type DraftRecorder,
  type DraftSender,
  deleteDrafts,
  draftSender,
  draftsVersion,
  dropLostDrafts,
  type EditDraft,
  recordDrafts,
  sendLateDrafts,
} from '@/lib/editDrafts';
import { editIncidentReporter } from '@/lib/editIncidents';
import { isBoolean, PREF_KEYS, readPref, writePref } from '@/lib/localPrefs';
import { GhostTextSync } from './ai/GhostTextView';
import { BlockSelectionPresence } from './BlockSelection';
import { NoteBlockDialogsProvider } from './blocks/dialogContext';
import {
  CollaborationProvider,
  commentDecorationRangesForEntry,
  resolveCommentDecorations,
} from './Collaboration';
import { announceChildrenReady } from './childrenReady';
import {
  COLLABORATION_READ_ONLY_REASON,
  type MaterialDocumentStats,
  type MaterialLimitCode,
  materialLimitMessage,
  parseCollaborationEvent,
  type ReadOnlyCode,
} from './collaborationEvents';
import {
  CURSOR_SEND_MS,
  type CursorSender,
  throttleCursorPosition,
} from './cursorThrottle';
import {
  contentSizeKilobytes,
  formatContentSize,
  shouldShowDocumentStats,
} from './documentStats';
import { EditorCommandPalette } from './EditorCommandPalette';
import type { NoteEditorStatus } from './editorMode';
import { EditorScrollAreaContext } from './editorScrollArea';
import { FloatingToolbar } from './FloatingToolbar';
import { registerLiveNote } from './liveNoteHandover';
import { type BoundCopy, mergeAtBind } from './merge/applyBlocks';
import {
  deleteOnceStored,
  insertsMany,
  type NoteCopies,
  recordCopy,
  takeOverCopy,
} from './merge/copyDraft';
import { draftClients, watchHiddenTyping } from './merge/hiddenTyping';
import { createMergeStore, type MergeStore } from './merge/mergeStore';
import type { NoteDrafts } from './merge/noteDrafts';
import {
  piecesFromConflicts,
  piecesFromCopy,
  piecesFromDrafts,
} from './merge/pieces';
import type { MergePiece } from './merge/types';
import { noteComponents } from './nodeComponents';
import { useNoteEditorPrefs } from './noteEditorPrefs';
import { sendCaret, sendPointer } from './notePresence';
import { buildPlugins } from './plugins';
import {
  RemotePresenceMarks,
  remoteCursorRangesForEntry,
  useRemotePeers,
} from './RemoteCursors';
import { bindSyncedRoom, roomBindingPlugin, whenBound } from './roomBinding';
import {
  type RoomReconnector,
  refusalDropsDrafts,
  roomReconnector,
  roomRefusal,
  sendCheckpointRequest,
  socketOpen,
} from './roomConnection';
import {
  afterPaint,
  dropComposedText,
  holdModel,
  type NoteView,
  noteFocusAtPause,
  pauseEdits,
} from './roomSwap';
import { NOTE_SAVE_DELAY_MS, SaveDelayClock } from './saveDelay';
import { toastDraftsLost } from './saveFailure';
import { editorAwareness } from './uploadPresence';

const CHECKPOINT_DEBOUNCE_MS = 1000;
const RESTORE_ORIGIN = Symbol('restore');
/** The late merge's update: this session's edit, sent and stored as any. */
const LATE_ORIGIN = Symbol('late');

/** The save banner while the room cannot be reached. */
export type NoteOfflineState = 'offline' | 'offline-unstored' | 'offline-limit';

interface StatelessProviderWrapper {
  disconnect(): void;
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
      USE_MSW ? candidate.type === 'mock' : candidate.type === 'capy'
    ) as StatelessProviderWrapper | undefined;
}

/** The capy room provider (none under MSW), which knows the stored version
 * the tab reports (in-place collection). */
function capyRoom(editor: PlateEditor) {
  const provider = roomProvider(editor)?.provider;
  return provider instanceof RoomProvider ? provider : undefined;
}

/** The room a late merge marks (`mergeBase`): the capy room provider, or
 * under MSW the mock's channel, which records its marks. None otherwise, and
 * the merge then fails (Q406). */
function markedRoom(editor: PlateEditor): MarkedRoom | undefined {
  const room = capyRoom(editor);
  if (room || !USE_MSW) return room;
  return roomProvider(editor)?.provider as MarkedRoom | undefined;
}

/**
 * Asks the collaboration service for a durability receipt, once the room
 * synced (sendCheckpointRequest says why). Kept off the Y.Doc on purpose: a
 * marker written into the document would be an edit in its own right, so
 * acknowledging it would dirty the room and trigger a second store.
 */
function requestReceipt(editor: PlateEditor, synced: boolean, id: string) {
  const provider = roomProvider(editor);
  if (!provider) return;
  sendCheckpointRequest(
    { send: (payload) => provider.provider.sendStateless(payload), synced },
    { id }
  );
}

function sameStats(a: MaterialDocumentStats, b: MaterialDocumentStats) {
  return (
    a.contentBytes === b.contentBytes &&
    a.maxDepth === b.maxDepth &&
    a.nodeCount === b.nodeCount
  );
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

/** The note's credits after its editable content, outside the Yjs document
 * and in the column its content uses, where View puts them too: its own and
 * those of the embeds the document holds now (useNoteFooter), so adding or
 * removing an embed shows at once. Memoized: the editor re-renders on every
 * save acknowledgement, the credits only when the embeds or their reads
 * change. Ending the scroll area, it keeps room under the workspace's floating
 * bar where that shows and some space above the end; the stats footer, when it
 * follows, keeps that room instead. */
const NoteAttribution = memo(function NoteAttribution({
  beforeStats,
  embedCredits,
  embeds,
  provenance: own,
}: {
  beforeStats: boolean;
  embedCredits: Material['embedCredits'];
  embeds: string;
  provenance: Provenance | undefined;
}) {
  const displayWidth = useNoteEditorPrefs((state) => state.displayWidth);
  const overBar = useContext(FloatingBarContext);
  const provenance = useNoteFooter({ embedCredits, provenance: own }, embeds);
  return (
    <MaterialAttributionFooter
      className={cn(
        'mx-auto w-full px-5 sm:px-10',
        !beforeStats && (overBar ? 'pb-28' : 'pb-12'),
        displayWidth === 'half' && 'md:max-w-3xl'
      )}
      inline
      provenance={provenance}
    />
  );
});

// Keep this component identity stable: changing Editable's `as` remounts Slate.
function NoteEditorSurface({ children, ...props }: ComponentProps<'div'>) {
  const displayWidth = useNoteEditorPrefs((state) => state.displayWidth);
  return (
    <div {...props}>
      {/* The right gutter holds the comment-thread buttons on phones too. */}
      <div
        className={cn(
          'mx-auto w-full pr-10 pl-5 sm:pl-10',
          displayWidth === 'half' && 'md:max-w-3xl'
        )}
        data-note-content=""
      >
        {children}
      </div>
    </div>
  );
}

/** Puts the editor's value into the cached material, as the projection will
 * hold it. A value the document format refuses is a bug, reported; the cache
 * then keeps its copy until the projection lands. */
function handOverLiveValue(
  qc: ReturnType<typeof useQueryClient>,
  materialId: string,
  value: MaterialValue
) {
  let content: MaterialDocument;
  try {
    content = createMaterialDocument(value);
  } catch (error) {
    captureException(error, { tags: { component: 'note-handover' } });
    return;
  }
  qc.setQueryData<Material>(
    qk.material(materialId),
    (cached) => cached && { ...cached, content }
  );
}

/**
 * Before every commit React saves the focused element's selection, and for a
 * contenteditable it walks the element's whole DOM to turn the selection into
 * text offsets (getSelectionInformation). On a near-limit note that walk was
 * about a quarter of each keystroke. React only does it when the element's
 * `contentEditable` property reads "true", and only uses the result to put a
 * selection back after a commit moved focus away; Slate owns the editor's
 * selection and restores it itself. So to React the editor root's property
 * reads "inherit". The attribute, which editing follows, is untouched; Slate
 * and Plate read the attribute. React also reads the property on focusin for
 * its synthetic `onSelect`, which therefore no longer fires on the editor
 * root (nothing listens for it there). A guard e2e fails if React stops
 * reading the property (react-selection-walk.spec.ts).
 */
function hideSelectionFromReact(root: HTMLElement) {
  const property = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'contentEditable'
  );
  Object.defineProperty(root, 'contentEditable', {
    configurable: true,
    get: () => 'inherit',
    set: (value: string) => property?.set?.call(root, value),
  });
}

/**
 * Memoized deliberately. Every prop change here re-renders all ~7k nodes of a
 * near-limit document, and the checkpoint acknowledgement updates footer stats
 * once per save — so the footer must not be able to reach this subtree. It only
 * needs to know whether the footer reserves space, not what the footer says.
 */
const NoteEditorContent = memo(function NoteEditorContent({
  discussions,
  presence,
  readOnly,
  shouldShowStats,
}: {
  discussions: NonNullable<ReturnType<typeof useMaterialDiscussions>['data']>;
  /** The room's presence: co-editors' cursor labels come from it. */
  presence: PresenceStore;
  /** Offline past what this device may hold: no more edits until reconnect. */
  readOnly: boolean;
  shouldShowStats: boolean;
}) {
  const editor = useEditorRef();
  useLayoutEffect(() => {
    const root = editor.api.toDOMNode(editor);
    if (root) hideSelectionFromReact(root);
  }, [editor]);
  // This tab's pointer over the note goes to its co-editors (Epo 2026-10-28).
  useEffect(() => {
    const root = editor.api.toDOMNode(editor);
    const awareness = editorAwareness(editor);
    return root && awareness ? sendPointer(root, awareness) : undefined;
  }, [editor]);
  const showEditorPlaceholder = useEditorSelector((current) => {
    const firstNode = current.children[0];
    return (
      current.children.length === 1 &&
      !!firstNode &&
      current.api.isEmpty(firstNode) &&
      current.api.isElementStateEmpty(firstNode)
    );
  }, []);
  const remotePeers = useRemotePeers(editor, presence);
  // Read through refs so `decorate` keeps one identity: Plate treats a new
  // decorate function as new editable props and re-renders the whole document.
  const latest = useRef({ discussions, remotePeers });
  latest.current = { discussions, remotePeers };
  // Comment anchors resolve to Slate ranges that shift with the document, so
  // they are recomputed once per document version rather than once per node.
  const anchors = useRef<{
    discussions: unknown;
    ranges: ReturnType<typeof resolveCommentDecorations>;
    version: unknown;
  } | null>(null);

  const decorate = useCallback(
    ({ entry }: { entry: [unknown, Path] }) => {
      const { discussions: current, remotePeers: peers } = latest.current;
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
        ...remoteCursorRangesForEntry(editor, entry, peers),
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
        readOnly={readOnly}
        scrollSelectionIntoView={scrollSelectionIntoView}
        spellCheck={false}
      />
      {/* Share the editor's containing block so scrolling moves both natively. */}
      {!readOnly && <FloatingToolbar />}
      <BlockSelectionPresence />
      <RemotePresenceMarks presence={presence} />
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

/**
 * Where an editor stands in a room swap (Epo 2026-10-22, roomSwap.ts):
 * `live` on screen; `standby` building beside or under the paused one, its
 * header status Reconnecting; `paused` the one being replaced, read-only and
 * out of its room, reporting nothing more.
 */
export type NoteEditorPhase = 'live' | 'standby' | 'paused';

/** A late editor's document, handed to the editor that replaces it. */
export interface Handed {
  reauthor?: true;
  session: string;
  state: Uint8Array;
}

export function NoteEditorCore({
  material,
  allowExternalAssets,
  discussions,
  currentUserId,
  collaborationToken,
  draftKey,
  restored,
  held,
  late,
  pending,
  copies,
  pieces,
  sources,
  phase = 'live',
  onPainted,
  joinStartedAt,
  onEditorStatusChange,
  onPresenceChange,
  onDocumentRejected,
  onLate,
  onLateUnloaded,
  onMergeStore,
  onOffline,
  onOutdated,
  onReadOnly,
  onSaveDelayed,
  onUnavailable,
}: {
  phase?: NoteEditorPhase;
  /** Its content first painted (once). */
  onPainted?: (view: NoteView) => void;
  /** When this mount's join began: its token request, or the mount for a
   * new mount of the same room (`NoteEditor`). */
  joinStartedAt?: number;
  material: Material;
  allowExternalAssets: boolean;
  discussions: NonNullable<ReturnType<typeof useMaterialDiscussions>['data']>;
  currentUserId: string;
  collaborationToken: MaterialCollaborationToken;
  /** Where this editor's unsaved work is stored (editDrafts). */
  draftKey: string;
  /** Stored edits of this room's lineage (a reload, another tab): applied
   * before the room connects, then synced and saved like any edit. Late
   * ones (any row flagged `late`) are merged instead, as `late` is. */
  restored: EditDraft[];
  /** Sessions another open tab records: a late merge leaves their rows
   * alone, never merging or deleting them (Q420). */
  held: ReadonlySet<string>;
  /** The document of the editor this one replaces after the room answered
   * late (in-place GC): with the restored rows it is the old document whose
   * unsent edits the late merge places onto the room's current one, once
   * this editor synced; nothing of it is applied raw. `session`: the
   * replaced editor's, whose late row holds the same document if it was
   * stored. `reauthor`: its merged update was refused for an id the room
   * never recorded, so this editor writes the edits anew under its own id,
   * once (Q406). */
  late?: Handed;
  /** Stored edits of never-accepted sessions: the draft send takes them
   * while the room joins (Q319, Q327). */
  pending: EditDraft[];
  /** The note's saved copy edited before its room joined (Q229): the
   * newest is shown until the room's first sync, when every one merges. */
  copies: NoteCopies;
  /** The merge view's stored pieces (Q251). */
  pieces: NoteDrafts['pieces'];
  /** Stored groups this mount turns into pieces once its room synced. */
  sources: NoteDrafts['sources'];
  /** This mount's pieces, while it is on screen (live or paused; `on`
   * false once it is not). */
  onMergeStore?: (store: MergeStore, on: boolean) => void;
  onEditorStatusChange?: (status: NoteEditorStatus | null) => void;
  /** The room's other editors, for the header's avatar group (null once
   * the editor unmounts). */
  onPresenceChange?: (connections: PresenceConnection[] | null) => void;
  /** The room refused this editor's copy for good (a limit, an invalid
   * document, or an update from a writer who lost access): the caller
   * remounts onto the last saved version. Unsaved edits are `kept` as a
   * refused draft (the remount shows them in the merge view, Q251), or
   * `lost` when this device could not store them. */
  onDocumentRejected?: (
    code:
      | MaterialLimitCode
      | 'invalid_document'
      | 'unassigned'
      | 'revoked'
      | 'late',
    edits: 'none' | 'kept' | 'lost'
  ) => void;
  /** The room answered this editor's JOIN late (its session is older than
   * the collection window): the caller replaces it, through the room swap,
   * with a new editor (a new document, client id and empty Undo) given this
   * one's document as `late` (null when its edits are past the 7-day
   * expiry: the next one shows them as pieces, Q413). */
  onLate?: (late: Handed | null) => void;
  /** The late merge's code did not load: its Retry while the strip shows,
   * null once it loads or this editor goes (Q398). */
  onLateUnloaded?: (retry: (() => void) | null) => void;
  /** The room cannot be reached and edits stay on this device (the banner to
   * show), or null once it syncs again. */
  onOffline?: (state: NoteOfflineState | null) => void;
  /** The room refuses this build's client protocol (Capy was updated): the
   * editor stopped and turned read-only, its unsaved edits stay stored for
   * the reloaded page to send. `stored`: false when this device could not
   * store unsaved edits, which the reload then loses. */
  onOutdated?: (stored: boolean) => void;
  /** The room turned read-only (a frozen account or an owner at its storage
   * limit; `code`: a block this version cannot edit): the caller drops to
   * view, discarding unsaved edits. */
  onReadOnly?: (code?: ReadOnlyCode) => void;
  /** Saves are failing (the server retries them) or unconfirmed past
   * NOTE_SAVE_DELAY_MS while the editor keeps its edits; false once the
   * receipts catch up. */
  onSaveDelayed?: (delayed: boolean) => void;
  /** The note was trashed or deleted, or this user lost access to it (its
   * stored edits went too, except for an account lock). */
  onUnavailable?: (kind: 'notFound' | 'forbidden') => void;
}) {
  const qc = useQueryClient();
  const ydoc = useMemo(
    () => new Y.Doc({ gc: true }),
    [collaborationToken.room]
  );
  // Typing the room never saw that a join's step 2 hides in a deleted block
  // (Q237): armed by the room's step 1, read at each sync. Text alone counts
  // only from the clients of this mount's stored rows (Q410).
  const [drafted] = useState(() => [...restored, ...pending]);
  const hiddenTyping = useMemo(
    () =>
      watchHiddenTyping(
        ydoc,
        (origin) => {
          const provider = roomProvider(editorRef.current);
          return (
            !!provider && (origin === provider || origin === provider.provider)
          );
        },
        () => draftClients(drafted)
      ),
    [drafted, ydoc]
  );
  useEffect(() => () => hiddenTyping.dispose(), [hiddenTyping]);
  const checkpointTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Every unacknowledged receipt has to be tracked: a second edit before the
  // service answers the first must not orphan the earlier request.
  // Each request's local edit count, so a receipt covers the stored drafts.
  const pendingCheckpoints = useRef(new Map<string, number>());
  // The late path (in-place GC): the old document, merged once the room
  // synced: the handed document and every stored draft found for the note,
  // never-accepted ones included, in one merge (Q406). Until it applies the
  // editor is not shown, so nothing is edited or saved (a receipt would
  // cover the rows before their edits reached the room), nothing of it goes
  // raw and no draft send runs (so no Q360 hold). Rows another open tab
  // records stay out, untouched (Q420). `adoptedRows`: the rows the recorder
  // stands for; `sendRows`: the draft send's.
  // `lateStored`: the rows hold the handed document (its late row was
  // read), so the server's clean try of them stands for it (Q436).
  const [{ adoptedRows, lateDocument, lateStored, sendRows }] = useState(() => {
    if (!(late || restored.some((row) => row.late)))
      return {
        adoptedRows: restored,
        lateDocument: null,
        lateStored: false,
        sendRows: pending,
      };
    const rows = [...restored, ...pending].filter(
      (row) => !held.has(row.session)
    );
    const parts = rows.length ? [mergedRows(rows)] : [];
    return {
      adoptedRows: rows,
      lateDocument: Y.mergeUpdates(late ? [late.state, ...parts] : parts),
      lateStored:
        !late || rows.some((row) => row.late && row.session === late.session),
      sendRows: [] as EditDraft[],
    };
  });
  // The newest date of the rows the merge stands for, taken now: they go
  // once it applied (Q451).
  const [adoptedSavedAt] = useState(() =>
    adoptedRows.length
      ? adoptedRows.reduce((at, row) => Math.max(at, row.savedAt), 0)
      : undefined
  );
  const [lateMerging, setLateMerging] = useState(!!lateDocument);
  // The header reads Getting ready until the merge applied (Q295).
  const lateNow = useRef(!!lateDocument);
  // The merge's code did not load: Retry, or the browser's reconnect, tries
  // again (Q295, Q398).
  const [lateUnloaded, setLateUnloaded] = useState(false);
  // Until then the note shows the tab's own copy, read-only (Q295).
  const lateCopy = useMemo<MaterialDocument | null>(() => {
    if (!lateDocument) return null;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, lateDocument);
    const value = yTextToSlateElement(doc.get('content', Y.XmlText))
      .children as MaterialValue;
    doc.destroy();
    return { schemaVersion: 1, value };
  }, [lateDocument]);
  const unsavedChanges = useRef(restored.length > 0 && !lateDocument);
  const recorder = useRef<DraftRecorder | null>(null);
  // The room is unreachable: the editor keeps editing on this device.
  const offlineMode = useRef(false);
  // Steps were held (Q327): the next sync ends that stored-only episode.
  const heldEpisode = useRef(false);
  const storageOk = useRef(true);
  const overLimit = useRef(false);
  const [offlineLimit, setOfflineLimit] = useState(false);
  // The room refuses this build (the version gate): no reconnect, read-only.
  const [outdated, setOutdated] = useState(false);
  const stale = useRef(false);
  const rejected = useRef(false);
  // After the first sync a dropped connection keeps the editor on screen.
  const hasSynced = useRef(false);
  // Synced now: checkpoint requests wait for it.
  const roomSynced = useRef(false);
  const reconnector = useRef<RoomReconnector | null>(null);
  const joinStart = useRef(joinStartedAt);
  // The token request that failed, if one did: the provider only reports its
  // own "Failed to get token" text.
  const tokenError = useRef<unknown>(null);
  // The last room token handed to the provider: stored drafts keep it (Q288).
  const lastToken = useRef<string | undefined>(undefined);
  // Parsing normalizes and copies every node, so on a near-limit document this
  // costs seconds. It is the *initial* value — the room is authoritative from
  // sync onwards — so it is computed once per mount rather than on every
  // render that a status change or a projection refetch causes.
  const [projection] = useState<MaterialValue>(
    () =>
      parseMaterialDocument(material.content)?.value ??
      ([{ children: [{ text: '' }], type: 'p' }] as MaterialValue)
  );
  // Until the room's first sync the editor holds the saved copy, editable
  // (Q229): the projection, or the newest stored copy's edited value, whose
  // row this mount goes on with. What is typed there is kept on this device
  // as the copy and merges into the room's document once bound. A late
  // mount shows its own late copy read-only instead, and merges the copies
  // only once its late merge applied (Q295, Q406).
  const [initialValue] = useState(() =>
    lateDocument ? projection : (copies.adopted?.copy.mine ?? projection)
  );
  // The copy past the offline bound (review r1 L2): the editor stops, as
  // drafts do, until the room joins.
  const [copyFull, setCopyFull] = useState(false);
  const [copy] = useState(() =>
    recordCopy({
      adopted: copies.adopted,
      base: copies.adopted?.copy.base ?? projection,
      key: draftKey,
      limitBytes: MATERIAL_DOCUMENT_LIMITS.maxContentBytes,
      lineage: collaborationToken.room,
      onLimit: () => {
        setCopyFull(true);
        reportOffline.current?.('offline-limit');
      },
      revision: copies.adopted?.copy.revision ?? material.revision,
    })
  );
  // The copy was edited before the room's first sync.
  const copyEdited = useRef(false);
  const [scrollArea, setScrollArea] = useState<HTMLDivElement | null>(null);
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
  // Only the first handshake changes this tree; every later status lives in the
  // header. Holding the full status here re-rendered the toolbar and palette on
  // the first keystroke of every edit (Saved to Syncing).
  const [handshaking, setHandshaking] = useState(true);
  // The room's answer waits on the user's open budget (Epo 2026-10-20):
  // loading, not offline, until it syncs.
  const [slowed, setSlowed] = useState(false);
  // The room's presence (Epo 2026-10-20): cursor labels read its verified
  // names, and the header shows its avatar group.
  const [presence] = useState(createPresenceStore);
  const presenceChange = useRef(onPresenceChange);
  presenceChange.current = phase === 'paused' ? undefined : onPresenceChange;
  const reportPresence = useCallback(
    (connections: PresenceConnection[]) => {
      presence.getState().report(connections);
      presenceChange.current?.(connections);
    },
    [presence]
  );

  // Re-announcing a status the header already shows re-renders it for nothing.
  const reportedStatus = useRef<NoteEditorStatus['saveState'] | null>(null);
  // A note on screen whose reconnect is slowed by the open budget says so
  // under the header's sync indicator (Epo 2026-10-20); a first open says so
  // under its loading pane.
  const reportedSlowed = useRef(false);
  const phaseNow = useRef(phase);
  phaseNow.current = phase;
  // A paused editor reports nothing; a standby one reads as Reconnecting,
  // the paused note above it still on screen.
  const statusChange = useRef(onEditorStatusChange);
  statusChange.current = phase === 'paused' ? undefined : onEditorStatusChange;
  // Stored steps of never-accepted sessions go through the draft send while
  // the room joins (Q319): view-only until it settles. Past DRAFT_SEND_WAIT_MS
  // the note applies them and edits on, nothing live and every JOIN waiting
  // for the send, until the room took them (`heldSteps`, Q327, Q328). Both
  // read as syncing.
  const [draftsSending, setDraftsSending] = useState(sendRows.length > 0);
  const sendingNow = useRef(sendRows.length > 0);
  const heldSteps = useRef(false);
  const sender = useRef<DraftSender | null>(null);
  // Takes the pending steps once DRAFT_SEND_WAIT_MS passed and the room
  // synced, whichever comes last.
  const holdSteps = useRef<(() => void) | null>(null);
  const report = useCallback((saveState: NoteEditorStatus['saveState']) => {
    // A late mount reads Getting ready, standby beside the paused note too.
    const shown =
      lateNow.current && saveState !== 'offline' && saveState !== 'error'
        ? 'preparing'
        : phaseNow.current === 'standby'
          ? 'reconnecting'
          : (sendingNow.current || heldSteps.current) &&
              (saveState === 'saved' || saveState === 'reconnecting')
            ? 'syncing'
            : saveState;
    statusChange.current?.(
      reportedSlowed.current
        ? { saveState: shown, slowed: true }
        : { saveState: shown }
    );
  }, []);
  // Whether the merge view's choices may edit the note now (set once the
  // store exists), and whether the editor is locked.
  const canApplyNow = useRef(() => {});
  const lockedNow = useRef(false);
  // Adds pieces to the merge view (set once the store exists).
  const addPieces = useRef((_pieces: MergePiece[]) => {});
  const setStatus = useCallback(
    (next: NoteEditorStatus['saveState']) => {
      setHandshaking(next === 'connecting');
      if (reportedStatus.current === next) return;
      reportedStatus.current = next;
      report(next);
      canApplyNow.current();
    },
    [report]
  );
  const markSlowed = useCallback(
    (next: boolean) => {
      setSlowed(next);
      // A standby editor's open is the paused note's reconnect.
      const shown =
        next && (hasSynced.current || phaseNow.current === 'standby');
      if (reportedSlowed.current === shown) return;
      reportedSlowed.current = shown;
      if (reportedStatus.current) report(reportedStatus.current);
    },
    [report]
  );

  const markSyncing = useCallback(() => {
    // Pending work must not hide connection failures or finish the handshake.
    if (reportedStatus.current === 'saved') setStatus('syncing');
  }, [setStatus]);

  const hasUnsavedWork = useCallback(
    () => unsavedChanges.current || pendingCheckpoints.current.size > 0,
    []
  );
  const connecting = useCallback(() => {
    // A stopped editor (refused build, paused) keeps what it shows.
    if (stale.current) return;
    setStatus(hasSynced.current ? 'reconnecting' : 'connecting');
  }, [setStatus]);

  // Plugin options are captured before the editor exists, so the handlers they
  // fire are reached through refs instead of becoming plugin dependencies.
  const saveNow = useRef(() => {});
  const resendCheckpoints = useRef(() => {});
  const reportRejection = useRef(onDocumentRejected);
  const reportSaveDelayed = useRef(onSaveDelayed);
  // edit_incidents; the unconfirmed-edit warning once until saving works.
  const [reportIncident] = useState(() =>
    editIncidentReporter('material', material.id)
  );
  const unconfirmedReported = useRef(false);
  const [saveDelay] = useState(
    () =>
      new SaveDelayClock(NOTE_SAVE_DELAY_MS, () => {
        reportSaveDelayed.current?.(true);
        if (unconfirmedReported.current) return;
        unconfirmedReported.current = true;
        reportIncident(
          'unconfirmed_edit',
          undefined,
          recorder.current?.unsavedBytes
        );
      })
  );
  useEffect(() => () => saveDelay.dispose(), [saveDelay]);
  const reportUnavailable = useRef(onUnavailable);
  const reportOffline = useRef(onOffline);
  const reportOutdated = useRef(onOutdated);
  const reportLate = useRef(onLate);
  const reportLateUnloaded = useRef(onLateUnloaded);
  const showOffline = useCallback(() => {
    if (!offlineMode.current) return;
    reportOffline.current?.(
      overLimit.current
        ? 'offline-limit'
        : storageOk.current
          ? 'offline'
          : 'offline-unstored'
    );
  }, []);
  // Reconnecting kept failing or the browser went offline after the first
  // sync: edits go on, stored on this device, until the room syncs again.
  const goOffline = useCallback(() => {
    if (
      rejected.current ||
      stale.current ||
      !hasSynced.current ||
      offlineMode.current
    )
      return;
    offlineMode.current = true;
    setStatus('offline');
    recorder.current?.disconnected();
    showOffline();
  }, [setStatus, showOffline]);
  const goOfflineNow = useRef(goOffline);
  goOfflineNow.current = goOffline;
  // The room joined and its answer waits on the open budget: reachable, so
  // never offline meanwhile; an offline episode before it ends here.
  const slowedNow = useRef(() => {});
  slowedNow.current = () => {
    reconnector.current?.slowed();
    markSlowed(true);
    if (!offlineMode.current) return;
    offlineMode.current = false;
    recorder.current?.connected();
    reportOffline.current?.(null);
    connecting();
  };
  // Set once the editor exists; reports a room that turned read-only once.
  // `refusedConnect`: a (re)connect refused read-only, which only this
  // client sees; the service records the refusals it sends itself.
  const readOnlyNow = useRef(
    (_refusedConnect?: boolean, _code?: ReadOnlyCode) => {}
  );
  const projectionStale = useRef(false);
  // The room turned read-only and the unsaved edits were discarded.
  const discarded = useRef(false);
  // The late merge failed: the old document is kept as one refused row,
  // which the remount opens on the live note as the merge view's pieces
  // (Q420); the stored rows stay until then (no edit is dropped silently).
  const failLate = useRef((_old: Uint8Array, _error: unknown) => {});
  failLate.current = (old, error) => {
    // A mount the swap set aside leaves the rows to the next one.
    if (rejected.current || stale.current) return;
    rejected.current = true;
    stale.current = true;
    captureException(error, { tags: { component: 'late-merge' } });
    roomProvider(editorRef.current)?.disconnect();
    recorder.current?.refuse(old);
    pendingCheckpoints.current.clear();
    saveDelay.retain([]);
    setStatus('error');
    reportRejection.current?.('late', storageOk.current ? 'kept' : 'lost');
  };
  // This session is late (its JOIN, or a draft group of the note, answered
  // late): its document is kept as one late row, and the next editor merges
  // it with the document handed to it and every leftover draft (Q406).
  const goLate = useRef(() => {});
  goLate.current = () => {
    if (stale.current || rejected.current) return;
    stale.current = true;
    // The next mount merges the rows the draft send held (review r4 N3).
    sender.current?.stop();
    roomProvider(editorRef.current)?.disconnect();
    const kept = recorder.current?.late();
    // Edits past the 7-day expiry never merge (Q413): the next mount reads
    // the stored row as expired pieces, so nothing is handed over.
    const expired = !!kept && Date.now() - kept.savedAt > DRAFT_EXPIRY_MS;
    reportLate.current?.(
      kept && !expired
        ? { session: kept.session, state: Y.encodeStateAsUpdate(ydoc) }
        : null
    );
  };
  // The merged update was refused for an id the room never recorded (rows
  // of a never-accepted session ride in it, Q406): the old document goes to
  // a new editor, which writes its edits anew under its own assigned id,
  // once (merge view phase 2); what it cannot place becomes pieces.
  // The late row keeps its drafts' date (Q420), and what this mount did
  // after its merge applied stays beside it as pieces (Q451).
  const reauthorLate = useRef(() => {});
  reauthorLate.current = () => {
    if (!lateDocument || stale.current || rejected.current) return;
    stale.current = true;
    roomProvider(editorRef.current)?.disconnect();
    const kept = recorder.current?.late(
      lateDocument,
      adoptedSavedAt,
      mergedSequence.current
    );
    reportLate.current?.({
      reauthor: true,
      session: kept?.session ?? '',
      state: lateDocument,
    });
  };
  // Once synced, the old document's unsent edits are merged in a worker and
  // applied as one edit of this session (sent, stored, its receipt covering
  // the restored rows, which it replaces at once); then the note paints, and
  // the swap shows it. The blocks holding what the merge would hide (inside a
  // block someone deleted) stay whole, from the old document, as one refused
  // row flagged hidden, the merge view's pieces after the remount. With nothing
  // unsent the worker never loads. Code that did not load is tried again on
  // Retry and on the browser's reconnect, the own copy shown meanwhile
  // (Q295, Q398).
  const mergeStarted = useRef(false);
  // Set once the merged update is applied: from then on this session holds
  // the note's edits as any session does.
  const mergeApplied = useRef(false);
  // The recorder's sequence once the merged update applied.
  const mergedSequence = useRef<number | undefined>(undefined);
  // Stops the merge's worker when this editor goes (review r3 L4).
  const mergeStop = useRef<AbortController | null>(null);
  useEffect(() => {
    const stop = new AbortController();
    mergeStop.current = stop;
    return () => stop.abort();
  }, []);
  const mergeNow = useRef(() => {});
  mergeNow.current = () => {
    if (!lateDocument || mergeStarted.current) return;
    mergeStarted.current = true;
    setLateUnloaded(false);
    const signal = mergeStop.current?.signal;
    // The version the session held as the merge took the current document,
    // which its mark (`mergeBase`, required) holds it to.
    let base = 0;
    const merged = holdsUnsent(lateDocument, ydoc)
      ? mergeLate(
          lateDocument,
          () => {
            const taken = mergeBase(ydoc, markedRoom(editorRef.current));
            base = taken.version;
            return taken.state;
          },
          late?.reauthor ? ydoc.clientID : undefined,
          signal
        )
      : Promise.resolve(null);
    merged
      .then(async (result) => {
        if (rejected.current || stale.current) return;
        // Another send took the mark and a store cleared it, so a collection
        // may have passed the base: merge again (review r3 L1; a repeat is a
        // no-op for what the room holds).
        if (
          result &&
          (markedRoom(editorRef.current)?.reportedVersion ?? base) > base
        ) {
          mergeStarted.current = false;
          mergeNow.current();
          return;
        }
        if (result) {
          // Marked again as it applies: a send may have taken the mark and
          // left the next store to clear it (review r4 L1).
          markedRoom(editorRef.current)?.unsentFrom(base);
          applyMerged(ydoc, result.merged, LATE_ORIGIN, !!late?.reauthor);
        }
        mergeApplied.current = true;
        // Edits past this one are the mount's own (a re-author keeps them).
        mergedSequence.current = recorder.current?.sequence;
        lateNow.current = false;
        const hidden = result?.hidden.length
          ? hiddenDocument(lateDocument, result.hidden)
          : undefined;
        const kept = await recorder.current?.supersede(hidden, !!result);
        // Gone stale, paused, rejected or unmounted meanwhile: the copies
        // never merge into this editor and their rows stay (Q451).
        if (signal?.aborted || stale.current || rejected.current) return;
        if (hidden && !kept) {
          // The hidden blocks could not be stored: the adopted rows stay (no
          // receipt may delete them), the note never opens live here, and
          // the storage failure is shown.
          stale.current = true;
          roomProvider(editorRef.current)?.disconnect();
          reportRejection.current?.('late', 'lost');
          return;
        }
        setLateMerging(false);
        const waiting = boundWaiting.current;
        boundWaiting.current = null;
        if (waiting) bound.current(waiting);
        unsavedChanges.current = true;
        saveNow.current();
        if (reportedStatus.current) report(reportedStatus.current);
        if (hidden) reportRejection.current?.('late', 'kept');
      })
      .catch((error: unknown) => {
        if (signal?.aborted) return;
        if (!(error instanceof LateMergeUnloaded)) {
          failLate.current(lateDocument, error);
          return;
        }
        console.warn('The late merge did not load:', error);
        mergeStarted.current = false;
        if (!(rejected.current || stale.current)) setLateUnloaded(true);
      });
  };
  // Before any merge code, the server tries the rows this mount took as
  // ordinary drafts, once (Q436): every group admitted, the note opens
  // afresh, an ordinary session with no merge; anything else (late, hidden,
  // refused, unanswered) runs the merge. Rows not holding the handed
  // document (its late row was not read) go straight to the merge.
  const cleanTried = useRef(false);
  // The try is in flight: a sync meanwhile (a reconnect) waits for it.
  const cleanTrying = useRef(false);
  const tryClean = useRef(() => {});
  tryClean.current = () => {
    if (cleanTrying.current) return;
    // A re-author's rows name an id the room never recorded: no clean try.
    if (!lateDocument || cleanTried.current || late?.reauthor) {
      mergeNow.current();
      return;
    }
    cleanTried.current = true;
    if (!(lateStored && adoptedRows.length)) {
      mergeNow.current();
      return;
    }
    const ids = new Set(adoptedRows.map((row) => row.id));
    const current = () => !(stale.current || rejected.current);
    cleanTrying.current = true;
    void (async () => {
      let admitted: boolean | null = null;
      try {
        const room = await getMaterialCollaborationToken(material.id);
        if (room.access === 'write')
          admitted = await sendLateDrafts(draftKey, room, ids, current);
      } catch (error) {
        console.warn('Drafts cannot be sent:', error);
      }
      cleanTrying.current = false;
      if (!current()) return;
      // Every adopted row went in a group the room admitted (Q451).
      if (admitted) {
        stale.current = true;
        roomProvider(editorRef.current)?.disconnect();
        reportLate.current?.(null);
        return;
      }
      mergeNow.current();
    })();
  };
  // The note's strip offers Retry while the code did not load (Q398), ranked
  // after outdated and offline (NoteEditor, Q420).
  useEffect(() => {
    if (!(lateMerging && lateUnloaded)) return;
    const shown = reportLateUnloaded.current;
    shown?.(() => mergeNow.current());
    return () => shown?.(null);
  }, [lateMerging, lateUnloaded]);
  // A reconnecting browser tries the code again (Q398).
  useEffect(() => {
    if (!lateUnloaded) return;
    const again = () => mergeNow.current();
    window.addEventListener('online', again);
    return () => window.removeEventListener('online', again);
  }, [lateUnloaded]);

  useEffect(
    () => () => {
      if (!projectionStale.current) return;
      projectionStale.current = false;
      void qc.invalidateQueries({ queryKey: qk.material(material.id) });
    },
    [qc, material.id]
  );

  // The room refused this editor's copy for good. Unsaved edits are kept as
  // one refused draft: the remount turns them into the merge view's pieces
  // (Q251), never merged back. While a late merge waits, no draft row is
  // touched: none of them is in this document yet, and the remount merges
  // them (Q420).
  const rejectDocument = useCallback(
    (
      code: MaterialLimitCode | 'invalid_document' | 'unassigned' | 'revoked'
    ) => {
      if (rejected.current) return;
      if (
        code === 'unassigned' &&
        lateDocument &&
        mergeApplied.current &&
        !late?.reauthor
      ) {
        reauthorLate.current();
        return;
      }
      rejected.current = true;
      const merging = !!lateDocument && !mergeApplied.current;
      const unsaved =
        !merging && (hasUnsavedWork() || !!recorder.current?.unsaved);
      if (unsaved) recorder.current?.refuse();
      pendingCheckpoints.current.clear();
      saveDelay.retain([]);
      setStatus('error');
      reportRejection.current?.(
        code,
        merging
          ? 'kept'
          : unsaved
            ? storageOk.current
              ? 'kept'
              : 'lost'
            : 'none'
      );
    },
    [hasUnsavedWork, late, lateDocument, saveDelay, setStatus]
  );

  const handleStatelessEvent = useCallback(
    (payload: string) => {
      const event = parseCollaborationEvent(payload);
      if (!event) return;
      if (
        event.type === 'checkpoint-persisted' &&
        event.materialId === material.id
      ) {
        const metrics = event.metrics;
        if (metrics) {
          setDocumentStats((previous) =>
            sameStats(previous, metrics) ? previous : metrics
          );
          setDocumentLimitError(
            event.limitCode
              ? `${materialLimitMessage(event.limitCode)} ${m.editor_limit_remove_only()}`
              : null
          );
        }
        // A receipt also answers earlier requests it covers (one sent while
        // offline, say), and deletes the stored drafts it covers.
        let covered = -1;
        for (const id of event.checkpointIds)
          covered = Math.max(covered, pendingCheckpoints.current.get(id) ?? -1);
        const acknowledged = covered >= 0;
        if (acknowledged) {
          for (const [id, sequence] of pendingCheckpoints.current)
            if (sequence <= covered) pendingCheckpoints.current.delete(id);
          void recorder.current?.covered(covered);
        }
        saveDelay.retain(pendingCheckpoints.current.keys());
        // Saving works again: the banner goes, and comes back only if the
        // oldest request still unanswered crosses the threshold.
        if (acknowledged) {
          reportSaveDelayed.current?.(false);
          unconfirmedReported.current = false;
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
        // The receipts stay pending: the server's retry answers them. Every
        // failed store is rebroadcast; the banner is only for unsaved work.
        if (reportedStatus.current === 'unsaved') return;
        setStatus('unsaved');
        if (hasUnsavedWork()) reportSaveDelayed.current?.(true);
        return;
      }
      if (
        (event.type === 'document-rejected' &&
          event.materialId === material.id) ||
        (event.type === 'authorization-revoked' &&
          event.room === collaborationToken.room)
      ) {
        rejectDocument(
          event.type === 'document-rejected' ? event.code : 'revoked'
        );
        return;
      }
      if (
        event.type === 'room-read-only' &&
        event.room === collaborationToken.room
      ) {
        readOnlyNow.current(false, event.code);
        return;
      }
      if (event.type === 'children-ready') {
        announceChildrenReady(event);
        for (const id of event.materialIds) {
          void qc.invalidateQueries({ queryKey: qk.quiz(id) });
          void qc.invalidateQueries({ queryKey: qk.flashcardSet(id) });
          // The embedded set's block reads the material itself.
          void qc.invalidateQueries({ queryKey: qk.material(id) });
        }
        return;
      }
      if (event.type === 'children-refused') {
        userToast({
          description: m.error_quota_body(),
          id: 'paste-storage-refused',
          title: m.editor_paste_storage_refused(),
          variant: 'error',
        });
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
      }
    },
    [
      collaborationToken.room,
      hasUnsavedWork,
      qc,
      material.id,
      rejectDocument,
      saveDelay,
      setStatus,
    ]
  );

  const plugins = useMemo(() => {
    // The restored rows' version: the tab reports no newer one until the
    // room took them (none for a late merge, which joins new).
    const joinVersion = joinedFrom(restored, !!lateDocument);
    const onAuthenticationFailed = ({ reason }: { reason: string }) => {
      const failedToken = tokenError.current;
      const refusal = roomRefusal(reason, failedToken);
      tokenError.current = null;
      if (refusal === 'readOnly') readOnlyNow.current(true);
      else if (refusal === 'retry') reconnector.current?.refused();
      else if (refusal === 'late') {
        if (stale.current) return;
        // A new session is never late: a second answer before its merge
        // applied is a failure. After it, the session is late as any is
        // (it holds edits made since), so it goes the ordinary late way.
        if (lateDocument && !mergeApplied.current) {
          failLate.current(
            lateDocument,
            new Error('The room answered a late merge late again')
          );
          return;
        }
        goLate.current();
      }
      // The room holds this document's client id for no one: not retried.
      else if (refusal === 'unassigned') rejectDocument('unassigned');
      else if (refusal === 'outdated') {
        // Capy was updated: only a page reload helps. The unsaved edits
        // stay stored (the reloaded editor applies them before it joins).
        if (stale.current) return;
        stale.current = true;
        roomProvider(editorRef.current)?.disconnect();
        markUpdateAvailable();
        setStatus('error');
        setOutdated(true);
        reportOutdated.current?.(
          storageOk.current || !(hasUnsavedWork() || recorder.current?.unsaved)
        );
      } else {
        // The note's stored edits go too (not for an account lock); queued
        // before the recorder's discard, the report counts this session's
        // rows.
        if (refusalDropsDrafts(refusal, failedToken)) {
          // Written first, so the drop below takes it too.
          copy.stop();
          void dropLostDrafts(
            draftKey,
            refusal === 'notFound' ? 'not_found' : 'forbidden',
            reportIncident
          ).catch((error) => console.warn('Draft storage failed:', error));
          void recorder.current?.discard();
        }
        reportUnavailable.current?.(refusal);
      }
    };
    // While its never-accepted steps are held, a JOIN waits for the draft
    // send to take them (Q327), and the hold's connect asks for a send at
    // once (Q328, Q360).
    const beforeJoin = () => {
      if (!heldSteps.current) return;
      sender.current?.now();
      return sender.current?.settled;
    };
    return [
      YjsPlugin.configure({
        options: {
          // The caret goes in the compact shape (sendCaret below), with no
          // name or colour: peers label and colour it from the room's
          // presence (Epo 2026-10-20, 2026-10-28).
          cursors: { autoSend: true },
          onConnect: connecting,
          onDisconnect: () => {
            roomSynced.current = false;
            saveDelay.disconnected();
            reconnector.current?.disconnected();
            if (!navigator.onLine) {
              if (hasSynced.current) goOfflineNow.current();
              else setStatus('offline');
            } else if (!offlineMode.current) connecting();
          },
          onError: ({ error }) => {
            console.warn('Yjs collaboration provider error:', error);
            setStatus('error');
          },
          onSyncChange: ({ isSynced }) => {
            roomSynced.current = isSynced;
            // A bind Plate tried before the first sync happens now.
            if (isSynced) {
              bindSyncedRoom(editorRef.current);
              const hidden = hiddenTyping.synced();
              if (hidden.length) addPieces.current(hidden);
            }
            if (!isSynced || rejected.current) return;
            markSlowed(false);
            hasSynced.current = true;
            reconnector.current?.connected();
            saveDelay.connected();
            if (offlineMode.current || heldEpisode.current) {
              offlineMode.current = false;
              heldEpisode.current = false;
              recorder.current?.connected();
              reportOffline.current?.(null);
            }
            // Nothing of this device's to store is saved (Epo 2026-10-20).
            setStatus(
              unsavedChanges.current || pendingCheckpoints.current.size > 0
                ? 'syncing'
                : 'saved'
            );
            // Receipts requested while offline never reached the service,
            // and restored edits have none yet.
            resendCheckpoints.current();
            if (unsavedChanges.current) saveNow.current();
            tryClean.current();
            // A first sync after DRAFT_SEND_WAIT_MS still takes the held
            // steps (Q360).
            queueMicrotask(() => holdSteps.current?.());
          },
          providers: [
            USE_MSW
              ? ({
                  options: {
                    beforeJoin,
                    // The mock room is seeded as the service's holds the
                    // note: from its stored state, never a copy's edits.
                    initialValue: projection,
                    materialId: material.id,
                    name: collaborationToken.room,
                    onAuthenticationFailed,
                    onPresence: reportPresence,
                    onSlowed: (slowed: boolean) =>
                      slowed ? slowedNow.current() : markSlowed(false),
                    onStateless: ({ payload }: { payload: string }) => {
                      handleStatelessEvent(payload);
                    },
                    onStep1: hiddenTyping.armed,
                    unsentFrom: joinVersion,
                  },
                  type: 'mock',
                } as never)
              : ({
                  options: {
                    beforeJoin,
                    name: collaborationToken.room,
                    onAuthenticationFailed,
                    onClose: () => {
                      roomSynced.current = false;
                      markSlowed(false);
                      reconnector.current?.closed(
                        socketOpen(roomProvider(editorRef.current)?.provider)
                      );
                    },
                    onPresence: reportPresence,
                    onSlowed: (slowed: boolean) =>
                      slowed ? slowedNow.current() : markSlowed(false),
                    onStateless: ({ payload }: { payload: string }) => {
                      handleStatelessEvent(payload);
                    },
                    onStep1: hiddenTyping.armed,
                    token: async (previousToken?: string) => {
                      let token: MaterialCollaborationToken;
                      try {
                        token = await getMaterialCollaborationToken(
                          material.id,
                          { previousToken }
                        );
                      } catch (error) {
                        tokenError.current = error;
                        throw error;
                      }
                      // The room moved (a discard) while this tab was away:
                      // the new room in the cache remounts the editor onto it.
                      if (token.room !== collaborationToken.room) {
                        qc.setQueryData(
                          ['material', material.id, 'collaboration-token'],
                          token
                        );
                        throw new Error('collaboration room moved');
                      }
                      // A reconnect after the account froze gets a read token.
                      if (token.access === 'read') {
                        readOnlyNow.current(true);
                        throw new Error(COLLABORATION_READ_ONLY_REASON);
                      }
                      lastToken.current = token.token;
                      return token.token;
                    },
                    // Stored drafts not yet covered by a receipt (Q236).
                    unsent: () => !!recorder.current?.unsaved,
                    unsentFrom: joinVersion,
                    url: collaborationToken.url,
                  },
                  // The capy-sync room provider (features/collaboration/platePlugin).
                  type: 'capy',
                } as never),
          ],
          userId: currentUserId,
          ydoc,
        },
      }),
      // Binds to the room at its first sync (onSyncChange above).
      roomBindingPlugin,
      ...buildPlugins({
        allowExternalAssets,
        currentUserId,
        discussions,
        onSave: () => saveNow.current(),
        workspaceId: material.workspaceId,
      }),
    ];
  }, [
    allowExternalAssets,
    collaborationToken.room,
    collaborationToken.url,
    connecting,
    currentUserId,
    discussions,
    handleStatelessEvent,
    hasUnsavedWork,
    hiddenTyping,
    lateDocument,
    markSlowed,
    material.id,
    material.workspaceId,
    qc,
    rejectDocument,
    projection,
    reportPresence,
    restored,
    saveDelay,
    setStatus,
    ydoc,
  ]);

  // The channel its embedded quizzes and sets join inside (Epo 2026-10-20).
  const [seat] = useState(() => new NoteSeat());
  const editor = usePlateEditor({
    // slate-react re-creates the element descriptors of every block in a
    // modified chunk, so the chunk size is the number of blocks a keystroke
    // costs. Plate's default of 1000 leaves a near-limit note in four chunks:
    // one character re-created ~1000 descriptors, all of which then bailed out
    // of `MemoizedElement` without rendering. It is also the granularity of the
    // `content-visibility: auto` boxes that carry scrolling.
    chunking: { chunkSize: 32 },
    components: noteComponents,
    // stableElementIdsPlugin assigns ids in the operation the room records;
    // Plate's NodeIdPlugin would give the editor different ones.
    nodeId: false,
    plugins,
    value: initialValue,
  });
  // Undo reaches back 24 h (in-place collection, Epo 2026-10-23); the Yjs
  // history made its manager with the editor.
  limitUndo((editor as PlateEditor & YHistoryEditor).undoManager);
  // Provider callbacks are configured before the editor exists.
  const editorRef = useRef(editor);
  editorRef.current = editor;

  // Unsaved work is written to this device as it happens and deleted by the
  // receipts that cover it. Restored edits go in first, before the room
  // connects (init waits a task), and count as unsaved.
  useEffect(() => {
    if (!lateDocument) applyDrafts(ydoc, restored, RESTORE_ORIGIN);
    const current = recordDrafts({
      adopted: adoptedRows,
      doc: ydoc,
      ignore: (origin) => {
        if (origin === RESTORE_ORIGIN) return true;
        const room = roomProvider(editorRef.current);
        return !!room && (origin === room || origin === room.provider);
      },
      key: draftKey,
      limitBytes: MATERIAL_DOCUMENT_LIMITS.maxContentBytes,
      lineage: collaborationToken.room,
      onLimit: (over) => {
        overLimit.current = over;
        setOfflineLimit(over);
        showOffline();
      },
      onLost: toastDraftsLost,
      onStorage: (ok) => {
        storageOk.current = ok;
        showOffline();
      },
      report: reportIncident,
      token: () => lastToken.current,
      version: () => capyRoom(editorRef.current)?.reportedVersion,
    });
    recorder.current = current;
    return () => {
      void current.dispose();
      if (recorder.current === current) recorder.current = null;
    };
  }, [ydoc]);

  // The copy's rows: this mount's (or the one it went on with) and older
  // ones, which go once merged or discarded.
  const copyRows = useCallback(
    (own: DraftRef | null) => {
      const rows = [
        own,
        copies.adopted?.row,
        ...copies.others.map(({ row }) => row),
      ];
      return rows.filter((row): row is DraftRef => !!row);
    },
    [copies]
  );
  // The room turned read-only: the copy's edits go with the other unsaved
  // ones.
  const discardCopy = useRef(() => {});
  discardCopy.current = () => {
    void deleteDrafts(copyRows(copy.stop())).catch((error) =>
      console.warn('Draft storage failed:', error)
    );
  };
  // This mount's pieces (merge view, Q251); the live (or paused) one's
  // store is the sheet's.
  const store = useMemo(
    () =>
      createMergeStore({
        editor,
        key: draftKey,
        lineage: collaborationToken.room,
        onApplyFailed: (piece, error) => {
          captureException(error, { tags: { component: 'merge-view' } });
          reportIncident('merge_view', piece.source);
        },
        stored: pieces,
      }),
    // One store per mount: its editor, room and stored pieces are fixed.
    [editor]
  );
  useEffect(() => () => store.dispose(), [store]);
  addPieces.current = (found) => {
    void deleteOnceStored(store.add(found), [], toastDraftsLost);
  };
  // Choices that edit the note need it live, synced, bound and editable
  // (Q255): never paused, refused, locked, held or offline.
  canApplyNow.current = () =>
    store.setCanApply(
      phaseNow.current === 'live' &&
        !lockedNow.current &&
        !rejected.current &&
        !stale.current &&
        !heldSteps.current &&
        !offlineMode.current &&
        (reportedStatus.current === 'saved' ||
          reportedStatus.current === 'syncing' ||
          reportedStatus.current === 'unsaved') &&
        YjsEditor.connected(editor as unknown as YjsEditor)
    );
  // Stored groups become pieces once, after the first synced paint (Q251):
  // never applied, their rows go once the pieces are written.
  const converted = useRef(false);
  const convertSources = useRef(() => {});
  convertSources.current = () => {
    if (converted.current || stale.current || rejected.current) return;
    converted.current = true;
    for (const input of sources) {
      try {
        const value = editor.children as MaterialValue;
        // The group's rows go once its pieces are stored (Q397).
        void deleteOnceStored(
          store.add(
            'doc' in input
              ? piecesFromDrafts(input.doc, ydoc, value, input.source)
              : piecesFromCopy(input.copy, value, input.source)
          ),
          input.rows,
          toastDraftsLost
        );
      } catch (error) {
        // The rows stay for the next open.
        captureException(error, { tags: { component: 'merge-view' } });
      }
      if ('doc' in input) input.doc.destroy();
    }
  };
  // Bound at the room's first sync (roomBinding.ts): what was typed into the
  // saved copy merges into the room's document block by block (Q229), older
  // copies first, as one Undo step of ordinary edits under this session's
  // id, in the bind's own task (Q408), so they sync as any edit and save
  // through the normal checkpoint (Q410). Blocks both sides changed become
  // pieces, and the copies' rows go only once those are stored.
  // A late mount binds before its late merge applied: the copies and the
  // stored groups wait for it (Q406, Q408) and never merge if it fails or
  // the room goes (their rows stay stored).
  const boundWaiting = useRef<MaterialValue | null>(null);
  const bound = useRef((_unbound: MaterialValue) => {});
  bound.current = (unbound) => {
    // A mount out of the room merges nothing; the next one takes the rows.
    if (stale.current || rejected.current) return;
    if (lateDocument && !mergeApplied.current) {
      boundWaiting.current = unbound;
      return;
    }
    store.changed();
    canApplyNow.current();
    if (sources.length) afterPaint(() => convertSources.current());
    const own = copy.stop();
    // Past the offline bound, the copy as last written is merged; a late
    // mount never edited its copy, so the adopted one as stored.
    const mine = copy.over || lateDocument ? copy.kept : unbound;
    if (copyFull) {
      setCopyFull(false);
      reportOffline.current?.(null);
    }
    // Each with its last edit: past the 7-day expiry it becomes pieces
    // instead (Q421).
    const pairs: BoundCopy[] = copies.others.map(({ copy: other, row }) => ({
      ...other,
      editedAt: row.savedAt,
    }));
    if (mine && (copyEdited.current || copies.adopted))
      pairs.push({
        base: copies.adopted?.copy.base ?? projection,
        editedAt: copy.editedAt,
        mine,
      });
    if (!pairs.length) return;
    const merged = mergeAtBind(editor, pairs);
    // It threw (reported and told, Q433): the rows stay for the next open.
    if (!merged) return;
    // A bind before the mount's first paint (a swap's hidden build) reports
    // no value change.
    if (merged.applied) scheduleCheckpoint();
    void deleteOnceStored(
      store.add([
        ...piecesFromConflicts(merged.conflicts, 'conflict'),
        ...merged.expired,
      ]),
      copyRows(own),
      toastDraftsLost
    );
  };
  // Lets go of the copy's lock (a pause hands the row to the next mount).
  const releaseCopy = useRef(() => {});
  useEffect(() => {
    whenBound(editor, (unbound) => bound.current(unbound as MaterialValue));
    // This tab owns its copy row while mounted (review r1 M1): its own lock,
    // asked for before the adoption's lock goes (Q410), so no other tab
    // takes the row between them.
    const release = takeOverCopy(copy.session, copies.release);
    releaseCopy.current = release;
    // A copy edited and not written yet goes as the page or the editor goes.
    const flush = () => copy.flush();
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
      release();
    };
  }, [copies, copy, editor]);

  useEffect(() => {
    const current = roomReconnector({
      // Lost for good before the first sync: nothing to edit offline.
      onStuck: () => {
        if (stale.current || heldSteps.current) return;
        if (hasSynced.current) goOfflineNow.current();
        else setStatus('error');
      },
      provider: () =>
        rejected.current || stale.current
          ? null
          : roomProvider(editor)?.provider,
    });
    reconnector.current = current;
    // The join's 30 s from its token request, until the first sync (Epo
    // 2026-10-23).
    current.started(joinStart.current);
    return () => {
      current.dispose();
      if (reconnector.current === current) reconnector.current = null;
    };
  }, [editor, setStatus]);

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
      // `init` made the providers before its first wait: the note's room is
      // the seat its embeds join inside (Epo 2026-10-20).
      const provider = roomProvider(editor)?.provider;
      seat.attach(provider instanceof RoomProvider ? provider : null);
    }, 0);
    // Edit to View in this tab shows the live document at once: the toggle
    // asks for it before View renders, and the material query takes the
    // editor's value (co-editors' changes included) until the projection
    // refetched after unmount lands. Not edits the room refused or
    // discarded, nor a value never synced.
    const unregisterHandOver = registerLiveNote(material.id, () => {
      if (hasSynced.current && !rejected.current && !discarded.current)
        handOverLiveValue(qc, material.id, editor.children as MaterialValue);
    });
    return () => {
      active = false;
      clearTimeout(initializeTimer);
      if (checkpointTimer.current) clearTimeout(checkpointTimer.current);
      unregisterHandOver();
      seat.attach(null);
      if (initialized) editor.getApi(YjsPlugin).yjs.destroy();
      // A standby editor dropped for a newer one leaves the status to it.
      if (phaseNow.current === 'live') statusChange.current?.(null);
      presenceChange.current?.(null);
      // The next mount (a moved room, recovery, Reload) starts clean.
      reportOffline.current?.(null);
      reportSaveDelayed.current?.(false);
    };
  }, [collaborationToken.room, editor, material.id, qc, seat, setStatus]);

  // The draft send of never-accepted steps (Q319, Q327, Q328); none in a
  // late mount, which merges them (Q406).
  useEffect(() => {
    if (!sendRows.length) return;
    const current = draftSender(draftKey, () =>
      getMaterialCollaborationToken(material.id)
    );
    sender.current = current;
    let active = true;
    void current.settled.then(() => {
      if (!active) return;
      const held = heldSteps.current;
      sendingNow.current = false;
      heldSteps.current = false;
      setDraftsSending(false);
      // A group the room answered late (marked late): this session takes the
      // late path, the next mount merging it with this document (Q406).
      if (current.late) {
        goLate.current();
        return;
      }
      // A group the room did not take, its steps not applied here: the
      // remount shows it as pieces (Q360, Q251). Held ones the JOIN's refusal
      // takes there.
      if (current.kept && !held) {
        reportRejection.current?.('unassigned', 'kept');
        return;
      }
      if (reportedStatus.current) report(reportedStatus.current);
    });
    // Not settled in time: the note takes the steps itself and edits on,
    // every edit stored and nothing live until the room took them. Before
    // a first sync the join's own 30 s error stands; the hold waits for it.
    let waitOver = false;
    const hold = () => {
      if (!(active && waitOver && hasSynced.current) || current.done) return;
      if (heldSteps.current || rejected.current || stale.current) return;
      const room = roomProvider(editor)?.provider;
      heldSteps.current = true;
      heldEpisode.current = true;
      // Marked first, so the Leave says unsent and the session (this Y.Doc)
      // stays (review r1 N3).
      capyRoom(editor)?.unsentFrom(draftsVersion(sendRows));
      room?.disconnect();
      recorder.current?.disconnected(true);
      applyDrafts(ydoc, sendRows, RESTORE_ORIGIN);
      recorder.current?.adopt(sendRows);
      sendingNow.current = false;
      setDraftsSending(false);
      report('syncing');
      canApplyNow.current();
      void room?.connect();
    };
    holdSteps.current = hold;
    const timer = setTimeout(() => {
      waitOver = true;
      hold();
    }, DRAFT_SEND_WAIT_MS);
    return () => {
      active = false;
      clearTimeout(timer);
      current.stop();
      if (sender.current === current) sender.current = null;
      if (holdSteps.current === hold) holdSteps.current = null;
    };
  }, [draftKey, editor, material.id, report, sendRows, ydoc]);

  // Out of standby: the header shows this editor's own status now.
  const lastPhase = useRef(phase);
  useEffect(() => {
    if (
      lastPhase.current === 'standby' &&
      phase === 'live' &&
      reportedStatus.current
    )
      report(reportedStatus.current);
    lastPhase.current = phase;
  }, [phase, report]);

  // Being replaced (a discard, a refused update): read-only
  // from this render, out of the room, its unsaved edits written as a whole
  // document before the next room's drafts are read (a child's effects run
  // before NoteEditor's), and no reconnect. There is no way back: a paused
  // editor never goes live again, the next mount does (review I4).
  // A paused editor never binds, so its copy is the next mount's: written,
  // no longer recorded, and its lock let go for that mount to adopt it
  // (Q409).
  useEffect(() => {
    if (phase !== 'paused') return;
    stale.current = true;
    if (checkpointTimer.current) clearTimeout(checkpointTimer.current);
    reconnector.current?.dispose();
    void recorder.current?.dispose();
    copy.stop();
    releaseCopy.current();
    roomProvider(editor)?.disconnect();
  }, [copy, editor, phase]);
  // Edits stop at the model first, so a composition the pause ends adds
  // nothing; the DOM listeners stop the rest before Slate sees it.
  useEffect(() => {
    if (phase !== 'paused') return;
    noteFocusAtPause(editor);
    const release = holdModel(editor);
    // Slate's own handler inserts the composed text (dropped) first.
    const composed = () => setTimeout(() => dropComposedText(editor));
    scrollArea?.addEventListener('compositionend', composed);
    const resume = scrollArea ? pauseEdits(scrollArea) : undefined;
    return () => {
      resume?.();
      scrollArea?.removeEventListener('compositionend', composed);
      release();
    };
  }, [editor, phase, scrollArea]);

  // The first paint of the content, for the swap.
  const paintedChange = useRef(onPainted);
  paintedChange.current = onPainted;
  // A late merge paints once, with the editor, after it applied: a paused
  // note beside it shows the own copy meanwhile, and the swap keeps the
  // caret and focus. Only code that did not load paints the own copy first
  // (no editor in it), so its strip shows; the editor then paints again
  // (review r3 L2).
  const paintReported = useRef<'copy' | 'editor' | null>(null);
  useEffect(() => {
    const view = lateMerging
      ? lateUnloaded
        ? 'copy'
        : null
      : handshaking
        ? null
        : 'editor';
    // Each view once: the copy, then the editor.
    if (
      !(view && scrollArea) ||
      paintReported.current === view ||
      paintReported.current === 'editor'
    )
      return;
    return afterPaint(() => {
      paintReported.current = view;
      paintedChange.current?.({
        editor: view === 'editor' ? editor : null,
        scrollArea,
      });
    });
  }, [editor, handshaking, lateMerging, lateUnloaded, scrollArea]);

  // Cursor awareness goes to every peer through the server: at most one per
  // 50 ms, in the compact shape (Epo 2026-10-28) in place of the one
  // withCursors installs when the editor is made. The room joins only after
  // this runs (the first sync binds it).
  useEffect(() => {
    const sender = editor as CursorSender;
    const yjs = editor as unknown as YjsEditor & CursorEditor;
    sender.sendCursorPosition = (range) =>
      sendCaret(yjs, yjs.awareness, range as TRange | null);
    return throttleCursorPosition(sender, CURSOR_SEND_MS, Date.now, () =>
      YjsEditor.connected(yjs)
    );
  }, [editor]);

  useEffect(() => {
    // A blip the socket survived brings no provider event, so the status comes
    // back from the provider's own state; a dropped one reconnects by itself.
    const online = () => {
      if (stale.current || reportedStatus.current !== 'offline') return;
      // Steps held for the draft send: syncing again while it goes on, the
      // episode still unreported (Q328, Q360).
      if (heldSteps.current) {
        offlineMode.current = false;
        reportOffline.current?.(null);
        setStatus('syncing');
        return;
      }
      if (roomProvider(editor)?.isSynced)
        setStatus(hasUnsavedWork() ? 'syncing' : 'saved');
      // Offline mode lasts until the room syncs again.
      else if (!offlineMode.current) connecting();
    };
    const offline = () => {
      saveDelay.disconnected();
      if (hasSynced.current) goOfflineNow.current();
      else setStatus('offline');
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, [connecting, editor, hasUnsavedWork, saveDelay, setStatus]);

  const requestCheckpoint = useCallback(() => {
    if (rejected.current) return;
    // A receipt is only meaningful for work the service has not answered for
    // yet; asking about an already durable document would never be answered,
    // because nothing is left to store.
    if (!unsavedChanges.current && pendingCheckpoints.current.size === 0)
      return;
    const id = crypto.randomUUID();
    pendingCheckpoints.current.set(id, recorder.current?.sequence ?? 0);
    saveDelay.requested(id);
    unsavedChanges.current = false;
    // Enter the pending state before dispatching: a provider that answers
    // synchronously — the mock one does — would otherwise have its `saved`
    // acknowledgement overwritten by this line.
    markSyncing();
    requestReceipt(editor, roomSynced.current, id);
  }, [editor, markSyncing, saveDelay]);

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

  // The embeds the document holds now, for the footer. Only a change to the
  // top-level blocks (or a whole new value, as the room's first sync) can add
  // or remove one, so typing never reaches the scan.
  const [embeds, setEmbeds] = useState(() => embedKey(material.content.value));
  const changeValue = useCallback(
    ({ editor: current }: { editor: PlateEditor }) => {
      // The merge view's pieces follow the note (one frame later).
      store.changed();
      // The saved copy shown before the room's first sync was edited (Q229);
      // a late mount shows none.
      if (
        !lateDocument &&
        !YjsEditor.connected(current as unknown as YjsEditor) &&
        current.operations.some((op) => op.type !== 'set_selection')
      ) {
        copyEdited.current = true;
        copy.edited(
          current.children as MaterialValue,
          insertsMany(current.operations)
        );
      }
      scheduleCheckpoint();
      const { operations } = current;
      if (
        operations.length > 0 &&
        !operations.some(
          (op) => (op as { path?: readonly number[] }).path?.length === 1
        )
      )
        return;
      const next = embedKey(current.children);
      setEmbeds((previous) => (previous === next ? previous : next));
    },
    [copy, lateDocument, scheduleCheckpoint, store]
  );

  // `mod+s` stays registered so the browser's own save dialog never opens, and
  // it flushes the debounce rather than running a second checkpoint path.
  const saveImmediately = useCallback(() => {
    if (checkpointTimer.current) clearTimeout(checkpointTimer.current);
    requestCheckpoint();
  }, [requestCheckpoint]);

  const resendPendingCheckpoints = useCallback(() => {
    for (const id of pendingCheckpoints.current.keys()) {
      requestReceipt(editor, roomSynced.current, id);
    }
  }, [editor]);

  useEffect(() => {
    // A paused editor is being replaced: the next one reports for the note.
    const paused = phase === 'paused';
    reportRejection.current = paused ? undefined : onDocumentRejected;
    reportSaveDelayed.current = paused ? undefined : onSaveDelayed;
    reportUnavailable.current = paused ? undefined : onUnavailable;
    reportOffline.current = paused ? undefined : onOffline;
    reportOutdated.current = paused ? undefined : onOutdated;
    reportLate.current = paused ? undefined : onLate;
    reportLateUnloaded.current = paused ? undefined : onLateUnloaded;
    let reported = paused;
    readOnlyNow.current = (refusedConnect = false, code?: ReadOnlyCode) => {
      if (reported) return;
      reported = true;
      discarded.current = true;
      // While a late merge waits every draft row stays, none of it in this
      // document yet: the next open that can write merges them (Q426).
      if (!lateDocument || mergeApplied.current) {
        // The room refused the unsaved edits: they are discarded.
        const unsaved = recorder.current;
        if (refusedConnect && unsaved?.unsaved)
          reportIncident('discard_unsaved', 'read_only', unsaved.unsavedBytes);
        void recorder.current?.discard();
        discardCopy.current();
      }
      onReadOnly?.(code);
    };
    resendCheckpoints.current = resendPendingCheckpoints;
    saveNow.current = saveImmediately;
  }, [
    lateDocument,
    onDocumentRejected,
    onLate,
    onLateUnloaded,
    onOffline,
    onOutdated,
    onReadOnly,
    onSaveDelayed,
    onUnavailable,
    phase,
    resendPendingCheckpoints,
    saveImmediately,
  ]);

  // Offline past the bound, refused as outdated, or paused for a swap:
  // nothing may edit until reconnect, reload or the next editor. A paused
  // editor's content stops edits without Slate's readOnly (pauseEdits).
  // A late merge in flight: no local edit before its update is applied.
  const locked =
    offlineLimit ||
    copyFull ||
    outdated ||
    phase === 'paused' ||
    draftsSending ||
    lateMerging;
  lockedNow.current = locked;
  // Read through refs: these are what changes it here.
  useEffect(() => canApplyNow.current(), [locked, phase]);
  // The live or paused mount's pieces are the sheet's (standby registers
  // nothing): a paused one shows them with its choices off.
  const mergeStoreChange = useRef(onMergeStore);
  mergeStoreChange.current = onMergeStore;
  const shown = phase !== 'standby';
  useEffect(() => {
    if (!shown) return;
    mergeStoreChange.current?.(store, true);
    return () => mergeStoreChange.current?.(store, false);
  }, [shown, store]);
  // Edit opens with the toolbar as this device last left it: hidden by
  // default and when storage is blocked (Q461). The bolt toggles and saves it.
  const [toolbarShown, setToolbarShown] = useState(() =>
    readPref(PREF_KEYS.noteToolbar, false, isBoolean)
  );
  const toolbarToggle = useMemo(
    () => ({
      onToggle: () => {
        writePref(PREF_KEYS.noteToolbar, !toolbarShown);
        setToolbarShown(!toolbarShown);
      },
      shown: toolbarShown,
    }),
    [toolbarShown]
  );
  return (
    <EditorHoldScope>
      <NoteSeatContext.Provider value={seat}>
        <NoteBlockDialogsProvider noteId={material.id}>
          <div className="flex max-h-full flex-1 flex-col overflow-auto">
            <Plate editor={editor} onValueChange={changeValue}>
              <CollaborationProvider
                currentUserId={currentUserId}
                discussions={discussions}
              >
                {/* Held back: until sent. Hidden, not unmounted, until the
                 * Tools toggle asks. */}
                <div
                  className={cn('contents', !toolbarShown && 'hidden')}
                  data-note-toolbar=""
                  inert={locked}
                >
                  <CollaborationHold className="contents">
                    <NoteToolbar />
                  </CollaborationHold>
                </div>
                <div
                  className="relative min-h-0 flex-1 overflow-auto"
                  data-note-scroll=""
                  ref={setScrollArea}
                >
                  <NoteDisplayToggles toolbar={toolbarToggle} />
                  <div className="mx-auto flex min-h-full w-full max-w-7xl flex-col">
                    {/* The room replaces the projection copy the moment it syncs,
                     * so painting that copy first renders the whole document
                     * twice — seconds of it on a near-limit note. Anything other
                     * than a healthy handshake still paints, otherwise a broken
                     * collaboration service would leave a readable note hidden
                     * behind a spinner. */}
                    {lateCopy &&
                    lateMerging &&
                    (phase === 'live' || lateUnloaded) ? (
                      // The own copy, where no paused note shows it (Q295).
                      <div data-testid="late-copy">
                        <MaterialPreview
                          content={lateCopy}
                          isStandalone={!material.workspaceId}
                          kind={material.kind}
                          title={material.title}
                        />
                      </div>
                    ) : handshaking || lateMerging ? (
                      <FileLoading
                        message={m.editor_connecting()}
                        slowed={slowed}
                      />
                    ) : (
                      <>
                        <EditorScrollAreaContext.Provider value={scrollArea}>
                          <CollaborationHold>
                            <NoteEditorContent
                              discussions={discussions}
                              presence={presence}
                              readOnly={
                                offlineLimit ||
                                copyFull ||
                                outdated ||
                                draftsSending
                              }
                              shouldShowStats={shouldShowDocumentStats(
                                documentStats
                              )}
                            />
                          </CollaborationHold>
                        </EditorScrollAreaContext.Provider>
                        <NoteAttribution
                          beforeStats={shouldShowDocumentStats(documentStats)}
                          embedCredits={material.embedCredits}
                          embeds={embeds}
                          provenance={material.provenance}
                        />
                        <DocumentStatsFooter
                          limitError={documentLimitError}
                          stats={documentStats}
                        />
                      </>
                    )}
                  </div>
                </div>
                {/* Window-wide listeners: only the editor on screen. */}
                {!locked && phase === 'live' && <EditorCommandPalette />}
                {!locked && phase === 'live' && allowExternalAssets && (
                  <GhostTextSync title={material.title} />
                )}
              </CollaborationProvider>
            </Plate>
          </div>
        </NoteBlockDialogsProvider>
      </NoteSeatContext.Provider>
    </EditorHoldScope>
  );
}
