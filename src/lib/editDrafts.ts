import * as Y from 'yjs';
import { USE_MSW } from '@/api/auth';
import { isAccountForbiddenError, isApiError } from '@/api/client';
import {
  type EditIncidentReporter,
  editIncidentReporter,
  reportOnce,
  storageFailureReason,
} from '@/lib/editIncidents';
import type {
  DeletedDraft,
  DraftMessage,
  DraftRef,
  DraftReply,
  DraftRequest,
  StorageError,
} from './draftStore';

/**
 * Unsaved collaborative edits kept on this device (notes, Office and text
 * sources), so they outlive a lost connection, a reload or a closed tab. A row
 * is one session's (one editor mount's) full Yjs state or one of its local
 * updates (an earlier build merged runs of them). Rows are deleted only once a
 * checkpoint receipt covers them: the room's sync alone is not durable.
 *
 * `lineage` names the room state the edits grew from: the room name (a note's
 * `material:<id>:schema:<n>`, a source's `source:<id>:epoch:<n>@<baseSHA>`).
 * Rows of another lineage, or refused ones, are never merged into a live
 * document; they open read-only for copying.
 */
export interface EditDraft {
  /** A source's base (`bases` store), which recovery opens the edits over. */
  base?: string;
  data: Uint8Array;
  /** `${session}:state`, or `${session}:${seq}` for an update. */
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
  started.onmessage = ({ data }: MessageEvent<DraftReply>) => {
    if ('failed' in data) {
      appendFailures.get(data.failed)?.(storageError(data.error));
      return;
    }
    const waiter = waiting.get(data.id);
    waiting.delete(data.id);
    if (data.error) waiter?.reject(storageError(data.error));
    else waiter?.resolve(data.result);
  };
  // A worker that failed to start answers nothing: every request fails.
  started.onerror = () => {
    workerFailed = new Error('The drafts worker failed');
    for (const waiter of waiting.values()) waiter.reject(workerFailed);
    waiting.clear();
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
 * which then wait behind it (draftGroups shows one group per open).
 */
export async function openRecoveryGroup(
  group: EditDraft[],
  report: EditIncidentReporter
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
    const doc = base && recoveryDocument(group);
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
  counted: (row: DeletedDraft) => boolean = () => true
): Promise<number> {
  if (!stored(key)) return 0;
  const deleted = await call<DeletedDraft[]>({ key, op: 'deleteDocument' });
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
  counted?: (row: DeletedDraft) => boolean
) {
  const bytes = await deleteDocumentDrafts(key, counted);
  if (bytes) report('discard_unsaved', reason, bytes);
}

/** Marks these rows of a document reported (edit_incidents). */
export function markDraftsReported(key: string, ids: string[]): Promise<void> {
  if (!(stored(key) && ids.length)) return Promise.resolve();
  return call({ ids, key, op: 'mark' });
}

/**
 * Once per app start: delete the stored edits of every document of this
 * account that `gone` says it no longer has (403 `forbidden`, 404
 * `not_found`), and report them. A failed check keeps them.
 */
export async function sweepDrafts(
  actorId: string,
  gone: (
    kind: 'material' | 'file',
    id: string
  ) => Promise<'forbidden' | 'not_found' | null>
) {
  const keys = await call<string[]>({ op: 'keys', prefix: `${actorId}:` });
  for (const key of keys) {
    const [, kind, id] = key.split(':');
    if ((kind === 'material' || kind === 'file') && id) {
      const missing = await gone(kind, id).catch(() => null);
      if (missing)
        await dropLostDrafts(
          key,
          missing,
          editIncidentReporter(
            kind === 'material' ? 'material' : 'source_file',
            id
          )
        );
    }
  }
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
  const ordered = [...rows].sort(
    (a, b) =>
      Number(a.kind === 'update') - Number(b.kind === 'update') || a.seq - b.seq
  );
  Y.applyUpdate(doc, Y.mergeUpdates(ordered.map((row) => row.data)), origin);
}

/** A recovery group as one document, or null when it cannot be drawn: update
 * rows whose base was never stored (a tab closed online, then the room moved). */
export function recoveryDocument(rows: EditDraft[]): Y.Doc | null {
  const doc = new Y.Doc();
  applyDrafts(doc, rows, null);
  if (doc.store.pendingStructs || doc.store.pendingDs) {
    doc.destroy();
    return null;
  }
  return doc;
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
  /** A source's base, stored once beside its rows. */
  base?: { sha: string; bytes: Uint8Array };
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
}: DraftRecorderOptions) {
  const session = crypto.randomUUID();
  const keep = stored(key);
  const start = adopted.length ? 1 : 0;
  let sequence = start;
  let covered = 0;
  let pendingAdopted = adopted;
  // This session's update rows no receipt covered yet, and their bytes.
  let updates: { seq: number; bytes: number }[] = [];
  let updateBytes = 0;
  // The last whole state written, and the update bytes written after it.
  let state: { seq: number; bytes: number } | null = null;
  let sinceState = 0;
  let writingState = false;
  let offline = false;
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

  const row = (
    kind: EditDraft['kind'],
    seq: number,
    data: Uint8Array,
    refused?: true
  ): EditDraft => ({
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
    if (!storageOk) return;
    storageOk = false;
    onStorage?.(false);
    const reason = storageFailureReason(error);
    const bytes = heldBytes();
    const send = () => report?.('draft_storage_failed', reason, bytes);
    if (offline) heldStorageReport = send;
    else send();
  };
  const write = (work: Promise<unknown>, whole = false) =>
    work.then(() => {
      if (gap && !whole) return;
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
    writingState = true;
    if (offline) requestPersistence();
    return write(
      putDrafts([row('state', sequence, data)], base?.bytes),
      true
    ).finally(() => {
      writingState = false;
    });
  };
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
      } catch (error) {
        failed(error);
      }
    if (snapshotDue || (gap && !writingState)) void writeState();
    checkLimit();
    if (offline) requestPersistence();
  };
  doc.on('update', onUpdate);
  const onPageHide = () => void snapshot();
  if (typeof window !== 'undefined')
    window.addEventListener('pagehide', onPageHide);

  const stop = () => {
    stopped = true;
    appendFailures.delete(session);
    doc.off('update', onUpdate);
    if (typeof window !== 'undefined')
      window.removeEventListener('pagehide', onPageHide);
  };
  // Every row this session wrote or adopted.
  const deleteOwnRows = () => {
    const adoptedRows = pendingAdopted;
    pendingAdopted = [];
    return keep
      ? Promise.all([
          call({
            key,
            op: 'deleteSession',
            session,
            state: true,
            upTo: Number.POSITIVE_INFINITY,
          }),
          deleteDrafts(adoptedRows),
        ])
      : Promise.resolve();
  };

  return {
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
      updates = updates.filter((item) => {
        if (item.seq > covered) return true;
        updateBytes -= item.bytes;
        return false;
      });
      const stateDone = !!state && sequence <= covered;
      if (stateDone) {
        state = null;
        sinceState = 0;
      }
      const adoptedRows = pendingAdopted;
      pendingAdopted = [];
      if (!keep) return Promise.resolve();
      return write(
        Promise.all([
          call({
            key,
            op: 'deleteSession',
            session,
            state: stateDone,
            upTo: covered,
          }),
          deleteDrafts(adoptedRows),
        ])
      );
    },
    /** Unsaved work is discarded (the room turned read-only, or recovery was
     * left): delete what this session wrote or adopted, and stop. */
    discard() {
      stop();
      return write(deleteOwnRows());
    },
    /** The room is unreachable: edits from now on are what this device alone
     * holds, so the whole document is written once and the bound applies. */
    disconnected() {
      offline = true;
      offlineReason =
        navigator.onLine === false ? 'browser_offline' : 'unreachable';
      snapshotDue = true;
      checkLimit();
      void snapshot();
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
      const data = Y.encodeStateAsUpdate(doc);
      stop();
      const refused = row('state', sequence, data, true);
      void write(
        Promise.all([deleteOwnRows(), putDrafts([refused], base?.bytes)])
      );
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
async function documentGone(probe: () => Promise<unknown>) {
  try {
    await probe();
    return null;
  } catch (error) {
    if (!isApiError(error)) return null;
    if (error.status === 404) return 'not_found';
    return error.status === 403 && !isAccountForbiddenError(error)
      ? 'forbidden'
      : null;
  }
}

let swept = false;
/**
 * Once per page load, when idle: delete stored edits of documents this
 * account no longer has. Notes ask for a collaboration token (as the editor
 * would), files for their detail.
 */
export function sweepDraftsOnce(
  actorId: string,
  api: {
    get: (path: string) => Promise<unknown>;
    post: (path: string, body: unknown) => Promise<unknown>;
  }
) {
  if (swept) return;
  swept = true;
  const run = () =>
    void sweepDrafts(actorId, (kind, id) =>
      documentGone(() =>
        kind === 'material'
          ? api.post(`/materials/${id}/collaboration-token`, {})
          : api.get(`/files/${id}`)
      )
    ).catch((error) => console.warn('Draft sweep failed:', error));
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run);
  else setTimeout(run, 0);
}
