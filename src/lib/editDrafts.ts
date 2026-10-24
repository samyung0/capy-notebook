import * as Y from 'yjs';
import { USE_MSW } from '@/api/auth';
import { isAccountForbiddenError, isApiError } from '@/api/client';
import type { MaterialCollaborationToken } from '@/api/types';
import { tabAllowance } from '@/features/collaboration/allowance';
import { setHeld } from '@/features/collaboration/held';
import { MAX_UPDATE_BYTES } from '@/features/collaboration/pieces';
import {
  CLIENT_PROTOCOL,
  tokenClientIds,
} from '@/features/collaboration/protocol';
import { markUpdateAvailable } from '@/lib/appRelease';
import {
  type EditIncidentReporter,
  editIncidentReporter,
  reportOnce,
  storageFailureReason,
} from '@/lib/editIncidents';
import {
  type DraftInfo,
  type DraftMessage,
  type DraftRef,
  type DraftReply,
  type DraftRequest,
  grantsOf,
  MERGE_RUN,
  mergedRows,
  type StorageError,
} from './draftStore';

/**
 * Unsaved collaborative edits kept on this device (notes, Office and text
 * sources), so they outlive a lost connection, a reload or a closed tab. A row
 * is one session's (one editor mount's) full Yjs state, one of its local
 * updates, or a merged run of them. Rows are deleted only once a receipt
 * covers them (an editor's checkpoint receipt, or the answer to a sweep's
 * send from a page with no editor open on the document): the room's sync
 * alone is not durable.
 *
 * `lineage` names the room state the edits grew from: the room name (a note's
 * `material:<id>:schema:<n>`, a source's `source:<id>:epoch:<n>@<baseSHA>`).
 * Rows of another lineage, or refused ones, are never merged into a live
 * document; they open read-only for copying.
 */
export interface EditDraft {
  /** The room accepted a write of its session: a receipt covered one of the
   * session's own edits, so the room recorded its client id, and an opening
   * editor applies the row and syncs it over its live channel (Q326). */
  accepted?: true;
  /** A source's base (`bases` store), which recovery opens the edits over. */
  base?: string;
  data: Uint8Array;
  /** The signed room tokens of the sessions whose edits it holds, each the
   * session's last when the row was written (Q288): a send from any page
   * presents them, and the room grants their client ids again under the
   * reconnect rule. */
  grants?: string[];
  /** A sweep left it for the editor's next open: the service could not take
   * it (it needs the room's state, a piece is over the service's cap, or it
   * is of another lineage or Office base), so no sweep sends it again. */
  held?: true;
  /** `${session}:state`, or `${session}:${seq}` for an update (or a run
   * ending at `seq`). */
  id: string;
  /** `${actorId}:material:${id}` or `${actorId}:file:${id}`. */
  key: string;
  kind: 'state' | 'update';
  lineage: string;
  /** A save refused for good: shown for copying, never merged back. */
  refused?: true;
  /** Its group entered recovery and was reported (edit_incidents): a later
   * open shows it without reporting it again. */
  reported?: true;
  savedAt: number;
  /** The session's local edit count this row covers. */
  seq: number;
  session: string;
}

type DocOptions = ConstructorParameters<typeof Y.Doc>[0];

export function draftKey(
  actorId: string,
  kind: 'material' | 'file',
  id: string
) {
  return `${actorId}:${kind}:${id}`;
}

/** A source session's draft lineage: its room (the epoch) and base. Text
 * drafts stay compatible across the base hashes of one epoch (a text
 * publication keeps the epoch); Office ones need the same base. */
export function sourceLineage(session: {
  baseSourceSHA256: string;
  room: string;
}) {
  return `${session.room}@${session.baseSourceSHA256}`;
}
export function sameSourceLineage(format: string) {
  return (left: string, right: string) =>
    format === 'text'
      ? left.split('@')[0] === right.split('@')[0]
      : left === right;
}

// Only explicit MSW scenario fixtures use storage: MSW resets its database on
// reload, so any other stored edit belongs to a room that no longer exists.
function stored(key: string) {
  return !USE_MSW || key.split(':').at(-1)?.startsWith('mock-scenario-');
}

const DATABASE = USE_MSW
  ? 'capy-edit-drafts-msw-scenarios'
  : 'capy-edit-drafts';
// The database before notes kept drafts: copied over once, then deleted.
const SOURCE_DATABASE = USE_MSW
  ? 'capy-source-drafts-msw-scenarios'
  : 'capy-source-drafts';

// The drafts worker (draftStore.ts) runs every storage request in the order
// posted: answers resolve `waiting`, a failed append goes to its session.
let worker: Worker | null = null;
// A worker that never answered failed to start (a broken deploy, a blocked
// script): every request fails for this page load rather than restarting it.
let workerFailed: Error | null = null;
let nextRequest = 0;
const waiting = new Map<
  number,
  { reject: (error: Error) => void; resolve: (value: unknown) => void }
>();
const appendFailures = new Map<string, (error: Error) => void>();

function storageError({ message, name }: StorageError) {
  return new DOMException(message, name);
}

