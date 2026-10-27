import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { api, isAccountForbiddenError, isApiError, qk } from '@/api/client';
import { useMe } from '@/api/hooks';
import type { SourceCollaborationToken, SourceSession } from '@/api/types';
import {
  isRecoveryBanner,
  recoveryBanner,
  type SaveBannerState,
} from '@/components/banners/SaveBanner';
import { userToast } from '@/components/ui/userToast';
import { COLLABORATION_READ_ONLY_REASON } from '@/features/notes/collaborationEvents';
import type { NoteEditorSaveState } from '@/features/notes/editorMode';
import {
  refusalDropsDrafts,
  roomReconnector,
  roomRefusal,
  sendCheckpointRequest,
  socketOpen,
} from '@/features/notes/roomConnection';
import {
  SaveDelayClock,
  SOURCE_SAVE_DELAY_MS,
} from '@/features/notes/saveDelay';
import { toastDraftsLost, toastSaveUndone } from '@/features/notes/saveFailure';
import { m } from '@/i18n';
import { markUpdateAvailable } from '@/lib/appRelease';
import { SOURCE_STATE_MAX_BYTES } from '@/lib/const';
import {
  applyDrafts,
  DRAFT_SEND_WAIT_MS,
  type DraftRecorder,
  type DraftSender,
  deleteDrafts,
  draftKey as documentDraftKey,
  draftGroups,
  draftSender,
  dropExpiredGroup,
  dropLostDrafts,
  type EditDraft,
  markDraftsReported,
  openRecoveryGroup,
  readDrafts,
  recordDrafts,
  reportRecoveryGroup,
  sameSourceLineage,
  sourceLineage,
  splitOpenDrafts,
} from '@/lib/editDrafts';
import { editIncidentReporter } from '@/lib/editIncidents';
import { CopyError, errorCopy } from '@/lib/errors';
import { officeMark } from '@/lib/officeMarks';
import { sawRoom } from '@/lib/undoPayloads';
import { PresenceContext } from './fileModeContext';
import { fileMoved } from './fileMoved';
import { createOfficeCursors } from './officeCursors';
import { takeSourceOpen } from './sourceOpen';
import {
  createSourceProvider,
  OFFICE_EDITING_PAUSED_REASON,
  SOURCE_PUBLISHING_REASON,
  type SourceProvider,
  sourceDocOptions,
} from './sourceProvider';
import { applySavedSource } from './sourceState';

export type SourceSaveState =
  | 'connecting'
  | 'reconnecting'
  | 'saving'
  | 'saved'
  | 'offline'
  /** A save failed and the server is retrying; edits stay in the editor. */
  | 'unsaved'
  | 'error'
  | 'recovery';
export const SOURCE_IFRAME_ORIGIN = Symbol('source-iframe');
const RESTORE_ORIGIN = Symbol('restore');
const LINEAGE_EPOCH = /:epoch:(\d+)@/;

export function acknowledgeSourceCheckpoint(
  state: {
    pending: Map<string, number>;
    acknowledged: number;
    sequence: number;
  },
  checkpointIds: readonly string[]
): boolean {
  let matched = false;
  for (const id of checkpointIds) {
    const sequence = state.pending.get(id);
    if (sequence !== undefined) {
      matched = true;
      state.acknowledged = Math.max(state.acknowledged, sequence);
    }
  }
  // An earlier request this receipt covers (one lost on a reconnect, say) is
  // answered too.
  for (const [id, sequence] of state.pending)
    if (sequence <= state.acknowledged) state.pending.delete(id);
  return matched && state.acknowledged >= state.sequence;
}

/**
 * Whether a checkpoint receipt covers every local change. A replaced session
 * also counts the changes the server held when this client answered handoff
 * ready (`handedOff`); a draft is skipped only for a receipt, which is durable.
 */
export function sourceChangesCovered(
  state: { acknowledged: number; sequence: number },
  handedOff = -1
): boolean {
  return Math.max(state.acknowledged, handedOff) >= state.sequence;
}

/**
 * Whether a refusal is the Office maintenance pause: the gateway's
 * `office_editing_paused` answer (token or session) or the collaboration
 * service's `office-editing-paused` authentication reason.
 */
/** A failure this session already reported (strip, status or toast). */
class SourceSessionError extends CopyError {}

/** Draft storage is best effort (private mode, a full disk): a failure reads
 * as nothing stored and never blocks editing. */
async function bestEffort<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (error) {
    console.warn('Source draft storage failed:', error);
    return null;
  }
}

export function sessionReported(value: unknown): boolean {
  return value instanceof SourceSessionError;
}

/** The header status of an open source editor (null outside Edit), in the
 * note editor's states. */
export function sourceHeaderStatus(
  status: SourceSaveState,
  { editing, busy }: { editing: boolean; busy: boolean }
): NoteEditorSaveState | null {
  if (!editing) return null;
  if (busy && (status === 'saved' || status === 'saving')) return 'syncing';
  switch (status) {
    case 'connecting':
    case 'reconnecting':
    case 'offline':
    case 'saved':
    case 'unsaved':
    case 'error':
      return status;
    case 'saving':
      return 'syncing';
    case 'recovery':
      return 'error';
  }
}

