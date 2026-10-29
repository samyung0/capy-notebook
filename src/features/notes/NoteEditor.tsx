import { useQueryClient } from '@tanstack/react-query';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import {
  isAccountForbiddenError,
  isApiError,
  isMaterialContentUnreadable,
  qk,
} from '@/api/client';
import {
  useMaterial,
  useMaterialCollaborationToken,
  useMaterialDiscussions,
  useMe,
} from '@/api/hooks';
import type {
  Material,
  MaterialCollaborationToken,
  WorkspaceRole,
} from '@/api/types';
import {
  SaveBanner,
  type SaveBannerState,
} from '@/components/banners/SaveBanner';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/feedback';
import { userToast } from '@/components/ui/userToast';
import type { PresenceConnection } from '@/features/collaboration/presence';
import { FileError, FileLoading } from '@/features/files/FileStates';
import { MaterialRenderProvider } from '@/features/materials/MaterialRenderContext';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { draftKey, dropLostDrafts } from '@/lib/editDrafts';
import { editIncidentReporter } from '@/lib/editIncidents';
import { unexpectedErrorId } from '@/lib/errors';
import { blocksLayout } from './blocksuite/flag';
import {
  type MaterialLimitCode,
  materialLimitMessage,
  type ReadOnlyCode,
} from './collaborationEvents';
import {
  EditorRuntimeProvider,
  type EditorRuntimeValue,
} from './EditorRuntime';
import type { NoteEditorStatus } from './editorMode';
import type { MergeSnapshot, MergeStore } from './merge/mergeStore';
import { type NoteDrafts, useNoteDrafts } from './merge/noteDrafts';
import {
  type Handed,
  NoteEditorCore,
  type NoteEditorPhase,
  type NoteOfflineState,
} from './NoteEditorCore';
import { RECONNECT_GRACE_MS } from './roomConnection';
import {
  captureNotePosition,
  copyPausedView,
  type NotePosition,
  type NoteView,
  onPhone,
  restoreNotePosition,
  tabHidden,
} from './roomSwap';
import { toastSaveUndone } from './saveFailure';

// The merge view's sheet loads only once there are pieces to review.
const NoteMergeView = lazy(() => import('./merge/NoteMergeView'));
// Dev stacks with the blocks layout only (boundary 1, todo-blocksuite-spike.md).
const BlockSuiteNote = lazy(() => import('./blocksuite/BlockSuiteNote'));
const noSubscription = () => () => {};
const NO_PIECES: MergeSnapshot = {
  canApply: false,
  pieces: [],
  stale: null,
  unresolved: 0,
};
const noPieces = () => NO_PIECES;

/** Scrolls the note on screen to a piece's block, else to the block before
 * it, and marks it for 1.5 s (a DOM attribute: no Slate render). On a phone
 * the sheet covers the note's lower part, so it closes (`close`). */
function showPieceBlock(
  block: string,
  after: string | null,
  close: () => void
) {
  const live = document.querySelector('[data-note-mount="live"]');
  const find = (id: string | null) =>
    id === null
      ? null
      : live?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
  const target = find(block) ?? find(after);
  if (!target) return;
  if (onPhone()) close();
  target.scrollIntoView({ block: 'center' });
  target.setAttribute('data-merge-highlight', '');
  setTimeout(() => target.removeAttribute('data-merge-highlight'), 1500);
}

/** Shared so a pending discussions query does not hand the editor a new array
 * identity on every render. */
const NO_DISCUSSIONS: NonNullable<
  ReturnType<typeof useMaterialDiscussions>['data']
> = [];