function draftWorker(): Worker {
  if (workerFailed) throw workerFailed;
  if (worker) return worker;
  const started = new Worker(
    new URL('./draftStore.worker.ts', import.meta.url),
    { name: 'drafts', type: 'module' }
  );
  let answered = false;
  started.onmessage = ({ data }: MessageEvent<DraftReply>) => {
    answered = true;
    if ('failed' in data) {
      appendFailures.get(data.failed)?.(storageError(data.error));
      return;
    }
    const waiter = waiting.get(data.id);
    waiting.delete(data.id);
    if (data.error) waiter?.reject(storageError(data.error));
    else waiter?.resolve(data.result);
  };
  // An exception in the worker: what it had not answered is lost, so every
  // waiting request fails and every session hears its appends may be gone
  // (they write the whole document again). One that had run is replaced by
  // the next request; transactions are atomic, so its store is consistent.
  started.onerror = (event) => {
    event.preventDefault();
    const error = new Error('The drafts worker failed');
    started.terminate();
    if (worker === started) worker = null;
    if (!answered) workerFailed = error;
    for (const waiter of waiting.values()) waiter.reject(error);
    waiting.clear();
    for (const failed of appendFailures.values()) failed(error);
  };
  worker = started;
  return started;
}

function post(request: DraftRequest, id?: number) {
  draftWorker().postMessage({
    ...request,
    database: DATABASE,
    id,
    sourceDatabase: SOURCE_DATABASE,
  } satisfies DraftMessage);
}

function call<T = void>(request: DraftRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = ++nextRequest;
    waiting.set(id, { reject, resolve: resolve as (value: unknown) => void });
    try {
      post(request, id);
    } catch (error) {
      waiting.delete(id);
      reject(error);
    }
  });
}

export function readDrafts(key: string): Promise<EditDraft[]> {
  if (!stored(key)) return Promise.resolve([]);
  return call<EditDraft[]>({ key, op: 'read' });
}

/** A source base stored beside its drafts. */
export function readDraftBase(key: string, base: string) {
  return call<Uint8Array | undefined>({ base, key, op: 'readBase' });
}

/**
 * Opens a source recovery group: its base and the document its rows draw, or
 * settles the group:
 * - a group nothing can draw (a base this device does not hold, a row naming
 *   none, update rows without the whole state they grew from) is deleted and
 *   reported `base_missing` (`dropped`);
 * - a base that failed to read: the group is kept for the next open, since
 *   dropping it would lose edits still stored, and the failure is reported
 *   as `draft_storage_failed`, once per page load (`kept`).
 * A group kept for good this way sorts ahead of later groups of the file,
 * which then wait behind it (draftGroups shows one group per open). The
 * document takes the session's own `docOptions` (sourceDocOptions).
 */
export async function openRecoveryGroup(
  group: EditDraft[],
  report: EditIncidentReporter,
  docOptions: DocOptions
): Promise<{ base: Uint8Array; doc: Y.Doc } | 'dropped' | 'kept'> {
  const [first] = group;
  if (!first) return 'dropped';
  if (first.base !== undefined) {
    let base: Uint8Array | undefined;
    try {
      base = await readDraftBase(first.key, first.base);
    } catch (error) {
      console.warn('Draft storage failed:', error);
      reportOnce(first.id, () =>
        report(
          'draft_storage_failed',
          storageFailureReason(error),
          draftBytes(group)
        )
      );
      return 'kept';
    }
    const doc = base && recoveryDocument(group, docOptions);
    if (base && doc) return { base, doc };
  }
  await deleteDrafts(group).catch((error) =>
    console.warn('Draft storage failed:', error)
  );
  reportOnce(first.id, () =>
    report('draft_unrestorable', 'base_missing', draftBytes(group))
  );
  return 'dropped';
}

/** Write rows, and their source base when it is not stored yet. */
export function putDrafts(rows: EditDraft[], base?: Uint8Array): Promise<void> {
  const kept = rows.filter((row) => stored(row.key));
  if (!kept.length) return Promise.resolve();
  return call({ base, op: 'put', rows: kept });
}

/** Delete exactly these rows: a row rewritten since (a higher `seq` under the
 * same id, another tab's newer state) stays. */
export function deleteDrafts(rows: DraftRef[]): Promise<void> {
  const kept = rows
    .filter((row) => stored(row.key))
    .map(({ id, key, seq }) => ({ id, key, seq }));
  if (!kept.length) return Promise.resolve();
  return call({ op: 'delete', rows: kept });
}

/** Every row of a document, all sessions: its user lost access or it is
 * gone. Resolves to the bytes the deleted rows `counted` held (all of them by
 * default). */
export async function deleteDocumentDrafts(
  key: string,
  counted: (row: DraftInfo) => boolean = () => true
): Promise<number> {
  if (!stored(key)) return 0;
  const deleted = await call<DraftInfo[]>({ key, op: 'deleteDocument' });
  return deleted.reduce((sum, row) => sum + (counted(row) ? row.bytes : 0), 0);
}

/** Deletes the stored edits of a document this account lost (a 404, or a 403
 * not about the account itself) and reports them as discarded, when there
 * were any (edit_incidents). Queued before a live recorder's own discard, it
 * counts that session's rows too. */
export async function dropLostDrafts(
  key: string,
  reason: 'forbidden' | 'not_found',
  report: EditIncidentReporter,
  /** Rows to count; the rest are deleted unreported (another report has
   * them). */
  counted?: (row: DraftInfo) => boolean
) {
  const bytes = await deleteDocumentDrafts(key, counted);
  if (bytes) report('discard_unsaved', reason, bytes);
}

function markDrafts(
  key: string,
  ids: string[],
  flag: 'accepted' | 'held' | 'refused' | 'reported'
): Promise<void> {
  if (!(stored(key) && ids.length)) return Promise.resolve();
  return call({ flag, ids, key, op: 'mark' });
}