/**
 * Whether an edit open stops at the file's size limit, before it joins the
 * room (review r3 S1): no growth budget left (Epo 2026-10-17; text too,
 * 2026-10-20) and no restored drafts still to send. Recovery drafts open
 * before this check, so they can be seen, copied out or discarded; a read
 * session (its payer's storage is full) opens with its own banner.
 */
export function opensAtSizeLimit(
  session: { access: string; growthBudgetBytes?: number },
  restoredDrafts: number
) {
  return (
    session.access === 'write' &&
    session.growthBudgetBytes === 0 &&
    restoredDrafts === 0
  );
}

/**
 * An edit open the session stopped at the size limit drops to view with a
 * notice, and the mode control stays disabled from then on so the file reads
 * as not editable (Epo 2026-10-20); `toView` leaves the session. Returns
 * whether the control is disabled for it.
 */
export function useSizeLimitView(
  atSizeLimit: boolean,
  editing: boolean,
  toView: () => void
) {
  const [limited, setLimited] = useState(false);
  const toViewRef = useRef(toView);
  toViewRef.current = toView;
  useEffect(() => {
    if (!editing || !atSizeLimit) return;
    setLimited(true);
    toViewRef.current();
    userToast({ title: m.files_size_limit() });
  }, [editing, atSizeLimit]);
  return limited || atSizeLimit;
}

export function maintenancePaused(value: unknown): boolean {
  return (
    value === OFFICE_EDITING_PAUSED_REASON ||
    (isApiError(value) && value.code === 'office_editing_paused')
  );
}

/** `onReadOnly` runs when the room turns read-only (a storage or frozen
 * refusal) after the unsaved changes were discarded: the view leaves the
 * session and drops to view mode. `viewReady` is an Office view's frame
 * reporting its replica ready: its join ends there, not at the room's first
 * sync as a text view's does (Epo 2026-10-23). */