export function NoteEditor({
  materialId,
  allowExternalAssets = false,
  onEditorStatusChange,
  onPresenceChange,
  onReadOnly,
}: {
  materialId: string;
  allowExternalAssets?: boolean;
  onEditorStatusChange?: (status: NoteEditorStatus | null) => void;
  /** The room's other editors, for the header's avatar group. */
  onPresenceChange?: (connections: PresenceConnection[] | null) => void;
  /** The room turned read-only (`code`: why, when it says): the note drops
   * to view mode and its unsaved edits are discarded. */
  onReadOnly?: (code?: ReadOnlyCode) => void;
}) {
  const {
    data: material,
    error,
    isLoading,
  } = useMaterial(materialId, {
    errorBoundary: false,
  });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (isMaterialContentUnreadable(error)) {
    return (
      <FileError
        message={m.material_decode_body()}
        title={m.material_decode_title()}
      />
    );
  }
  if (!material) {
    return (
      <FileError
        message={m.editor_note_deleted()}
        title={m.editor_note_not_found()}
      />
    );
  }

  if (!material.capabilities.canEditContent) {
    return (
      <FileError
        icon="securityWarning"
        message={m.editor_mode_unavailable_body()}
        title={m.editor_mode_unavailable()}
      />
    );
  }

  if (material.kind === 'note' && blocksLayout())
    return (
      <Suspense fallback={<FileLoading />}>
        <BlockSuiteNote
          key={material.id}
          material={material}
          onEditorStatusChange={onEditorStatusChange}
        />
      </Suspense>
    );

  return (
    <CollaborativeNoteEditor
      allowExternalAssets={allowExternalAssets}
      key={material.id}
      material={material}
      onEditorStatusChange={onEditorStatusChange}
      onPresenceChange={onPresenceChange}
      onReadOnly={onReadOnly}
    />
  );
}