/** Marks these rows of a document reported (edit_incidents). */
export function markDraftsReported(key: string, ids: string[]): Promise<void> {
  return markDrafts(key, ids, 'reported');
}

/**
 * Split a document's rows against the room it opens: `current` merges into
 * the live document; `recovery` is one group (refused rows, or one other
 * lineage) to show read-only first. Further groups wait for the next open.
 * `same` compares lineages (text sources ignore the base).
 */
export function draftGroups(
  rows: EditDraft[],
  lineage: string,
  same: (left: string, right: string) => boolean = (left, right) =>
    left === right
) {
  const first = rows.find((row) => row.refused || !same(row.lineage, lineage));
  return {
    current: rows.filter((row) => !row.refused && same(row.lineage, lineage)),
    recovery: first
      ? rows.filter(
          (row) =>
            same(row.lineage, first.lineage) &&
            !!row.refused === !!first.refused
        )
      : [],
  };
}

/** The bytes a group of rows holds (edit_incidents sizes). */
export function draftBytes(rows: readonly EditDraft[]) {
  return rows.reduce((sum, row) => sum + row.data.byteLength, 0);
}

/**
 * Reports a recovery group of another lineage entering recovery, once: its
 * rows are marked `reported`, so an open in a later page load shows it
 * without reporting it again (Reload deletes them, mark and all). A group
 * with an unmarked row is a new episode (a marked row the epoch kept, then
 * newer edits) and is reported. A refused group was recorded when the
 * service refused it.
 */
export function reportRecoveryGroup(
  group: EditDraft[],
  report: EditIncidentReporter
) {
  const [first] = group;
  if (!first || first.refused || group.every((row) => row.reported)) return;
  reportOnce(first.id, () => {
    report('other_epoch_draft', 'reopen', draftBytes(group));
    void markDraftsReported(
      first.key,
      group.map((row) => row.id)
    ).catch((error) => console.warn('Draft storage failed:', error));
  });
}

/** Apply rows into a document as one update (states first). Updates whose
 * base the document lacks stay pending until the room's sync brings it. */
export function applyDrafts(doc: Y.Doc, rows: EditDraft[], origin: unknown) {
  if (!rows.length) return;
  Y.applyUpdate(doc, mergedRows(rows), origin);
}

/** A recovery group as one document, or null when it cannot be drawn: update
 * rows whose base was never stored (a tab closed online, then the room moved). */
export function recoveryDocument(
  rows: EditDraft[],
  docOptions?: DocOptions
): Y.Doc | null {
  const doc = new Y.Doc(docOptions);
  applyDrafts(doc, rows, null);
  if (doc.store.pendingStructs || doc.store.pendingDs) {
    doc.destroy();
    return null;
  }
  return doc;
}

// The whole-state retry's floor while storage keeps failing (2026-10-07).
const RETRY_MS = 5000;

// Web Locks: a document an editor records (shared: several tabs may edit it),
// and the one sweep that runs at a time in this browser.
const documentLock = (key: string) => `capy-drafts:${key}`;
const SWEEP_LOCK = 'capy-drafts-sweep';

function webLocks(): LockManager | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.locks;
}

/** Holds a document's lock until the returned release (an editor's
 * session): a sweep skips the documents an editor holds. */
function holdDocument(key: string): () => void {
  const locks = webLocks();
  if (!locks) return () => undefined;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  void locks
    .request(documentLock(key), { mode: 'shared' }, () => held)
    .catch(() => undefined);
  return release;
}

let persistenceRequested = false;
/** Ask once per page load for storage the browser will not evict under
 * pressure, where asking is silent: Firefox shows a permission prompt, so it
 * is skipped there. Safari still deletes script storage after 7 days without
 * a visit, and private windows delete it on close. */
function requestPersistence() {
  if (persistenceRequested) return;
  persistenceRequested = true;
  if (navigator.userAgent.includes('Firefox')) return;
  void navigator.storage?.persist?.().catch(() => undefined);
}

export interface DraftRecorderOptions {
  /** Rows of earlier sessions applied into `doc`: they count as edit 1. */
  adopted?: EditDraft[];
  /** A source's base, stored once beside its rows; its bytes may still be
   * downloading (the room opens meanwhile), and a whole-document write then
   * waits for them. */
  base?: { sha: string; bytes: Uint8Array | Promise<Uint8Array> };
  doc: Y.Doc;
  /** Updates not to record: the room's own and restores. */
  ignore: (origin: unknown) => boolean;
  key: string;
  /** Unsaved bytes this device holds before `onLimit(true)`, while
   * disconnected: the host then stops taking edits (nothing is dropped). */
  limitBytes: number;
  /** The bound counts the whole state the edits make (a source's state cap)
   * rather than this session's unsaved updates (a note). */
  limitsState?: boolean;
  lineage: string;
  onLimit?: (over: boolean) => void;
  /** Whether the last write reached storage (false: private mode, a full
   * disk). Editing goes on either way. */
  onStorage?: (ok: boolean) => void;
  /** Reports a failing draft store and each offline episode, after the
   * reconnect (edit_incidents). */
  report?: EditIncidentReporter;
  /** The session's last signed room token, which its rows keep (Q288). */
  token?: () => string | undefined;
}

/**
 * Records a session's unsaved work as it happens: each local update is one
 * row, posted to the drafts worker as it arrives, and the whole document is
 * one `state` row written once per offline episode, at unmount and
 * `pagehide`, and after a failed write: the base later updates need when they
 * open in recovery. The host reports the connection (`disconnected` once it
 * treats the room as unreachable, `connected` on sync) and each receipt
 * (`covered` with the highest local edit count it acknowledges, read from
 * `sequence` when the checkpoint was requested).
 */