export function useSourceSession(
  fileId: string,
  enabled: boolean,
  onReadOnly?: () => void,
  viewReady?: boolean
) {
  const { data: me } = useMe({ errorBoundary: false });
  const readOnlyHandler = useRef(onReadOnly);
  readOnlyHandler.current = onReadOnly;
  const viewReadyRef = useRef(viewReady);
  viewReadyRef.current = viewReady;
  const viewJoined = useRef(() => {});
  useEffect(() => {
    if (viewReady) viewJoined.current();
  }, [viewReady]);
  // The room's other editors go to the header's avatar group (Epo
  // 2026-10-20).
  const presence = useContext(PresenceContext);
  const reportPresence = useRef(presence);
  reportPresence.current = presence;
  // Office co-editors' cursors, under the presence's names (Epo 2026-10-20).
  const [cursors] = useState(createOfficeCursors);
  const actorId = me?.id;
  const [loaded, setLoaded] = useState<{
    session: SourceSession;
    doc: Y.Doc;
    bytes: Uint8Array;
  } | null>(null);
  const [status, setStatus] = useState<SourceSaveState>('connecting');
  // The room's answer waits on the user's open budget (Epo 2026-10-20):
  // loading, not offline, until it syncs.
  const [slowed, setSlowed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Saves failing or unconfirmed (`delayed`), the room unreachable
  // (`offline…`), or recovery (`refused`, `changed`: the session shows unsaved
  // content it cannot save read-only, for copying, until Reload).
  const [banner, setBanner] = useState<SaveBannerState | null>(null);
  // Offline past the bound this device may hold: the editor stops taking
  // edits until the room is back.
  const [offlineLimit, setOfflineLimit] = useState(false);
  // The room refuses this build (Capy was updated): the session stopped, the
  // view stays read-only under the outdated strip and the unsaved changes
  // stay stored for the reloaded page.
  const [outdated, setOutdated] = useState(false);
  // The edit open stopped at the file's size limit (`opensAtSizeLimit`).
  const [atSizeLimit, setAtSizeLimit] = useState(false);
  // The file was trashed or deleted, or access to it lost, while editing.
  const [unavailable, setUnavailable] = useState<
    'notFound' | 'forbidden' | null
  >(null);
  const discardHandler = useRef<(() => Promise<void>) | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const discardDraft = useCallback(async () => {
    if (!discardHandler.current) return;
    setDiscarding(true);
    try {
      await discardHandler.current();
    } catch (value) {
      setError(errorCopy(value, m.error_file_body()));
    } finally {
      setDiscarding(false);
    }
  }, []);
  const [generation, setGeneration] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [bufferDirty, setBufferDirty] = useState(false);
  const bufferDirtyRef = useRef(false);
  const pendingInput = useCallback((pending: boolean) => {
    bufferDirtyRef.current = pending;
    setBufferDirty(pending);
  }, []);
  const [handoff, setHandoff] = useState(false);
  // A newer version was published while this saved view stayed open, or the
  // maintenance pause closed it (paused: the banner says so). Paused with no
  // document means the pause refused the session before it opened.
  const [replaced, setReplaced] = useState(false);
  const [paused, setPaused] = useState(false);
  // The room turned read-only (a frozen account or an owner at its storage
  // limit): the unsaved changes are discarded and the view drops to view mode
  // under the read-only strip.
  const [readOnly, setReadOnly] = useState(false);
  // Stored steps of never-accepted sessions are in the draft send while the
  // room joins (Q319): view-only until it settles. Held: past
  // DRAFT_SEND_WAIT_MS the session took them itself and edits on, nothing
  // live until the room took them (Q327). Both read as saving.
  const [draftsSending, setDraftsSending] = useState(false);
  const [draftsHeld, setDraftsHeld] = useState(false);
  const qc = useQueryClient();
  useEffect(() => {
    if (!readOnly) return;
    // Capabilities and the storage status follow from the refreshed reads.
    void qc.invalidateQueries({ queryKey: qk.me });
    void qc.invalidateQueries({ queryKey: ['workspace'] });
  }, [readOnly, qc]);
  const flushHandler = useRef<((pause?: boolean) => Promise<void>) | null>(
    null
  );
  const [synced, setSynced] = useState(false);
  // The id the room stored for a DOCX editor's layout worker (Q219).
  const [workerClientId, setWorkerClientId] = useState<number>();
  const runtime = useRef<{
    provider: SourceProvider;
    checkpoint: (flush?: boolean) => void;
    sequence: number;
    acknowledged: number;
    pending: Map<string, number>;
    recovery: boolean;
    /** The room synced since it last connected: receipts may be asked. */
    synced: boolean;
  } | null>(null);
  const flushWaiters = useRef<
    { sequence: number; resolve: () => void; reject: (error: Error) => void }[]
  >([]);
  const save = useCallback(async (): Promise<void> => {
    await flushHandler.current?.();
    const active = runtime.current;
    if (!active || active.recovery)
      return Promise.reject(new SourceSessionError(m.source_edit_recovery()));
    if (active.acknowledged >= active.sequence && !bufferDirtyRef.current)
      return Promise.resolve();
    // Authenticated, not yet synced: the sync's own request answers it.
    if (!(active.synced || active.provider.isAuthenticated))
      return Promise.reject(new SourceSessionError(m.source_edit_offline()));
    return new Promise((resolve, reject) => {
      flushWaiters.current.push({ reject, resolve, sequence: active.sequence });
      active.checkpoint(true);
    });
  }, []);

  useEffect(() => {
    if (!enabled || !fileId || !actorId) return;
    const draftKey = documentDraftKey(actorId, 'file', fileId);
    // A stored group shown in recovery (Reload deletes it), or the live
    // session's recorder (Reload discards what it wrote).
    let recoveryDrafts: Pick<EditDraft, 'id' | 'key' | 'seq'>[] | null = null;
    let recorder: DraftRecorder | null = null;
    let cancelled = false;
    // The effect ended (unmount, another file or session generation).
    let disposed = false;
    const controller = new AbortController();
    let provider: SourceProvider | null = null;
    let doc: Y.Doc | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let goOffline = () => {};
    // Back online while the steps are held: saving again (Q328, Q360).
    let backOnline = () => {};
    // The draft send of never-accepted stored steps, and whether the steps
    // are held here (every JOIN waits for the send, Q327).
    let sender: DraftSender | null = null;
    let heldSteps = false;
    let heldEpisode = false;
    // Takes the pending steps once DRAFT_SEND_WAIT_MS passed and the room
    // synced, whichever comes last; its timer clears on teardown.
    let hold = () => {};
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    // The join (Epo 2026-10-23): one 30 s watch from here over the session
    // request, the room's answer and an Office view's ready; a session that
    // has not joined by then errors as a first join does.
    let joined = false;
    // The join's 30 s ran out before it finished (its error shows).
    let timedOut = false;
    const reconnect = roomReconnector({
      // Reconnecting kept failing: edit on this device until it is back.
      onStuck: () => {
        if (cancelled || runtime.current?.recovery || heldSteps) return;
        if (joined) goOffline();
        else {
          timedOut = true;
          setStatus('error');
        }
      },
      // A closed session never reconnects (replaced, paused, reset).
      provider: () =>
        cancelled || runtime.current?.recovery ? null : provider,
    });
    reconnect.started();
    // Joined with the room synced (an Office view once its frame is ready
    // too). A join that finishes past its 30 s gets its status back, as a
    // note's late sync does (review r3 M1): an Office view's ready comes
    // after the sync that set it.
    const join = () => {
      const live = runtime.current;
      if (!live?.synced) return;
      joined = true;
      reconnect.connected();
      if (!timedOut) return;
      timedOut = false;
      setStatus(
        live.sequence > 0 && !sourceChangesCovered(live) ? 'saving' : 'saved'
      );
    };
    viewJoined.current = join;
    const report = editIncidentReporter('source_file', fileId);
    // The unconfirmed-edit warning is reported once until saving works again.
    let unconfirmedReported = false;
    const delay = new SaveDelayClock(SOURCE_SAVE_DELAY_MS, () => {
      if (cancelled || runtime.current?.recovery) return;
      setBanner((current) => current ?? 'delayed');
      if (unconfirmedReported) return;
      unconfirmedReported = true;
      report('unconfirmed_edit', undefined, recorder?.unsavedBytes);
    });
    const offline = () => {
      delay.disconnected();
      goOffline();
    };
    const online = () => backOnline();
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    const rejectWaiters = (reason: Error) => {
      for (const waiter of flushWaiters.current.splice(0))
        waiter.reject(reason);
    };
    const fail = (value: unknown) => {
      if (cancelled) return;
      // Refused before the room opened: the view falls back to view mode.
      if (maintenancePaused(value) && !runtime.current) {
        setPaused(true);
        return;
      }
      if (isApiError(value) && (value.status === 404 || value.status === 403)) {
        const gone = value.status === 404;
        // The user no longer has this file: its stored edits go too (not
        // for a 403 about the account itself: suspended, deletion pending).
        if (!isAccountForbiddenError(value))
          void bestEffort(() =>
            dropLostDrafts(draftKey, gone ? 'not_found' : 'forbidden', report)
          );
        setUnavailable(gone ? 'notFound' : 'forbidden');
        return;
      }
      const next = new SourceSessionError(
        maintenancePaused(value)
          ? m.source_edit_paused_error()
          : errorCopy(value, m.error_file_body())
      );
      setError(next.message);
      setStatus('error');
      rejectWaiters(next);
    };
    discardHandler.current = async () => {
      if (recoveryDrafts) await deleteDrafts(recoveryDrafts);
      else await recorder?.discard();
      if (!cancelled) {
        pendingInput(false);
        setGeneration((value) => value + 1);
      }
    };
    setStatus('connecting');
    setDirty(false);
    setHandoff(false);
    setReplaced(false);
    setDraftsSending(false);
    setDraftsHeld(false);
    setPaused(false);
    setReadOnly(false);
    setUnavailable(null);
    setSynced(false);
    setError(null);
    setBanner(null);
    setOfflineLimit(false);
    setOutdated(false);
    setAtSizeLimit(false);
    setLoaded(null);
    void (async () => {
      // The route may have started the session, token and base already.
      const [open, storedDrafts] = await Promise.all([
        takeSourceOpen(fileId, 'edit', controller.signal),
        bestEffort(() => readDrafts(draftKey)),
      ]);
      if (cancelled) return;
      const { base, session } = open;
      const credentials = open.credentials!;
      if (
        session.epoch !== credentials.epoch ||
        session.room !== credentials.room
      ) {
        controller.abort();
        throw new SourceSessionError(m.source_edit_session_changed());
      }
      const docOptions = sourceDocOptions(session.format);
      const shared = new Y.Doc(docOptions);
      doc = shared;
      // A text session carries its state; an Office editor takes its document
      // from the room's sync (the stored state may be a change over the seed).
      if (session.format === 'text')
        applySavedSource(shared, session, RESTORE_ORIGIN);
      const lineage = sourceLineage(session);
      const {
        current: restoredDrafts,
        expired,
        recovery: found,
        refused,
      } = await draftGroups(
        storedDrafts ?? [],
        lineage,
        sameSourceLineage(session.format)
      );
      const draft = found[0];
      const opened = draft
        ? await openRecoveryGroup(found, report, docOptions)
        : null;
      if (cancelled) return;
      if (draft && opened && typeof opened === 'object') {
        // Recovery shows the edits over their own base, an expired group
        // once.
        controller.abort();
        if (expired) dropExpiredGroup(found, report);
        else reportRecoveryGroup(found, report, refused);
        recoveryDrafts = found;
        shared.destroy();
        const recovered = opened.doc;
        doc = recovered;
        // The lineage names the epoch and base the edits grew from.
        const epoch = LINEAGE_EPOCH.exec(draft.lineage)?.[1];
        if (epoch === undefined)
          throw new Error(`Draft lineage names no epoch: ${draft.lineage}`);
        setLoaded({
          bytes: opened.base,
          doc: recovered,
          session: {
            ...session,
            baseSourceSHA256: draft.base!,
            epoch: Number(epoch),
          },
        });
        setStatus('recovery');
        setDirty(true);
        setBanner(recoveryBanner({ expired, refused }));
        // No room joins: recovery is its answer.
        reconnect.dispose();
        return;
      }
      // A draft nothing can draw was dropped; one whose base could not be
      // read stays for the next open.
      if (opened === 'dropped') toastDraftsLost();
      recoveryDrafts = null;
      if (opensAtSizeLimit(session, restoredDrafts.length)) {
        controller.abort();
        shared.destroy();
        doc = null;
        reconnect.dispose();
        setAtSizeLimit(true);
        return;
      }
      // The room opens while the base downloads; the view gets the document
      // with its base (`show`), however the room answers first.
      let shown = false;
      const show = async () => {
        shown = true;
        let bytes: Uint8Array;
        try {
          bytes = await base;
        } catch {
          // A failed base ends the session (`baseRead`).
          return;
        }
        if (!disposed && shown) setLoaded({ bytes, doc: shared, session });
      };
      // Accepted sessions' rows apply here, in one update (a long session
      // leaves a row per edit); never-accepted ones with stored tokens go
      // through the draft send (Q326).
      const { apply, send: pendingDrafts } = splitOpenDrafts(restoredDrafts);
      applyDrafts(shared, apply, RESTORE_ORIGIN);
      if (apply.length) setDirty(true);
      let initialToken: SourceCollaborationToken | null = credentials;
      const pending = new Map<string, number>();
      const active = {
        acknowledged: -1,
        checkpoint: () => {},
        disconnects: 0,
        // Sequence at which this client answered handoff ready: the server
        // held every update then, so the publication includes them. Only the
        // connection the server waits on counts, so a disconnect clears it.
        handedOff: -1,
        pending,
        provider: null as unknown as SourceProvider,
        recovery: false,
        // The recorder counts local edits (restored drafts are edit 1).
        get sequence() {
          return recorder?.sequence ?? 0;
        },
        synced: false,
      };
      const unsyncedWaiters: (() => void)[] = [];
      // Only a client that synced once has an editor to keep on screen.
      let everSynced = false;
      // The token request that failed, if one did (the provider only reports
      // its own text for it).
      let tokenError: unknown = null;
      // The last room token handed to the provider: stored drafts keep it
      // (Q288).
      let lastToken: string | undefined;
      // Set by reset() and refuse(): later typing changes nothing stored.
      let discarded = false;
      // Set by stale(): a late change (the frame's last input) is stored
      // and nothing more is sent.
      let refusedBuild = false;
      // The room is unreachable and this session keeps editing on the
      // device: the offline banner, until the room syncs again.
      let offlineMode = false;
      let storageOk = true;
      let overLimit = false;
      const offlineBanner = (): SaveBannerState =>
        overLimit
          ? 'offline-limit'
          : storageOk
            ? 'offline'
            : 'offline-unstored';
      const showOffline = () => {
        if (offlineMode)
          setBanner((current) =>
            isRecoveryBanner(current) ? current : offlineBanner()
          );
      };
      goOffline = () => {
        if (cancelled || active.recovery || !everSynced || offlineMode) return;
        offlineMode = true;
        setStatus('offline');
        recorder?.disconnected();
        showOffline();
      };
      backOnline = () => {
        if (cancelled || !heldSteps || !offlineMode) return;
        offlineMode = false;
        setBanner((current) => (isRecoveryBanner(current) ? current : null));
        setStatus('saving');
      };
      // Back to the last saved version with nothing unsaved worth keeping:
      // this session's drafts go. Lost access or a file gone (`lostAccess`)
      // drops every session's drafts of the file, other tabs' included; the
      // reopened session shows the missing or no-access panel. The service
      // recorded this session's edits; the other sessions' drafts deleted
      // after it are reported here.
      const reset = (lostAccess?: 'forbidden' | 'not_found') => {
        if (cancelled) return;
        if (!sourceChangesCovered(active) || bufferDirtyRef.current)
          toastSaveUndone();
        cancelled = true;
        discarded = true;
        clearTimeout(timer);
        provider?.disconnect();
        rejectWaiters(new SourceSessionError(m.editor_save_failed_undone()));
        void (async () => {
          await recorder?.discard();
          // Rows of this lineage reached this room (another tab's too) and
          // are in the service's row; only other lineages are counted. A
          // same-lineage tab that was offline at the refusal (its edits never
          // reached the room) goes uncounted: an accepted undercount.
          const same = sameSourceLineage(session.format);
          if (lostAccess)
            await bestEffort(() =>
              dropLostDrafts(
                draftKey,
                lostAccess,
                report,
                (row) => !same(row.lineage, lineage)
              )
            );
          pendingInput(false);
          setGeneration((value) => value + 1);
        })();
      };
      // A save the server refused for good: the room went back to the last
      // good save. Unsaved edits stay in this session's drafts, marked
      // refused so no later open merges them back (they would replay the
      // refused state), and the editor shows them read-only for copying until
      // Reload (discardDraft) reopens the last good save.
      const refuse = () => {
        if (cancelled || active.recovery) return;
        if (sourceChangesCovered(active) && !bufferDirtyRef.current) {
          reset();
          return;
        }
        discarded = true;
        clearTimeout(timer);
        // One refused row of the whole state replaces this session's rows;
        // Reload deletes it.
        const refused = recorder?.refuse();
        recoveryDrafts = refused ? [refused] : [];
        rejectWaiters(new SourceSessionError(m.source_edit_recovery()));
        active.recovery = true;
        void show();
        setStatus('recovery');
        setBanner('refused');
        setSynced(false);
        provider?.disconnect();
      };
      // Capy was updated and the room refuses this build: the session stops
      // for the page load, read-only (a session that never synced shows its
      // base and this device's drafts), and its drafts stay for the reloaded
      // page, which sends them through the new version's checks.
      const stale = () => {
        if (cancelled) return;
        cancelled = true;
        refusedBuild = true;
        clearTimeout(timer);
        provider?.disconnect();
        markUpdateAvailable();
        rejectWaiters(new SourceSessionError(m.editor_outdated()));
        // Stored on this device for the reloaded page: leaving loses nothing,
        // so Reload asks nothing.
        if (storageOk) setDirty(false);
        void show();
        setHandoff(false);
        setStatus('error');
        setBanner(storageOk ? 'outdated' : 'outdated-unstored');
        setOutdated(true);
      };
      // Nothing local is pending any more: the receipt deletes the drafts.
      const settle = () => {
        setDirty(false);
        setError(null);
        void recorder?.covered(active.acknowledged);
      };
      const markSaved = () => {
        setStatus('saved');
        setBanner(null);
        unconfirmedReported = false;
        settle();
      };
      // A newer version was published, or the maintenance pause closed the
      // room. A saved client keeps its view read-only under the reload
      // banner; unsaved changes go to recovery. A storage or frozen refusal
      // (readOnly) discards the unsaved changes and their drafts instead, and
      // the view drops to view mode (onReadOnly). Only this client sees a
      // (re)connect refused read-only (`refusedConnect`): it reports what it
      // discards; the service records the refusals it sends itself.
      const replace = (
        reason: 'paused' | 'readOnly' | 'replaced' = 'replaced',
        refusedConnect = false
      ) => {
        if (reason === 'readOnly') {
          if (refusedConnect && (recorder?.unsaved || bufferDirtyRef.current))
            report('discard_unsaved', 'read_only', recorder?.unsavedBytes);
          // Discarded, not saved: the status never reads Saved.
          cancelled = true;
          active.acknowledged = active.sequence;
          pendingInput(false);
          setDirty(false);
          setError(null);
          void recorder?.discard();
          setBanner(null);
          shown = false;
          setLoaded(null);
          setHandoff(false);
          setReadOnly(true);
          readOnlyHandler.current?.();
        } else if (
          sourceChangesCovered(active, active.handedOff) &&
          !bufferDirtyRef.current
        ) {
          cancelled = true;
          active.acknowledged = active.sequence;
          markSaved();
          setHandoff(false);
          setPaused(reason === 'paused');
          setReplaced(true);
        } else {
          // The file moved on while edits waited: they open read-only, and
          // this session's rows stay until Reload discards them, with the
          // whole document a later open draws them over.
          active.recovery = true;
          void recorder?.snapshot();
          report(
            'other_epoch_draft',
            reason === 'paused' ? 'paused' : 'epoch_changed',
            recorder?.unsavedBytes
          );
          // Reported: a later open shows this lineage's rows (adopted ones
          // included) without a `reopen`. Read after the snapshot.
          const same = sameSourceLineage(session.format);
          void bestEffort(async () =>
            markDraftsReported(
              draftKey,
              (await readDrafts(draftKey))
                .filter((row) => same(row.lineage, lineage))
                .map((row) => row.id)
            )
          );
          void show();
          setStatus('recovery');
          setBanner('changed');
          setSynced(false);
        }
        provider?.disconnect();
      };
      // An explicit save (flush) persists at once; the idle request is
      // acknowledged by the room's next debounced store.
      // Only once synced (sendCheckpointRequest says why); an edit made
      // before then is covered by the request the sync sends.
      const checkpoint = (flush = false) => {
        if (!provider || active.recovery) return;
        const room = provider;
        const id = crypto.randomUUID();
        if (
          !sendCheckpointRequest(
            {
              send: (payload) => room.sendStateless(payload),
              synced: active.synced,
            },
            { flush, id }
          )
        )
          return;
        clearTimeout(timer);
        pending.set(id, active.sequence);
        delay.requested(id);
      };
      active.checkpoint = checkpoint;
      provider = createSourceProvider({
        // A publication's first refusal never gets here (sourceProvider.ts).
        // While its never-accepted steps are held, a JOIN waits for the
        // draft send to take them (Q327), and a reconnect sends at once
        // (Q328, Q360).
        beforeJoin: () => {
          if (!heldSteps) return;
          sender?.now();
          return sender?.settled;
        },
        document: shared,
        name: session.room,
        onAuthenticationFailed: ({ reason }) => {
          if (cancelled || active.recovery) return;
          // Paused before this client saw the room's paused message.
          if (maintenancePaused(reason)) {
            replace('paused');
            return;
          }
          if (reason === SOURCE_PUBLISHING_REASON) {
            fail(new SourceSessionError(m.source_edit_publishing()));
            return;
          }
          const failedToken = tokenError;
          const refusal = roomRefusal(reason, failedToken);
          tokenError = null;
          if (refusal === 'readOnly') replace('readOnly', true);
          // Source rooms are never collected in place, so never late.
          else if (refusal === 'retry' || refusal === 'late')
            reconnect.refused();
          // The room holds this document's client id for no one: not retried.
          else if (refusal === 'unassigned') refuse();
          else if (refusal === 'outdated') stale();
          else if (!cancelled) {
            cancelled = true;
            provider?.disconnect();
            // An account lock keeps them (refusalDropsDrafts). Queued before
            // the recorder's discard, the report counts this session's rows.
            if (refusalDropsDrafts(refusal, failedToken)) {
              void bestEffort(() =>
                dropLostDrafts(
                  draftKey,
                  refusal === 'notFound' ? 'not_found' : 'forbidden',
                  report
                )
              );
              void recorder?.discard();
            }
            setUnavailable(refusal);
          }
        },
        onClose: () => {
          active.synced = false;
          if (!cancelled) setSlowed(false);
          reconnect.closed(socketOpen(provider));
        },
        onDisconnect: () => {
          active.synced = false;
          delay.disconnected();
          active.disconnects++;
          active.handedOff = -1;
          reconnect.disconnected();
          if (!cancelled) setHandoff(false);
          if (!cancelled && !active.recovery) {
            setSynced(false);
            if (!navigator.onLine) {
              if (everSynced) goOffline();
              else setStatus('offline');
            } else if (!offlineMode)
              setStatus(everSynced ? 'reconnecting' : 'connecting');
          }
        },
        onPresence: (connections) => {
          if (cancelled) return;
          reportPresence.current?.(connections);
          cursors.names(connections);
        },
        // Joined, the answer waiting on the open budget: reachable, so never
        // offline meanwhile (an offline episode before it ends here).
        onSlowed: (slowed) => {
          if (cancelled || active.recovery) return;
          if (!slowed) {
            setSlowed(false);
            return;
          }
          reconnect.slowed();
          setSlowed(true);
          if (!offlineMode) return;
          offlineMode = false;
          recorder?.connected();
          setBanner((current) => (isRecoveryBanner(current) ? current : null));
          setStatus(everSynced ? 'reconnecting' : 'connecting');
        },
        onStateless: ({ payload }) => {
          let event: {
            type?: string;
            fileId?: string;
            epoch?: number;
            newEpoch?: number;
            id?: string;
            checkpoint?: number;
            checkpointIds?: string[];
            message?: string;
            recoverable?: boolean;
            lostAccess?: 'forbidden' | 'not_found';
            room?: string;
            workspaceId?: string;
          };
          try {
            event = JSON.parse(payload);
          } catch {
            return;
          }
          if (cancelled) return;
          // The collaboration server names the room, not the file.
          if (event.type === 'room-read-only') {
            if (event.room === session.room) replace('readOnly');
            return;
          }
          if (event.fileId !== fileId) return;
          // A Move, right before the room drains (Q454): the close that
          // follows reconnects as any drain does.
          if (event.type === 'file-moved') {
            if (event.workspaceId) fileMoved(qc, fileId, event.workspaceId);
            return;
          }
          if (event.type === 'source-handoff-cancel') {
            active.handedOff = -1;
            setHandoff(false);
            return;
          }
          if (
            event.type === 'source-handoff-prepare' &&
            event.epoch === session.epoch &&
            event.id
          ) {
            setHandoff(true);
            const handoffEvent = event;
            // Ready once the server holds every update: pending input is in
            // the document and the provider has nothing unsent. No save wait.
            const prepare = async () => {
              const disconnects = active.disconnects;
              try {
                await flushHandler.current?.(true);
                if (provider?.hasUnsyncedChanges)
                  await new Promise<void>((resolve) =>
                    unsyncedWaiters.push(resolve)
                  );
                if (
                  cancelled ||
                  active.recovery ||
                  bufferDirtyRef.current ||
                  disconnects !== active.disconnects
                )
                  return;
                active.handedOff = active.sequence;
                provider?.sendStateless(
                  JSON.stringify({
                    checkpoint: handoffEvent.checkpoint,
                    clean: true,
                    epoch: session.epoch,
                    id: handoffEvent.id,
                    type: 'source-handoff-ready',
                  })
                );
              } catch (error) {
                fail(error);
              }
            };
            void prepare();
            return;
          }
          if (event.type === 'source-epoch-changed') {
            replace();
            return;
          }
          if (event.type === 'source-editing-paused') {
            replace('paused');
            return;
          }
          if (
            event.type === 'source-checkpoint-failed' &&
            event.epoch === session.epoch
          ) {
            if (event.recoverable === false) {
              if (event.lostAccess) reset(event.lostAccess);
              else refuse();
              return;
            }
            // A slow failure: the server retries this save with backoff and
            // its receipt answers the same checkpoint ids, so they stay
            // pending and the drafts stay.
            setStatus('unsaved');
            rejectWaiters(new SourceSessionError(m.editor_save_delayed()));
            if (!sourceChangesCovered(active))
              setBanner((current) => current ?? 'delayed');
            return;
          }
          if (
            event.type !== 'checkpoint-persisted' ||
            event.epoch !== session.epoch ||
            !Array.isArray(event.checkpointIds)
          )
            return;
          const before = active.acknowledged;
          if (acknowledgeSourceCheckpoint(active, event.checkpointIds))
            markSaved();
          // Saving works again: the banner goes, and comes back only if the
          // oldest request still unanswered crosses the threshold.
          else if (active.acknowledged > before) {
            setBanner((current) => (current === 'delayed' ? null : current));
            unconfirmedReported = false;
          }
          delay.retain(pending.keys());
          flushWaiters.current = flushWaiters.current.filter((waiter) => {
            if (waiter.sequence <= active.acknowledged) {
              waiter.resolve();
              return false;
            }
            return true;
          });
        },
        onSynced: ({ state }) => {
          if (state && !cancelled && !active.recovery) {
            active.synced = true;
            setSlowed(false);
            if (joined || viewReadyRef.current !== false) join();
            delay.connected();
            if (offlineMode || heldEpisode) {
              offlineMode = false;
              heldEpisode = false;
              recorder?.connected();
              setBanner((current) =>
                isRecoveryBanner(current) ? current : null
              );
            }
            // Connecting ends at the first sync: Saved, or Saving while local
            // edits (restored drafts are edit 1) wait for the room's receipt.
            setStatus(everSynced || active.sequence > 0 ? 'saving' : 'saved');
            if (!everSynced) officeMark('synced');
            everSynced = true;
            void show();
            setWorkerClientId(provider?.workerClientId);
            setSynced(true);
            checkpoint(true);
            // A first sync after DRAFT_SEND_WAIT_MS still takes the held
            // steps (Q360).
            queueMicrotask(() => hold());
          }
        },
        onUnsyncedChanges: ({ number }) => {
          if (!number)
            for (const resolve of unsyncedWaiters.splice(0)) resolve();
        },
        token: async (previousToken) => {
          let token: SourceCollaborationToken;
          try {
            token =
              initialToken ??
              (await api.post<SourceCollaborationToken>(
                `/files/${fileId}/collaboration-token`,
                previousToken ? { previousToken } : {}
              ));
          } catch (error) {
            tokenError = error;
            // A reconnect during the maintenance pause.
            if (!cancelled && maintenancePaused(error)) replace('paused');
            throw error;
          }
          if (cancelled)
            throw new SourceSessionError(m.source_edit_session_changed());
          initialToken = null;
          sawRoom(token.room);
          if (token.epoch !== session.epoch || token.room !== session.room) {
            replace();
            throw new SourceSessionError(m.source_edit_session_changed());
          }
          // A reconnect after the account froze gets a read token.
          if (token.access === 'read') {
            replace('readOnly', true);
            throw new Error(COLLABORATION_READ_ONLY_REASON);
          }
          lastToken = token.token;
          return token.token;
        },
        // Stored drafts not yet covered by a receipt (Q236).
        unsent: () => !!recorder?.unsaved,
        url: credentials.url,
      });
      officeMark('provider');
      active.provider = provider;
      runtime.current = active;
      cursors.attach(provider.awareness);
      // A base that cannot be read ends the session as its read did before.
      const baseRead = async () => {
        try {
          await base;
        } catch (value) {
          if (controller.signal.aborted) return;
          fail(value);
          cancelled = true;
          provider?.disconnect();
        }
      };
      void baseRead();
      // Unsaved work is written as it happens (each local update, the whole
      // state once per offline episode and at unmount) and deleted by the
      // receipts that cover it. Storage that fails never blocks editing;
      // offline, the banner says the device holds nothing.
      recorder = recordDrafts({
        adopted: apply,
        base: { bytes: base, sha: session.baseSourceSHA256 },
        doc: shared,
        ignore: (origin) => origin === provider || origin === RESTORE_ORIGIN,
        key: draftKey,
        limitBytes: SOURCE_STATE_MAX_BYTES,
        limitsState: true,
        lineage,
        onLimit: (over) => {
          overLimit = over;
          if (!cancelled) setOfflineLimit(over);
          showOffline();
        },
        onLost: toastDraftsLost,
        onStorage: (ok) => {
          storageOk = ok;
          showOffline();
        },
        report,
        token: () => lastToken,
      });
      // The draft send runs while the room joins (Q319, Q328); not settled
      // in time with the room synced, the session takes the steps itself
      // and edits on, nothing live until the send settles (Q327).
      if (pendingDrafts.length) {
        const current = draftSender(draftKey, () =>
          api.post<SourceCollaborationToken>(
            `/files/${fileId}/collaboration-token`,
            {}
          )
        );
        sender = current;
        setDraftsSending(true);
        let waitOver = false;
        hold = () => {
          if (!(waitOver && everSynced) || current.done || heldSteps) return;
          if (cancelled || sender !== current || active.recovery) return;
          heldSteps = true;
          heldEpisode = true;
          provider?.disconnect();
          recorder?.disconnected(true);
          applyDrafts(shared, pendingDrafts, RESTORE_ORIGIN);
          recorder?.adopt(pendingDrafts);
          setDirty(true);
          setDraftsSending(false);
          setDraftsHeld(true);
          provider?.connect();
        };
        holdTimer = setTimeout(() => {
          waitOver = true;
          hold();
        }, DRAFT_SEND_WAIT_MS);
        void current.settled.then(() => {
          clearTimeout(holdTimer);
          if (cancelled || sender !== current) return;
          const held = heldSteps;
          sender = null;
          heldSteps = false;
          setDraftsSending(false);
          setDraftsHeld(false);
          // A group the room did not take, its steps not applied here: the
          // reopen shows it copy-only (Q360). Held ones the JOIN's refusal
          // takes.
          if (current.kept && !held) setGeneration((value) => value + 1);
        });
      }
      shared.on('update', (_update: Uint8Array, origin: unknown) => {
        if (origin === provider || origin === RESTORE_ORIGIN || discarded)
          return;
        if (refusedBuild) {
          if (!storageOk) setDirty(true);
          return;
        }
        setDirty(true);
        setStatus(
          active.recovery ? 'recovery' : offlineMode ? 'offline' : 'saving'
        );
        clearTimeout(timer);
        timer = setTimeout(() => checkpoint(), 1000);
      });
    })().catch((value) => {
      // An open that ended before its room: no join to watch.
      if (!provider) reconnect.dispose();
      fail(value);
    });
    return () => {
      cancelled = true;
      disposed = true;
      sender?.stop();
      clearTimeout(holdTimer);
      controller.abort();
      clearTimeout(timer);
      delay.dispose();
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
      void recorder?.dispose();
      runtime.current = null;
      discardHandler.current = null;
      reconnect.dispose();
      cursors.attach(null);
      cursors.names(null);
      provider?.destroy();
      reportPresence.current?.(null);
      doc?.destroy();
      for (const waiter of flushWaiters.current.splice(0))
        waiter.reject(new SourceSessionError(m.source_edit_save_failed()));
    };
  }, [fileId, actorId, enabled, generation, pendingInput, cursors]);

  useEffect(() => {
    if (!dirty && !bufferDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, bufferDirty]);

  return {
    ...loaded,
    atSizeLimit,
    banner,
    cursors,
    dirty: dirty || bufferDirty,
    discardDraft,
    discarding,
    draftsSending,
    error,
    flushHandler,
    handoff,
    offlineLimit,
    outdated,
    paused,
    pendingInput,
    readOnly,
    replaced,
    save,
    slowed,
    status:
      status === 'saved' && (bufferDirty || draftsSending || draftsHeld)
        ? ('saving' as const)
        : status,
    synced,
    unavailable,
    workerClientId,
  };
}
