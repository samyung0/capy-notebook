import * as Y from 'yjs';
import { USE_MSW } from '@/api/auth';

/**
 * Unsaved collaborative edits kept on this device (notes, Office and text
 * sources), so they outlive a lost connection, a reload or a closed tab. A row
 * is one session's (one editor mount's) full Yjs state or a run of its local
 * updates. Rows are deleted only once a checkpoint receipt covers them: the
 * room's sync alone is not durable.
 *
 * `lineage` names the room state the edits grew from: the room name (a note's
 * `material:<id>:schema:<n>`, a source's `source:<id>:epoch:<n>`, plus the
 * base SHA for Office). Rows of another lineage, or refused ones, are never
 * merged into a live document; they open read-only for copying.
 */
export interface EditDraft {
  data: Uint8Array;
  /** `${session}:state`, or `${session}:${seq}` for a run of updates. */
  id: string;
  /** `${actorId}:material:${id}` or `${actorId}:file:${id}`. */
  key: string;
  kind: 'state' | 'update';
  lineage: string;
  /** A save refused for good: shown for copying, never merged back. */
  refused?: true;
  savedAt: number;
  /** The session's local edit count this row covers. */
  seq: number;
  session: string;
}

// Only explicit MSW scenario fixtures use storage: MSW resets its database on
// reload, so any other stored edit belongs to a room that no longer exists.
function stored(key: string) {
  return !USE_MSW || key.split(':').at(-1)?.startsWith('mock-scenario-');
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }
    const request = indexedDB.open(
      USE_MSW ? 'capy-edit-drafts-msw-scenarios' : 'capy-edit-drafts',
      1
    );
    request.onupgradeneeded = () => {
      const drafts = request.result.createObjectStore('drafts', {
        keyPath: 'id',
      });
      drafts.createIndex('key', 'key');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T> | undefined
): Promise<T | undefined> {
  const database = await open();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction('drafts', mode);
      const request = work(transaction.objectStore('drafts'));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

// One queue for every read and write, so a read sees each write queued before
// it (a note that remounts onto a moved room reads what the old mount wrote).
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work);
  queue = next.catch(() => undefined);
  return next;
}

export function readDrafts(key: string): Promise<EditDraft[]> {
  if (!stored(key)) return Promise.resolve([]);
  return enqueue(
    async () =>
      ((await transact('readonly', (store) =>
        store.index('key').getAll(key)
      )) ?? []) as EditDraft[]
  );
}

export function putDrafts(rows: EditDraft[]): Promise<void> {
  const kept = rows.filter((row) => stored(row.key));
  if (!kept.length) return Promise.resolve();
  return enqueue(async () => {
    await transact('readwrite', (store) => {
      for (const row of kept) store.put(row);
    });
  });
}

/** Delete exactly these rows: a row rewritten since (a higher `seq` under the
 * same id, another tab's newer state) stays. */
export function deleteDrafts(
  rows: Pick<EditDraft, 'id' | 'key' | 'seq'>[]
): Promise<void> {
  const kept = rows.filter((row) => stored(row.key));
  if (!kept.length) return Promise.resolve();
  return enqueue(async () => {
    await transact('readwrite', (store) => {
      for (const row of kept) {
        const current = store.get(row.id);
        current.onsuccess = () => {
          if ((current.result as EditDraft | undefined)?.seq === row.seq)
            store.delete(row.id);
        };
      }
    });
  });
}

/** Every row of a document, all sessions: its user lost access or it is gone. */
export function deleteDocumentDrafts(key: string): Promise<void> {
  if (!stored(key)) return Promise.resolve();
  return enqueue(async () => {
    await transact('readwrite', (store) => {
      const keys = store.index('key').getAllKeys(key);
      keys.onsuccess = () => {
        for (const id of keys.result) store.delete(id);
      };
    });
  });
}

/**
 * Split a document's rows against the room it opens: `current` merges into
 * the live document; `recovery` is one group (refused rows, or one other
 * lineage) to show read-only first. Further groups wait for the next open.
 */