export function recordDrafts({
  adopted = [],
  base,
  doc,
  ignore,
  key,
  limitBytes,
  limitsState = false,
  lineage,
  onLimit,
  onStorage,
  report,
  token,
}: DraftRecorderOptions) {
  const session = crypto.randomUUID();
  const keep = stored(key);
  const start = adopted.length ? 1 : 0;
  let sequence = start;
  let covered = 0;
  let pendingAdopted = adopted;
  // This session's update rows no receipt covered yet, and their bytes.
  let updates: { seq: number; bytes: number }[] = [];
  // Update rows written since the last merge of a run of them.
  let unmerged: number[] = [];
  let updateBytes = 0;
  // The last whole state written, and the bytes of the update rows written
  // after it that no receipt covered.
  let state: { seq: number; bytes: number } | null = null;
  let sinceState = 0;
  // While storage fails, the whole document is retried at most every
  // RETRY_MS (human/frontend/error-handling.md, 2026-10-07).
  let retry: ReturnType<typeof setTimeout> | undefined;
  let lastWhole = Number.NEGATIVE_INFINITY;
  let offline = false;
  // A receipt covered one of this session's own edits (Q326).
  let accepted = false;
  // How the current offline episode started (its incident reason).
  let offlineReason: 'browser_offline' | 'unreachable' = 'unreachable';
  // A storage failure while offline, reported once the room is back.
  let heldStorageReport: (() => void) | null = null;
  let snapshotDue = false;
  // A write failed: storage may lack anything since, so the next write holds
  // the whole state, and storage reads as working only once that lands.
  let gap = false;
  let over = false;
  let stopped = false;
  let storageOk = true;
  // While this session records, a sweep leaves the document alone.
  const release = keep ? holdDocument(key) : () => undefined;

  const row = (
    kind: EditDraft['kind'],
    seq: number,
    data: Uint8Array,
    refused?: true
  ): EditDraft => ({
    ...grantsOf(token?.()),
    ...(accepted && { accepted }),
    data,
    id: kind === 'state' ? `${session}:state` : `${session}:${seq}`,
    key,
    kind,
    lineage,
    savedAt: Date.now(),
    seq,
    session,
    ...(base && { base: base.sha }),
    ...(refused && { refused }),
  });
  // Rows go out in order once the base is in; until then a write waits for
  // it. A base that failed to download is not stored: the rows still are.
  let baseReady = base?.bytes instanceof Promise ? undefined : base?.bytes;
  const basePending =
    base?.bytes instanceof Promise
      ? base.bytes.then(
          (bytes) => {
            baseReady = bytes;
          },
          () => {}
        )
      : null;
  const putWithBase = (rows: EditDraft[]) =>
    baseReady || !basePending
      ? putDrafts(rows, baseReady)
      : basePending.then(() => putDrafts(rows, baseReady));
  // What the offline bound counts.
  const boundBytes = () =>
    limitsState ? (state?.bytes ?? 0) + sinceState : updateBytes;
  // What the device holds unsaved for this document (edit_incidents sizes):
  // this session's updates no receipt covered, and the adopted rows.
  const heldBytes = () => updateBytes + draftBytes(pendingAdopted);
  const unsavedWork = () => sequence > Math.max(covered, start);
  const checkLimit = () => {
    if (offline && !over && boundBytes() > limitBytes) {
      over = true;
      onLimit?.(true);
    }
  };
  const failed = (error: unknown) => {
    console.warn('Draft storage failed:', error);
    gap = true;
    retryWhole();
    if (!storageOk) return;
    storageOk = false;
    onStorage?.(false);
    const reason = storageFailureReason(error);
    const bytes = heldBytes();
    const send = () => report?.('draft_storage_failed', reason, bytes);
    if (offline) heldStorageReport = send;
    else send();
  };
  // Only a whole document that lands says storage works again: deletes go
  // through on a full disk too.
  const write = (work: Promise<unknown>, whole = false) =>
    work.then(() => {
      if (!whole) return;
      gap = false;
      if (storageOk) return;
      storageOk = true;
      onStorage?.(true);
    }, failed);
  if (keep) appendFailures.set(session, failed);

  const writeState = () => {
    const data = Y.encodeStateAsUpdate(doc);
    state = { bytes: data.length, seq: sequence };
    sinceState = 0;
    snapshotDue = false;
    lastWhole = Date.now();
    if (offline) requestPersistence();
    return write(putWithBase([row('state', sequence, data)]), true);
  };
  // A write failed: the whole document holds what it lost, tried at once and
  // then at most every RETRY_MS while storage keeps failing, and only while
  // something is unsaved (a saved document needs no row).
  function retryWhole() {
    if (retry || stopped) return;
    retry = setTimeout(
      () => {
        retry = undefined;
        if (gap && !stopped && !over && unsavedWork()) void writeState();
      },
      Math.max(0, lastWhole + RETRY_MS - Date.now())
    );
  }
  // The whole document now, when unsaved work outgrew the last one written
  // (past the offline bound nothing more is stored: the editor stopped).
  const snapshot = () =>
    !stopped && !over && unsavedWork() && state?.seq !== sequence
      ? writeState()
      : Promise.resolve();

  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (stopped || ignore(origin)) return;
    sequence++;
    // Past the offline bound the editor stopped taking edits; anything that
    // still arrives stays in memory and syncs on reconnect.
    if (over) return;
    updates.push({ bytes: update.length, seq: sequence });
    updateBytes += update.length;
    sinceState += update.length;
    if (keep)
      try {
        post({ op: 'append', row: row('update', sequence, update) });
        unmerged.push(sequence);
        if (unmerged.length === MERGE_RUN) {
          post({ op: 'merge', rows: unmerged.map(updateRow) });
          unmerged = [];
        }
      } catch (error) {
        failed(error);
      }
    if (snapshotDue) void writeState();
    else if (gap) retryWhole();
    checkLimit();
    if (offline) requestPersistence();
  };
  doc.on('update', onUpdate);
  const onPageHide = () => void snapshot();
  if (typeof window !== 'undefined')
    window.addEventListener('pagehide', onPageHide);

  const stop = () => {
    stopped = true;
    release();
    clearTimeout(retry);
    appendFailures.delete(session);
    doc.off('update', onUpdate);
    if (typeof window !== 'undefined')
      window.removeEventListener('pagehide', onPageHide);
  };
  const updateRow = (seq: number): DraftRef => ({
    id: `${session}:${seq}`,
    key,
    seq,
  });
  const stateRow = (seq: number): DraftRef => ({
    id: `${session}:state`,
    key,
    seq,
  });
  // Every row this session wrote or adopted, as written.
  const ownRows = () => [
    ...updates.map((item) => updateRow(item.seq)),
    ...(state ? [stateRow(state.seq)] : []),
    ...pendingAdopted,
  ];

  return {
    /** Rows an opening editor applied after it began recording (a draft
     * send that has not settled in time, Q327): they go with this
     * session's own rows, as rows adopted at its start do. */
    adopt(rows: EditDraft[]) {
      pendingAdopted = [...pendingAdopted, ...rows];
    },
    connected() {
      heldStorageReport?.();
      heldStorageReport = null;
      if (offline) report?.('offline_episode', offlineReason, heldBytes());
      offline = false;
      snapshotDue = false;
      if (over) {
        over = false;
        onLimit?.(false);
      }
    },
    /** A receipt acknowledged every edit up to `seq`: delete what it covers.
     * The state row stays while newer edits still need it as their base. */
    covered(seq: number) {
      if (seq <= covered) return Promise.resolve();
      covered = Math.min(seq, sequence);
      const done: DraftRef[] = [...pendingAdopted];
      pendingAdopted = [];
      updates = updates.filter((item) => {
        if (item.seq > covered) return true;
        updateBytes -= item.bytes;
        if (!state || item.seq > state.seq) sinceState -= item.bytes;
        done.push(updateRow(item.seq));
        return false;
      });
      if (sequence <= covered) {
        if (state) done.push(stateRow(state.seq));
        state = null;
        sinceState = 0;
        // Everything is saved: nothing a failed write lost is missing.
        gap = false;
        clearTimeout(retry);
        retry = undefined;
      }
      // The room took one of this session's own edits, so it recorded the
      // session's id: its rows apply over the live channel at a later open
      // (Q326). Adopted rows (edit 1) are other sessions'.
      if (!accepted && covered > start) {
        accepted = true;
        const kept = updates.map((item) => updateRow(item.seq).id);
        if (state) kept.push(stateRow(state.seq).id);
        return write(
          Promise.all([deleteDrafts(done), markDrafts(key, kept, 'accepted')])
        );
      }
      return write(deleteDrafts(done));
    },
    /** Unsaved work is discarded (the room turned read-only, or recovery was
     * left): delete what this session wrote or adopted, and stop. */
    discard() {
      const previous = ownRows();
      stop();
      return write(deleteDrafts(previous));
    },
    /** The room is unreachable: edits from now on are what this device alone
     * holds, so the whole document is written once and the bound applies. */
    disconnected() {
      offline = true;
      offlineReason =
        navigator.onLine === false ? 'browser_offline' : 'unreachable';
      snapshotDue = true;
      // The base the episode's update rows need, even past the bound.
      void snapshot();
      checkLimit();
    },
    /** Write the whole document when unsaved work remains (a remount into
     * recovery reads it), and stop. */
    dispose() {
      const done = snapshot();
      stop();
      return done;
    },
    /** A save refused for good: keep the whole document as one refused row
     * (shown for copying, never merged) and stop recording. Returns that
     * row, which a later delete (queued after the write) removes. */
    refuse(): DraftRef {
      const previous = ownRows();
      const data = Y.encodeStateAsUpdate(doc);
      stop();
      const refused = row('state', sequence, data, true);
      void write(Promise.all([deleteDrafts(previous), putWithBase([refused])]));
      return refused;
    },
    /** Local edits so far (1 for adopted rows): a checkpoint request
     * records it. */
    get sequence() {
      return sequence;
    },
    session,
    /** Write the whole document now if unsaved work outgrew the last one:
     * edits about to open in recovery. */
    snapshot,
    get unsaved() {
      return sequence > covered;
    },
    /** What this device holds unsaved for the document: this session's
     * update rows no receipt covered, and the rows it adopted. */
    get unsavedBytes() {
      return heldBytes();
    },
  };
}