function CollaborativeNoteEditor({
  material,
  allowExternalAssets,
  onEditorStatusChange,
  onPresenceChange,
  onReadOnly,
}: {
  material: Material;
  allowExternalAssets: boolean;
  onEditorStatusChange?: (status: NoteEditorStatus | null) => void;
  onPresenceChange?: (connections: PresenceConnection[] | null) => void;
  onReadOnly?: (code?: ReadOnlyCode) => void;
}) {
  const qc = useQueryClient();
  const {
    data: meData,
    isError: meIsError,
    isPending: meIsPending,
  } = useMe({
    errorBoundary: false,
  });
  // The collaboration service discards a room whose document breaks the
  // material limits, so the local Y.Doc becomes a fork the moment that happens.
  // A new mount (swapped in, useRoomSwap) is the only way back onto the
  // authoritative state: invalidating the token alone can return the same
  // room and leave this editor mounted.
  const [editorGeneration, setEditorGeneration] = useState(0);
  // Saves are failing or unconfirmed while the editor keeps its edits.
  const [saveDelayed, setSaveDelayed] = useState(false);
  // The room cannot be reached; the edits stay on this device.
  const [offline, setOffline] = useState<NoteOfflineState | null>(null);
  // The room refuses this build (Capy was updated) until the page reloads.
  const [outdated, setOutdated] = useState<
    'outdated' | 'outdated-unstored' | null
  >(null);
  // The live (or paused) mount's pieces (merge view, Q251) and the sheet's
  // state, which a room swap keeps.
  const [mergeStore, setMergeStore] = useState<MergeStore | null>(null);
  const onMergeStore = useCallback(
    (store: MergeStore, on: boolean) =>
      setMergeStore((current) =>
        on ? store : current === store ? null : current
      ),
    []
  );
  const merge = useSyncExternalStore(
    mergeStore?.subscribe ?? noSubscription,
    mergeStore?.getSnapshot ?? noPieces
  );
  const [reviewing, setReviewing] = useState(false);
  // The piece open in the sheet: a phone's sheet closes to show its block,
  // and Review reopens it on the same piece.
  const [reviewPiece, setReviewPiece] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  // A late note's merge code did not load: its Retry (Q398).
  const [lateRetry, setLateRetry] = useState<{ retry: () => void } | null>(
    null
  );
  const onLateUnloaded = useCallback(
    (retry: (() => void) | null) => setLateRetry(retry && { retry }),
    []
  );
  // One strip at a time, by priority (Q252, Q420).
  const banner: SaveBannerState | null =
    outdated ??
    offline ??
    (lateRetry ? 'late-unloaded' : null) ??
    (saveDelayed ? 'delayed' : null) ??
    (merge.unresolved ? 'review' : null);
  const closeReview = useCallback(() => {
    setReviewing(false);
    mergeStore?.close();
  }, [mergeStore]);
  const markOutdated = useCallback(
    (stored: boolean) => setOutdated(stored ? 'outdated' : 'outdated-unstored'),
    []
  );
  const onDocumentRejected = useCallback(
    (
      code:
        | MaterialLimitCode
        | 'invalid_document'
        | 'unassigned'
        | 'revoked'
        | 'late',
      edits: 'none' | 'kept' | 'lost'
    ) => {
      if (
        code !== 'invalid_document' &&
        code !== 'unassigned' &&
        code !== 'revoked' &&
        code !== 'late'
      )
        userToast({
          description: m.editor_too_large_body({
            message: materialLimitMessage(code),
          }),
          title: m.editor_too_large_title(),
          variant: 'error',
        });
      // Kept edits come back as the merge view's pieces after the remount.
      if (edits === 'lost') toastSaveUndone();
      setSaveDelayed(false);
      setOffline(null);
      setEditorGeneration((generation) => generation + 1);
      void qc.invalidateQueries({
        queryKey: ['material', material.id, 'collaboration-token'],
      });
    },
    [qc, material.id]
  );
  // Trashed, deleted, or access lost while open: the room refused to let the
  // editor back in.
  const [unavailable, setUnavailable] = useState<
    'notFound' | 'forbidden' | null
  >(null);
  const storedKey = meData
    ? draftKey(meData.id, 'material', material.id)
    : null;
  // The editor already dropped the stored edits (NoteEditorCore).
  const onUnavailable = useCallback(
    (kind: 'notFound' | 'forbidden') => {
      setUnavailable(kind);
      void qc.invalidateQueries({ queryKey: qk.material(material.id) });
      if (material.workspaceId)
        void qc.invalidateQueries({
          queryKey: qk.materials(material.workspaceId),
        });
    },
    [qc, material.id, material.workspaceId]
  );
  const reportReadOnly = useCallback(
    (code?: ReadOnlyCode) => {
      // Capabilities and the storage status follow from the refreshed reads.
      void qc.invalidateQueries({ queryKey: qk.material(material.id) });
      void qc.invalidateQueries({ queryKey: qk.me });
      if (material.workspaceId)
        void qc.invalidateQueries({
          queryKey: qk.workspace(material.workspaceId),
        });
      onReadOnly?.(code);
    },
    [qc, material.id, material.workspaceId, onReadOnly]
  );
  const role: WorkspaceRole | null =
    material.role ?? (material.isOwner ? 'owner' : null);
  const { data: discussionsData, isPending: discussionsIsPending } =
    useMaterialDiscussions(material.id, { errorBoundary: false });
  const {
    data: collaborationTokenData,
    error: collaborationTokenError,
    fetchStatus: collaborationTokenFetchStatus,
    isPending: collaborationTokenIsPending,
    refetch: refetchCollaborationToken,
  } = useMaterialCollaborationToken(material.id, true, {
    errorBoundary: false,
  });
  // A note's join starts at its token request, first open or reload, or at
  // a new mount of the same room, and has 30 s from then (Epo 2026-10-23):
  // the editor's room watch counts from this start, and a first open whose
  // token has not answered by then shows the connection error.
  const tokenFetching = collaborationTokenFetchStatus === 'fetching';
  const joinStart = useRef(Date.now());
  const [tokenAttempt, setTokenAttempt] = useState(0);
  const [tokenTimedOut, setTokenTimedOut] = useState(false);
  useEffect(() => {
    if (tokenFetching) joinStart.current = Date.now();
  }, [tokenFetching]);
  useEffect(() => {
    joinStart.current = Date.now();
  }, [editorGeneration]);
  useEffect(() => {
    if (collaborationTokenData || !tokenFetching) return;
    const timer = setTimeout(
      () => setTokenTimedOut(true),
      Math.max(0, joinStart.current + RECONNECT_GRACE_MS - Date.now())
    );
    return () => clearTimeout(timer);
  }, [collaborationTokenData, tokenFetching, tokenAttempt]);
  // Offline past the bound this device may hold, or refused as outdated:
  // every editing control (toolbar, palette, block actions) stands down with
  // the content.
  const canEdit =
    material.capabilities.canEditContent &&
    offline !== 'offline-limit' &&
    !outdated;
  const drafts = useNoteDrafts(
    material.id,
    storedKey,
    collaborationTokenData?.room,
    editorGeneration
  );
  const tokenStatus = isApiError(collaborationTokenError)
    ? collaborationTokenError.status
    : 0;
  // A 403 about the account itself (suspended, deletion pending) keeps them.
  const tokenDropsDrafts =
    tokenStatus === 404 ||
    (tokenStatus === 403 && !isAccountForbiddenError(collaborationTokenError));
  useEffect(() => {
    if (storedKey && tokenDropsDrafts)
      void dropLostDrafts(
        storedKey,
        tokenStatus === 404 ? 'not_found' : 'forbidden',
        editIncidentReporter('material', material.id)
      ).catch(() => undefined);
  }, [storedKey, tokenDropsDrafts, tokenStatus, material.id]);
  // Identity matters more than the allocation: this context is read from inside
  // the document tree, so a fresh object on every render makes React walk every
  // node's fiber looking for consumers instead of bailing out at the top.
  const currentUserId = meData?.id ?? null;
  const runtime = useMemo<EditorRuntimeValue>(
    () => ({
      allowExternalAssets,
      canEdit,
      currentUserId,
      materialId: material.id,
      role,
      workspaceId: material.workspaceId,
    }),
    [
      allowExternalAssets,
      canEdit,
      currentUserId,
      material.id,
      material.workspaceId,
      role,
    ]
  );
  const renderContext = useMemo(
    () => ({
      isStandalone: !material.workspaceId,
      kind: material.kind,
      title: material.title,
    }),
    [material.kind, material.title, material.workspaceId]
  );

  // A room reload swaps renderers (Epo 2026-10-22; roomSwap.ts): the room
  // and mount the note wants, and its editor once its stored edits are read.
  const wanted = collaborationTokenData
    ? `${collaborationTokenData.room}:${editorGeneration}`
    : null;
  const ready: NoteMount | null =
    collaborationTokenData && storedKey && drafts && drafts.for === wanted
      ? { drafts, key: wanted, token: collaborationTokenData }
      : null;
  const swap = useRoomSwap(ready, wanted, onEditorStatusChange);
  // The room answered late (in-place GC): the paused editor's document goes
  // to the next mount, which merges its unsent edits (NoteEditorCore `late`).
  const [late, setLate] = useState<{ key: string; handed: Handed } | null>(
    null
  );
  const room = collaborationTokenData?.room;
  const onLate = useCallback(
    (handed: Handed | null) => {
      const next = editorGeneration + 1;
      setLate(handed && { handed, key: `${room}:${next}` });
      setEditorGeneration(next);
    },
    [editorGeneration, room]
  );
  // The paused editor's banners went with its room: the next starts clean.
  useEffect(() => {
    if (!swap.pending) return;
    setOffline(null);
    setSaveDelayed(false);
    setLateRetry(null);
  }, [swap.pending]);

  if (unavailable === 'notFound')
    return (
      <FileError
        message={m.editor_note_deleted()}
        title={m.editor_note_not_found()}
      />
    );
  if (unavailable === 'forbidden')
    return (
      <FileError
        icon="securityWarning"
        message={m.editor_access_lost_body()}
        title={m.editor_access_lost()}
      />
    );

  // A first open's token never answered within the join's 30 s.
  if (tokenTimedOut && !collaborationTokenData)
    return (
      <FileError
        icon="error"
        message={m.editor_collab_unavailable()}
        onRetry={() => {
          joinStart.current = Date.now();
          setTokenTimedOut(false);
          setTokenAttempt((value) => value + 1);
          void refetchCollaborationToken();
        }}
      />
    );

  if (meIsPending || discussionsIsPending || collaborationTokenIsPending) {
    return <FileLoading />;
  }

  if (!meData || meIsError) {
    return <FileError icon="error" message={m.editor_user_info_failed()} />;
  }

  // Only a first request can fail here: once the editor holds a room, a new
  // token rides the open connection instead.
  if (!collaborationTokenData) {
    const status = tokenStatus;
    return status === 404 ? (
      <FileError
        message={m.editor_note_deleted()}
        title={m.editor_note_not_found()}
      />
    ) : status === 403 ? (
      <FileError
        icon="securityWarning"
        message={m.editor_access_lost_body()}
        title={m.editor_access_lost()}
      />
    ) : (
      <FileError
        errorId={unexpectedErrorId(collaborationTokenError)}
        icon="error"
        message={m.editor_collab_unavailable()}
        onRetry={() => void refetchCollaborationToken()}
      />
    );
  }

  // Stored edits are read for each room and mount before the editor opens.
  if (!(meData && storedKey && swap.shown)) return <FileLoading />;

  const renderMount = (mount: NoteMount, phase: NoteEditorPhase) => (
    <NoteEditorCore
      allowExternalAssets={allowExternalAssets}
      collaborationToken={mount.token}
      copies={mount.drafts.copies}
      currentUserId={meData.id}
      discussions={discussionsData ?? NO_DISCUSSIONS}
      draftKey={storedKey}
      held={mount.drafts.held}
      joinStartedAt={joinStart.current}
      late={late?.key === mount.key ? late.handed : undefined}
      material={material}
      onDocumentRejected={onDocumentRejected}
      onEditorStatusChange={onEditorStatusChange}
      onLate={onLate}
      onLateUnloaded={onLateUnloaded}
      onMergeStore={onMergeStore}
      onOffline={setOffline}
      onOutdated={markOutdated}
      onPainted={(view) => swap.painted(mount.key, view)}
      onPresenceChange={onPresenceChange}
      onReadOnly={reportReadOnly}
      onSaveDelayed={setSaveDelayed}
      onUnavailable={onUnavailable}
      pending={mount.drafts.pending}
      phase={phase}
      pieces={mount.drafts.pieces}
      restored={mount.drafts.current}
      sources={mount.drafts.sources}
    />
  );

  return (
    <MaterialRenderProvider value={renderContext}>
      <EditorRuntimeProvider value={runtime}>
        {/* One drag-and-drop backend for every editor mounted here: react-dnd
         * refuses two HTML5 backends at once. */}
        <DndProvider backend={HTML5Backend}>
          <div
            className={cn(
              'relative flex h-full flex-col gap-0 overflow-hidden',
              // A piece's block, marked for a moment as the sheet shows it.
              '[&_[data-merge-highlight]]:rounded-sm [&_[data-merge-highlight]]:bg-tint-warning'
            )}
          >
            {banner && (
              <SaveBanner
                onDiscard={() => setDiscarding(true)}
                onRetry={lateRetry?.retry}
                onReview={() => setReviewing(true)}
                state={banner}
              />
            )}
            {swap.mounts.map(({ mount, phase, hidden }) => (
              // Keyed by room and mount: the swap only changes the classes, so
              // the next editor's DOM is never moved or rebuilt.
              <div
                aria-hidden={phase === 'standby' || undefined}
                className={cn(
                  'flex min-h-0 flex-1 flex-col',
                  hidden && 'invisible absolute inset-0'
                )}
                data-note-mount={phase}
                inert={phase === 'standby'}
                key={mount.key}
              >
                {renderMount(mount, phase)}
              </div>
            ))}
            {swap.copying && (
              // A phone's paused note, as a copy over the editor remounting in
              // place under it.
              <div
                className="absolute inset-0 z-10 flex flex-col bg-surface"
                ref={swap.copyTarget}
              />
            )}
            {reviewing && mergeStore && (
              <Suspense fallback={null}>
                <NoteMergeView
                  onClose={closeReview}
                  onOpen={setReviewPiece}
                  onShow={(block, after) =>
                    showPieceBlock(block, after, () => setReviewing(false))
                  }
                  open={reviewPiece}
                  store={mergeStore}
                  underStrip={!!banner}
                />
              </Suspense>
            )}
            <ConfirmDialog
              body={m.merge_discard_body()}
              confirmLabel={m.merge_discard_confirm()}
              onClose={() => setDiscarding(false)}
              onConfirm={() => {
                mergeStore?.dismissAll();
                setReviewing(false);
              }}
              open={discarding}
              title={m.merge_discard_title()}
            />
          </div>
        </DndProvider>
      </EditorRuntimeProvider>
    </MaterialRenderProvider>
  );
}