export function draftGroups(rows: EditDraft[], lineage: string) {
  const first = rows.find((row) => row.refused || row.lineage !== lineage);
  return {
    current: rows.filter((row) => !row.refused && row.lineage === lineage),
    recovery: first
      ? rows.filter(
          (row) =>
            row.lineage === first.lineage && !!row.refused === !!first.refused
        )
      : [],
  };
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

let persistenceRequested = false;
/** Ask once per page load for storage the browser will not evict under
 * pressure. Best effort: Firefox may ask the user, Safari still deletes
 * script storage after 7 days without a visit, private windows on close. */
function requestPersistence() {
  if (persistenceRequested) return;
  persistenceRequested = true;
  void navigator.storage?.persist?.().catch(() => undefined);
}

const FLUSH_MS = 250;
// Update rows per session before they are merged into one.
const MAX_UPDATE_ROWS = 64;

export interface DraftRecorderOptions {
  /** Rows of earlier sessions applied into `doc`: they count as edit 1. */
  adopted?: EditDraft[];
  doc: Y.Doc;
  /** Write the whole state, latest only (sources), instead of appending local
   * updates (notes, whose full encode is too slow for the typing path). */
  fullState?: boolean;
  /** Updates not to record: the room's own and restores. */
  ignore: (origin: unknown) => boolean;
  key: string;
  /** Unsaved bytes this device holds before `onLimit(true)`, while
   * disconnected: the host then stops taking edits (nothing is dropped). */
  limitBytes: number;
  lineage: string;
  onLimit?: (over: boolean) => void;
}

/**
 * Records a session's unsaved work as it happens. The host reports the
 * connection (`disconnected`, `connected`) and each receipt (`covered` with
 * the highest local edit count it acknowledges, read from `sequence` when the
 * checkpoint was requested).
 */
export function recordDrafts({
  doc,
  key,
  lineage,
  ignore,
  fullState = false,
  limitBytes,
  onLimit,
  adopted = [],
}: DraftRecorderOptions) {
  const session = crypto.randomUUID();
  let sequence = adopted.length ? 1 : 0;
  let covered = 0;
  let pendingAdopted = adopted;
  // Local updates not yet written, and written update rows a receipt has not
  // covered (kept in memory to merge and to count).
  let buffer: { seq: number; data: Uint8Array }[] = [];
  let rows: { id: string; seq: number; data: Uint8Array }[] = [];
  let state: { seq: number; bytes: number } | null = null;
  let offline = false;
  let snapshotDue = false;
  let over = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

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
    ...(refused && { refused }),
  });
  const unsavedBytes = () =>
    fullState
      ? (state?.bytes ?? 0)
      : [...rows, ...buffer].reduce((sum, item) => sum + item.data.length, 0);
  const checkLimit = () => {
    if (offline && !over && unsavedBytes() > limitBytes) {
      over = true;
      onLimit?.(true);
    }
  };
  const write = (work: Promise<void>) =>
    work.catch((error) => console.warn('Draft storage failed:', error));

  const flush = (snapshot = false) => {
    clearTimeout(timer);
    timer = undefined;
    if (stopped || sequence <= covered) return Promise.resolve();
    const writes: EditDraft[] = [];
    const removed: { id: string; seq: number }[] = [];
    if (fullState) {
      if (state?.seq !== sequence) {
        const data = Y.encodeStateAsUpdate(doc);
        state = { bytes: data.length, seq: sequence };
        writes.push(row('state', sequence, data));
      }
    } else {
      if (buffer.length) {
        const run = buffer;
        buffer = [];
        rows.push({
          data: Y.mergeUpdates(run.map((item) => item.data)),
          id: `${session}:${sequence}`,
          seq: sequence,
        });
        if (rows.length > MAX_UPDATE_ROWS) {
          removed.push(...rows.slice(0, -1));
          rows = [
            {
              data: Y.mergeUpdates(rows.map((item) => item.data)),
              id: `${session}:${sequence}`,
              seq: sequence,
            },
          ];
        }
        writes.push(...rows.slice(-1).map((r) => row('update', r.seq, r.data)));
      }
      // The whole document once per offline episode (and at unmount): the
      // base later updates need when they open in recovery.
      if ((snapshot || snapshotDue) && state?.seq !== sequence) {
        snapshotDue = false;
        const data = Y.encodeStateAsUpdate(doc);
        state = { bytes: data.length, seq: sequence };
        writes.push(row('state', sequence, data));
      }
    }
    checkLimit();
    if (offline) requestPersistence();
    return write(
      putDrafts(writes).then(() =>
        deleteDrafts(removed.map((r) => ({ id: r.id, key, seq: r.seq })))
      )
    );
  };

  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (stopped || ignore(origin)) return;
    sequence++;
    if (!fullState) buffer.push({ data: update, seq: sequence });
    checkLimit();
    timer ??= setTimeout(() => void flush(), FLUSH_MS);
  };
  doc.on('update', onUpdate);
  const onPageHide = () => void flush(true);
  if (typeof window !== 'undefined')
    window.addEventListener('pagehide', onPageHide);

  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    doc.off('update', onUpdate);
    if (typeof window !== 'undefined')
      window.removeEventListener('pagehide', onPageHide);
  };
  // Every row this session wrote or adopted, as written.
  const ownRows = () => [
    ...rows.map((r) => ({ id: r.id, key, seq: r.seq })),
    ...(state ? [{ id: `${session}:state`, key, seq: state.seq }] : []),
    ...pendingAdopted,
  ];

  return {
    connected() {
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
      const done: Pick<EditDraft, 'id' | 'key' | 'seq'>[] = [];
      done.push(
        ...rows
          .filter((r) => r.seq <= covered)
          .map((r) => ({ id: r.id, key, seq: r.seq }))
      );
      rows = rows.filter((r) => r.seq > covered);
      buffer = buffer.filter((item) => item.seq > covered);
      if (state && state.seq <= covered && sequence <= covered) {
        done.push({ id: `${session}:state`, key, seq: state.seq });
        state = null;
      }
      done.push(...pendingAdopted);
      pendingAdopted = [];
      return write(deleteDrafts(done));
    },
    /** Unsaved work is discarded (the room turned read-only): delete it. */
    discard() {
      const previous = ownRows();
      stop();
      return write(deleteDrafts(previous));
    },
    disconnected() {
      offline = true;
      snapshotDue = !fullState;
      checkLimit();
      if (sequence > covered) void flush();
    },
    /** Write what is buffered (with the whole document when unsaved work
     * remains, for a remount into recovery) and stop. */
    dispose() {
      const done = flush(!fullState);
      stop();
      return done;
    },
    /** Write what is buffered now. */
    flush: () => flush(),
    /** A save refused for good: keep the whole document as one refused row
     * (shown for copying, never merged) and stop recording. */
    refuse() {
      const previous = ownRows();
      const data = Y.encodeStateAsUpdate(doc);
      stop();
      const refused = row('state', sequence, data, true);
      return write(deleteDrafts(previous).then(() => putDrafts([refused])));
    },
    /** Local edits so far: a checkpoint request records it. */
    get sequence() {
      return sequence;
    },
    session,
    get unsaved() {
      return sequence > covered;
    },
  };
}

export type DraftRecorder = ReturnType<typeof recordDrafts>;