export type DraftRecorder = ReturnType<typeof recordDrafts>;

/** Whether the server says this account no longer has the document: a 404,
 * or a 403 that is not about the account itself (suspended, deletion
 * pending), which keeps the drafts. */
function goneReason(error: unknown) {
  if (!isApiError(error)) return null;
  if (error.status === 404) return 'not_found';
  return error.status === 403 && !isAccountForbiddenError(error)
    ? 'forbidden'
    : null;
}

/** A document's room token, as its editor fetches it. */
type RoomToken = Pick<
  MaterialCollaborationToken,
  'access' | 'room' | 'token' | 'url'
>;

export interface SweepApi {
  post: (path: string, body: unknown) => Promise<unknown>;
}

/**
 * The document a stored key names: `${actor}:material:${id}` (a note, a
 * flashcard set, a quiz's content), `${actor}:material:${id}:keys` (a quiz's
 * keys, live-items) or `${actor}:file:${id}`.
 */
function documentOf(
  key: string
): { id: string; keys: boolean; kind: 'material' | 'file' } | null {
  const [, kind, id, part] = key.split(':');
  if ((kind !== 'material' && kind !== 'file') || !id) return null;
  if (part !== undefined && !(kind === 'material' && part === 'keys'))
    return null;
  return { id, keys: part === 'keys', kind };
}