/** One rendered room: the editor (or recovery) for a room and mount. */
interface NoteMount {
  drafts: NoteDrafts;
  key: string;
  token: MaterialCollaborationToken;
}

/**
 * Runs a room reload as a swap (Epo 2026-10-22). `shown` is the renderer on
 * screen; while the note wants another room or mount (`wanted`) it stays
 * paused, and once that one's stored edits are read (`ready`) the next one
 * builds hidden beside it and replaces it after its first paint, at the same
 * block. A hidden tab swaps at once; a phone remounts in place under a copy
 * of the paused view.
 */
function useRoomSwap(
  ready: NoteMount | null,
  wanted: string | null,
  onEditorStatusChange?: (status: NoteEditorStatus | null) => void
) {
  const [shown, setShown] = useState<NoteMount | null>(null);
  // The first open has nothing to pause.
  if (!shown && ready) setShown(ready);
  const pending = !!shown && shown.key !== wanted;
  const [copy, setCopy] = useState<ReturnType<typeof copyPausedView> | null>(
    null
  );
  // Each painted mount's editor and scroll box, by mount key.
  const views = useRef(new Map<string, NoteView>());
  const position = useRef<NotePosition | null>(null);
  const latest = useRef({ copy, pending, ready, shown });
  latest.current = { copy, pending, ready, shown };

  const swapTo = useCallback((next: NoteMount, withCopy: boolean) => {
    const old = latest.current.shown;
    const view = old && views.current.get(old.key);
    position.current = view ? captureNotePosition(view) : null;
    const root = view?.scrollArea.closest<HTMLElement>('[data-note-mount]');
    if (withCopy && root)
      setCopy(copyPausedView(root, position.current?.scrollTop ?? 0));
    setShown(next);
  }, []);

  // A hidden tab or a phone swaps as soon as the next one can mount; else it
  // builds beside the paused one and its first paint swaps (`painted`). The
  // path is decided once per swap, when the next mount is ready, so a
  // breakpoint crossing during the build keeps it (review M3).
  const readyKey = ready?.key;
  const path = useRef<{ key: string; way: 'beside' | 'copy' | 'now' }>(null);
  if (pending && readyKey && path.current?.key !== readyKey)
    path.current = {
      key: readyKey,
      way: tabHidden() ? 'now' : onPhone() ? 'copy' : 'beside',
    };
  const way = pending && readyKey ? path.current?.way : undefined;
  const atOnce = way === 'now' || way === 'copy';
  useLayoutEffect(() => {
    const mount = latest.current.ready;
    if (!(pending && readyKey && mount && way)) return;
    if (way !== 'beside') {
      swapTo(mount, way === 'copy');
      return;
    }
    const hidden = () => {
      const next = latest.current.ready;
      if (tabHidden() && next) swapTo(next, false);
    };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, [pending, readyKey, swapTo, way]);

  // The paused note says Reconnecting; a standby editor keeps saying so
  // itself, with a slowed open's line.
  useEffect(() => {
    if (pending) onEditorStatusChange?.({ saveState: 'reconnecting' });
  }, [pending, onEditorStatusChange]);

  // The shown editor painted after an at-once swap (its paint lifts a
  // phone's copy).
  const [paintedKey, setPaintedKey] = useState<string | null>(null);
  const painted = useCallback(
    (key: string, view: NoteView) => {
      views.current.set(key, view);
      const { pending: waiting, ready: next, shown: current } = latest.current;
      if (waiting && next?.key === key) swapTo(next, false);
      else if (current?.key === key) {
        setPaintedKey(key);
        setCopy(null);
      }
    },
    [swapTo]
  );

  // Back where the reader was once the next editor is on screen and
  // painted, before the browser paints the swap.
  useLayoutEffect(() => {
    const view = shown && views.current.get(shown.key);
    if (!(view && position.current) || copy) return;
    restoreNotePosition(view, position.current);
    position.current = null;
  }, [copy, paintedKey, shown]);

  const copyTarget = useCallback((element: HTMLDivElement | null) => {
    const current = latest.current.copy;
    if (!(element && current)) return;
    element.replaceChildren(current.copy);
    current.place();
  }, []);

  const mounts: {
    hidden: boolean;
    mount: NoteMount;
    phase: NoteEditorPhase;
  }[] = [];
  if (shown)
    mounts.push({
      hidden: false,
      mount: shown,
      phase: pending ? 'paused' : copy ? 'standby' : 'live',
    });
  if (pending && ready && !atOnce)
    mounts.push({ hidden: true, mount: ready, phase: 'standby' });
  // A mount that went takes its editor with it.
  const mounted = mounts.map(({ mount }) => mount.key).join(' ');
  useEffect(() => {
    const keys = new Set(mounted.split(' '));
    for (const key of views.current.keys())
      if (!keys.has(key)) views.current.delete(key);
  }, [mounted]);
  return {
    copying: !!copy,
    copyTarget,
    mounts,
    painted,
    pending,
    shown,
  };
}