function roomToken(
  api: SweepApi,
  kind: 'material' | 'file',
  id: string,
  keys: boolean
) {
  return api.post(
    `/${kind === 'material' ? 'materials' : 'files'}/${id}/collaboration-token`,
    keys ? { document: 'keys' } : {}
  ) as Promise<RoomToken>;
}

/**
 * What sending one group of rows came to:
 * - `sent`: a store holds it (the answer is the receipt for every row sent);
 * - `refused`: over a limit or not an update a writer may send;
 * - `waits`: only the editor can send it (a piece over the service's cap, a
 *   base the room lacks, another lineage or Office base), at the file's next
 *   open;
 * - `later`: the service answered something else (busy, failing, lost
 *   access): tried again at the next page load;
 * - `retry`: no answer (offline), the rows changed, or the user is in a
 *   timeout (`too_fast`, Epo 2026-10-18): tried at the next trigger;
 * - `outdated`: the service refuses this build's client protocol (Capy was
 *   updated): nothing more goes until the page reloads, and no row changes.
 */
type Sent = 'sent' | 'refused' | 'waits' | 'later' | 'retry' | 'outdated';

// Set once a send was refused as outdated: sweeps stop for the page load.
let outdated = false;

/** The most stored tokens one send presents (the service reads as many). */
const MAX_GRANTS = 16;

/** A group's stored tokens, newest first, one per client id they offer (a
 * session's refreshed tokens all offer its id, Q322 N4), at most
 * MAX_GRANTS. A token that offers none is left out. */
function groupGrants(group: DraftInfo[]) {
  const byId = new Map<number, string>();
  for (const row of [...group].sort((a, b) => b.savedAt - a.savedAt))
    for (const token of [...(row.grants ?? [])].reverse()) {
      let id: number;
      try {
        id = tokenClientIds(token).clientId;
      } catch {
        continue;
      }
      if (!byId.has(id)) byId.set(id, token);
    }
  return [...byId.values()].slice(0, MAX_GRANTS);
}

/** A document's rows its room takes now: not refused, not left for the
 * editor (`held`), of the token's room, one group per lineage (an Office
 * file's rows of another base go apart), with the newest of their stored
 * tokens. */
function sendableGroups(rows: DraftInfo[], room: string) {
  const groups = new Map<string, DraftInfo[]>();
  for (const row of rows) {
    if (row.refused || row.held || row.lineage.split('@')[0] !== room) continue;
    groups.set(row.lineage, [...(groups.get(row.lineage) ?? []), row]);
  }
  return [...groups.values()].map((group) => ({
    base: group[0].base,
    grants: groupGrants(group),
    refs: group.map(({ id, key, seq }) => ({ id, key, seq })),
  }));
}

/** POST one group to the collaboration service's `/drafts` (its WebSocket
 * URL's host) with the editor's token, merged in the drafts worker and sent
 * as its pieces of at most 2 MiB, in order, each paced under the user's
 * update allowance (Epo 2026-10-18). A piece the service does not take stops
 * the send; the pieces before it are in the room, so the group's rows become
 * one row of the pieces not sent (Epo 2026-10-18), which `refs` names. */
async function sendGroup(
  token: RoomToken,
  group: { base?: string; grants: string[]; refs: DraftRef[] }
): Promise<{ refs: DraftRef[]; sent: Sent }> {
  let pieces: Uint8Array<ArrayBuffer>[] | null;
  try {
    pieces = await call<Uint8Array<ArrayBuffer>[] | null>({
      op: 'merged',
      rows: group.refs,
    });
  } catch (error) {
    console.warn('Drafts cannot be merged:', error);
    return { refs: group.refs, sent: 'waits' };
  }
  if (!pieces) return { refs: group.refs, sent: 'retry' };
  for (const [index, piece] of pieces.entries()) {
    const sent = await sendPiece(token, group, piece);
    if (sent === 'sent') continue;
    if (index === 0) return { refs: group.refs, sent };
    const kept = await call<DraftRef | null>({
      from: index,
      op: 'unsent',
      rows: group.refs,
    });
    return kept ? { refs: [kept], sent } : { refs: group.refs, sent: 'retry' };
  }
  return { refs: group.refs, sent: 'sent' };
}

/** What a draft send waiting for the allowance holds the tab back with. */
const DRAFT_PACING = {};

async function sendPiece(
  token: RoomToken,
  group: { base?: string; grants: string[] },
  body: Uint8Array<ArrayBuffer>
): Promise<Sent> {
  // Over the service's cap (a struct that cannot be cut): never sendable as
  // it is, so the editor gets it.
  if (body.byteLength > MAX_UPDATE_BYTES) return 'waits';
  const wait = tabAllowance.reserve(body.byteLength);
  if (wait > 0) {
    setHeld(DRAFT_PACING, true);
    await new Promise((resolve) => setTimeout(resolve, wait));
    setHeld(DRAFT_PACING, false);
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${token.token}`,
    'content-type': 'application/octet-stream',
    'x-capy-protocol': String(CLIENT_PROTOCOL),
    'x-capy-room': token.room,
  };
  if (group.base !== undefined) headers['x-capy-base'] = group.base;
  // The drafts' own client ids (Q288): a tab whose edits never reached the
  // room had them recorded for no one.
  if (group.grants.length) headers['x-capy-grants'] = group.grants.join(',');
  let response: Response;
  try {
    response = await fetch(
      new URL('/drafts', token.url.replace(WEBSOCKET_SCHEME, 'http')),
      { body, headers, method: 'POST' }
    );
  } catch {
    return 'retry';
  }
  if (response.ok) return 'sent';
  const answer = (await response.json().catch(() => null)) as {
    class?: string;
  } | null;
  switch (answer?.class) {
    case 'limit':
    case 'malformed':
      return 'refused';
    case 'lineage':
    case 'too_large':
    case 'unassigned':
    case 'unheld':
      return 'waits';
    case 'outdated':
      return 'outdated';
    case 'too_fast':
      return 'retry';
    default:
      return 'later';
  }
}

// ws: and wss: become http: and https:.
const WEBSOCKET_SCHEME = /^ws/;

interface SweepOptions {
  /** The page load's first sweep (the default): drafts of documents the
   * account lost go (once per page load, human/frontend/error-handling.md
   * 2026-10-04), and it reads every document, settled or not. */
  cleanup?: boolean;
  /** False once the page signed in as someone else: the sweep stops. */
  current?: () => boolean;
}

/**
 * One document of a sweep: its drafts go when the account lost it (the load
 * sweep only), else, when `send`, each group of current rows goes to its
 * room, and rows go only after their receipt. A refused group is marked
 * refused, to open read-only as the editor's refusals do, when it draws on
 * its own; one that needs the room's state, and a group only the editor can
 * send, are marked `held`: left for the editor's next open, never sent
 * again (a recovery of them is reported as any other). Resolves whether the
 * rows are settled for this page load.
 */
async function sweepDocument(
  key: string,
  api: SweepApi,
  send: boolean,
  { cleanup = true, current = () => true }: SweepOptions
): Promise<boolean> {
  const target = documentOf(key);
  if (!target) return true;
  const { id, keys, kind } = target;
  // A quiz's keys go with the quiz, whose token settles it.
  let token: RoomToken;
  try {
    token = await roomToken(api, kind, id, false);
  } catch (error) {
    const missing = goneReason(error);
    // A failed lookup goes again at the next trigger; a lost document's
    // drafts wait for the load sweep, which deletes them (and reads every
    // document, settled or not).
    if (!missing) return false;
    if (!(cleanup && current())) return true;
    await dropLostDrafts(
      key,
      missing,
      editIncidentReporter(kind === 'material' ? 'material' : 'source_file', id)
    );
    return true;
  }
  // The MSW mock service has no HTTP endpoint: its drafts wait for the
  // editor, as before.
  if (!send || USE_MSW || token.access !== 'write') return true;
  if (keys)
    try {
      token = await roomToken(api, kind, id, true);
    } catch {
      return true;
    }
  const sent = await sendGroups(key, token, current);
  return sent !== null && !sent.includes('retry');
}

/** Sends a document's groups its room takes now (`only`: of these rows), as
 * `sweepDocument` says: sent rows go, a refused group or one only the editor
 * can send is marked. Resolves each group's answer, or null when stopped
 * (`current` false, or refused as outdated). */
async function sendGroups(
  key: string,
  token: RoomToken,
  current: () => boolean,
  only: (row: DraftInfo) => boolean = () => true
): Promise<Sent[] | null> {
  const answers: Sent[] = [];
  const rows = await call<DraftInfo[]>({ key, op: 'rows' });
  for (const group of sendableGroups(rows.filter(only), token.room)) {
    if (!current()) return null;
    const { refs, sent } = await sendGroup(token, group);
    if (!current()) return null;
    if (sent === 'outdated') {
      outdated = true;
      markUpdateAvailable();
      return null;
    }
    answers.push(sent);
    if (sent === 'sent') await deleteDrafts(refs);
    else if (sent === 'refused' || sent === 'waits') {
      const draws =
        sent === 'refused' &&
        (await call<boolean | null>({ op: 'draws', rows: refs }));
      await markDrafts(
        key,
        refs.map((row) => row.id),
        draws ? 'refused' : 'held'
      );
    }
  }
  return answers;
}

/**
 * An opening editor's stored rows (Epo 2026-10-24, Q326): those of sessions
 * the room accepted a write from are applied and sync over the live channel
 * (`apply`); those of never-accepted sessions that carry a stored token go
 * through the draft send while the editor joins (`send`, Q319); the rest
 * are held for the merge view (marked, applied by no one).
 */
export function splitOpenDrafts(key: string, rows: EditDraft[]) {
  const apply = rows.filter((row) => row.accepted);
  const send = rows.filter(
    (row) => !(row.accepted || row.held) && !!row.grants?.length
  );
  const unmarked = rows.filter(
    (row) => !(row.accepted || row.held || send.includes(row))
  );
  if (unmarked.length)
    void markDrafts(
      key,
      unmarked.map((row) => row.id),
      'held'
    ).catch((error) => console.warn('Draft storage failed:', error));
  return { apply, send };
}

/** How long an opening editor waits, view-only, for the draft send of its
 * never-accepted stored steps before it takes them itself and edits on with
 * nothing live (Epo 2026-10-24, Q327). */
export const DRAFT_SEND_WAIT_MS = 30_000;

/** The draft send's first retry, doubling each time up to its cap (Epo
 * 2026-10-24, Q328). */
const DRAFT_SEND_RETRY_MS = 30_000;
const DRAFT_SEND_RETRY_MAX_MS = 5 * 60_000;

/**
 * Sends a document's stored rows of never-accepted sessions through
 * `/drafts`, each group with its stored tokens, until the room takes or
 * holds them (Epo 2026-10-24, Q319, Q327, Q328): at once, again 30 s after
 * a failed try, doubling to 5 minutes, and at once when the browser comes
 * back online. A try reads the rows anew, so edits stored meanwhile go too,
 * and a try in flight is never doubled. `settled` resolves once every group
 * was stored or held (or the page was refused as outdated); `stop` ends the
 * tries.
 */
export function draftSender(key: string, token: () => Promise<RoomToken>) {
  let done = false;
  let stopped = false;
  let flight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = DRAFT_SEND_RETRY_MS;
  let settle = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const end = () => {
    clearTimeout(timer);
    globalThis.removeEventListener?.('online', online);
  };
  const attempt = () => {
    if (done || stopped || flight) return;
    clearTimeout(timer);
    flight = (async () => {
      let again = true;
      try {
        const room = await token();
        // A read token sends nothing (the editor turns read-only).
        const answers =
          room.access === 'write'
            ? await sendGroups(
                key,
                room,
                () => !stopped,
                (row) => !row.accepted
              )
            : [];
        again =
          !stopped &&
          !outdated &&
          !!answers?.some((sent) => sent === 'later' || sent === 'retry');
      } catch (error) {
        console.warn('Drafts cannot be sent:', error);
      }
      flight = null;
      if (stopped) return;
      if (again) {
        timer = setTimeout(attempt, delay);
        delay = Math.min(delay * 2, DRAFT_SEND_RETRY_MAX_MS);
        return;
      }
      done = true;
      end();
      settle();
    })();
  };
  const online = () => attempt();
  globalThis.addEventListener?.('online', online);
  attempt();
  return {
    /** Whether every group was stored or held. */
    get done() {
      return done;
    },
    get settled() {
      return settled;
    },
    stop() {
      stopped = true;
      end();
    },
  };
}

export type DraftSender = ReturnType<typeof draftSender>;

// Documents whose rows a sweep settled, by key, as the row ids it saw: they
// are skipped while those stay the same, for this page load.
const settledRows = new Map<string, string>();

/**
 * One sweep of an account's stored drafts. A document an editor has open
 * (its lock is held) is skipped. Without Web Locks nothing is sent, since a
 * sweep cannot tell which documents an editor holds; lost documents still
 * go. When another tab is sweeping, this one does nothing.
 */
export async function sweepDrafts(
  actorId: string,
  api: SweepApi,
  options: SweepOptions = {}
) {
  const { cleanup = true, current = () => true } = options;
  const locks = webLocks();
  const sweep = async () => {
    const documents = await call<Record<string, string[]>>({
      op: 'documents',
      prefix: `${actorId}:`,
    });
    for (const [key, ids] of Object.entries(documents)) {
      if (!current() || outdated) return;
      const seen = ids.join(' ');
      if (!cleanup && settledRows.get(key) === seen) continue;
      const settled = locks
        ? await locks.request(
            documentLock(key),
            { ifAvailable: true },
            async (lock) =>
              !!lock &&
              (await sweepDocument(key, api, true, { cleanup, current }))
          )
        : await sweepDocument(key, api, false, { cleanup, current });
      if (settled) settledRows.set(key, seen);
    }
  };
  if (!locks) return sweep();
  await locks.request(SWEEP_LOCK, { ifAvailable: true }, (lock) =>
    lock ? sweep() : undefined
  );
}

let sweeping: { actorId: string; api: SweepApi } | null = null;

/**
 * Sweeps the signed-in account's stored drafts from any open page (Epo
 * 2026-10-13): once when the page is idle (the load sweep, which also
 * deletes drafts of documents the account lost), when the browser comes back
 * online and when the tab becomes visible. A successful send is silent. The
 * drafts worker starts now, while the page is online: one that cannot load
 * fails every request for the page load.
 */
export function startDraftSweeps(actorId: string, api: SweepApi) {
  if (sweeping?.actorId === actorId) return;
  const first = !sweeping;
  sweeping = { actorId, api };
  if (first)
    try {
      draftWorker();
    } catch (error) {
      console.warn('Draft storage failed:', error);
    }
  const run = (cleanup: boolean) => {
    const target = sweeping;
    if (!target || outdated) return;
    void sweepDrafts(target.actorId, target.api, {
      cleanup,
      current: () => sweeping === target,
    }).catch((error) => console.warn('Draft sweep failed:', error));
  };
  if (typeof requestIdleCallback === 'function')
    requestIdleCallback(() => run(true));
  else setTimeout(() => run(true), 0);
  if (!first) return;
  window.addEventListener('online', () => run(false));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') run(false);
  });
}
