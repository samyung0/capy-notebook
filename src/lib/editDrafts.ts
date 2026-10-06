import * as Y from 'yjs';
import { USE_MSW } from '@/api/auth';
import { isAccountForbiddenError, isApiError } from '@/api/client';
import {
  type EditIncidentReporter,
  editIncidentReporter,
  reportOnce,
  storageFailureReason,
} from '@/lib/editIncidents';

/**
 * Unsaved collaborative edits kept on this device (notes, Office and text
 * sources), so they outlive a lost connection, a reload or a closed tab. A row
 * is one session's (one editor mount's) full Yjs state or a run of its local
 * updates. Rows are deleted only once a checkpoint receipt covers them: the
 * room's sync alone is not durable.
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
  /** `${session}:state`, or `${session}:${seq}` for a run of updates. */
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

function request<T>(work: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    work.onsuccess = () => resolve(work.result);
    work.onerror = () => reject(work.error);
  });
}

function open(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined')
    return Promise.reject(new Error('IndexedDB is unavailable'));
  // Version 2 added `meta`; a version 1 database (an earlier build) keeps
  // its drafts and bases and gains it.
  const opening = indexedDB.open(DATABASE, 2);
  opening.onupgradeneeded = () => {
    const database = opening.result;
    if (!database.objectStoreNames.contains('drafts')) {
      const drafts = database.createObjectStore('drafts', { keyPath: 'id' });
      drafts.createIndex('key', 'key');
      drafts.createIndex('base', ['key', 'base']);
    }
    if (!database.objectStoreNames.contains('bases'))
      database.createObjectStore('bases');
    // `migrated`: the old source drafts were copied; never again.
    if (!database.objectStoreNames.contains('meta'))
      database.createObjectStore('meta');
  };
  return request(opening);
}

type Stores = {
  bases: IDBObjectStore;
  drafts: IDBObjectStore;
  meta: IDBObjectStore;
};

async function transact<T>(
  mode: IDBTransactionMode,
  work: (stores: Stores) => IDBRequest<T> | undefined
): Promise<T | undefined> {
  const database = await open();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(
        ['drafts', 'bases', 'meta'],
        mode
      );
      const result = work({
        bases: transaction.objectStore('bases'),
        drafts: transaction.objectStore('drafts'),
        meta: transaction.objectStore('meta'),
      });
      transaction.oncomplete = () => resolve(result?.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

/** Delete `row` and, with the last row using it, its base. */
function deleteRow(stores: Stores, row: EditDraft) {
  stores.drafts.delete(row.id);
  if (row.base === undefined) return;
  const key = [row.key, row.base];
  const users = stores.drafts.index('base').count(key);
  users.onsuccess = () => {
    if (!users.result) stores.bases.delete(key);
  };
}

interface OldSourceDraft {
  baseSourceSHA256: string;
  epoch: number;
  fileId: string;
  id: string;
  refused?: true;
  state: Uint8Array;
}

/**
 * Copy the old source-draft database's rows over once. A `migrated` marker,
 * written in the same transaction as the copied rows, makes it once for good:
 * a tab still running older code may recreate that database, and its rows
 * are then never copied again. The old database is deleted best effort (an
 * old tab holding it open blocks that, which must not hold up drafts).
 */
async function migrateSourceDrafts() {
  if (typeof indexedDB === 'undefined') return;
  const dropOld = () => {
    indexedDB.deleteDatabase(SOURCE_DATABASE);
  };
  if (await transact('readonly', ({ meta }) => meta.get('migrated'))) {
    dropOld();
    return;
  }
  let rows: OldSourceDraft[] = [];
  let baseKeys: IDBValidKey[] = [];
  let baseBytes: Uint8Array[] = [];
  const listed = await indexedDB.databases?.().catch(() => undefined);
  if (!listed || listed.some((entry) => entry.name === SOURCE_DATABASE)) {
    const old = await request(indexedDB.open(SOURCE_DATABASE));
    try {
      if (old.objectStoreNames.contains('sessionDrafts')) {
        const transaction = old.transaction(['sessionDrafts', 'bases']);
        const bases = transaction.objectStore('bases');
        [rows, baseKeys, baseBytes] = await Promise.all([
          request<OldSourceDraft[]>(
            transaction.objectStore('sessionDrafts').getAll()
          ),
          request(bases.getAllKeys()),
          request<Uint8Array[]>(bases.getAll()),
        ]);
      }
    } finally {
      old.close();
    }
  }
  const bases = new Map(
    baseKeys.map((key, index) => [String(key), baseBytes[index]])
  );
  await transact('readwrite', (stores) => {
    // Another tab may have copied them meanwhile.
    const marker = stores.meta.get('migrated');
    marker.onsuccess = () => {
      if (marker.result) return;
      stores.meta.put(true, 'migrated');
      for (const row of rows) {
        // `fileId` was `${actorId}:${fileId}`; bases were keyed by it and SHA.
        const [actorId, fileId] = row.fileId.split(':');
        const base = bases.get(String([row.fileId, row.baseSourceSHA256]));
        if (!(base && actorId && fileId)) continue;
        const key = draftKey(actorId, 'file', fileId);
        stores.drafts.put({
          base: row.baseSourceSHA256,
          data: row.state,
          id: `${row.id}:state`,
          key,
          kind: 'state',
          lineage: `source:${fileId}:epoch:${row.epoch}@${row.baseSourceSHA256}`,
          savedAt: Date.now(),
          seq: 1,
          session: row.id,
          ...(row.refused && { refused: row.refused }),
        } satisfies EditDraft);
        stores.bases.put(base, [key, row.baseSourceSHA256]);
      }
    };
  });
  dropOld();
}

// One queue for every read and write, so a read sees each write queued before
// it (a note that remounts onto a moved room reads what the old mount wrote).
// The old database is copied before the first.
let queue: Promise<unknown> | null = null;
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  queue ??= migrateSourceDrafts().catch((error) =>
    console.warn('Draft migration failed:', error)
  );
  const next = queue.then(work);
  queue = next.catch(() => undefined);
  return next;
}

export function readDrafts(key: string): Promise<EditDraft[]> {
  if (!stored(key)) return Promise.resolve([]);
  return enqueue(
    async () =>
      ((await transact('readonly', ({ drafts }) =>
        drafts.index('key').getAll(key)
      )) ?? []) as EditDraft[]
  );
}

/** A source base stored beside its drafts. */
export function readDraftBase(key: string, base: string) {
  return enqueue(
    async () =>
      (await transact('readonly', ({ bases }) => bases.get([key, base]))) as
        | Uint8Array
        | undefined
  );
}

/** Write rows, and their source base when it is not stored yet. */
export function putDrafts(rows: EditDraft[], base?: Uint8Array): Promise<void> {
  const kept = rows.filter((row) => stored(row.key));
  if (!kept.length) return Promise.resolve();
  return enqueue(async () => {
    await transact('readwrite', (stores) => {
      for (const row of kept) {
        stores.drafts.put(row);
        if (row.base === undefined || !base) continue;
        const key = [row.key, row.base];
        const present = stores.bases.getKey(key);
        present.onsuccess = () => {
          if (present.result === undefined) stores.bases.put(base, key);
        };
      }
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
    await transact('readwrite', (stores) => {
      for (const row of kept) {
        const current = stores.drafts.get(row.id);
        current.onsuccess = () => {
          const found = current.result as EditDraft | undefined;
          if (found?.seq === row.seq) deleteRow(stores, found);
        };
      }
    });
  });
}

/** Every row of a document, all sessions: its user lost access or it is
 * gone. Resolves to the bytes the deleted rows held. */
export function deleteDocumentDrafts(key: string): Promise<number> {
  if (!stored(key)) return Promise.resolve(0);
  return enqueue(async () => {
    let bytes = 0;
    await transact('readwrite', (stores) => {
      const rows = stores.drafts.index('key').getAll(key);
      rows.onsuccess = () => {
        for (const row of rows.result as EditDraft[]) {
          bytes += row.data.byteLength;
          deleteRow(stores, row);
        }
      };
    });
    return bytes;
  });
}

/** Deletes the stored edits of a document this account lost (a 404, or a 403
 * not about the account itself) and reports them as discarded, when there
 * were any (edit_incidents). Queued before a live recorder's own discard, it
 * counts that session's rows too. */
export async function dropLostDrafts(
  key: string,
  reason: 'forbidden' | 'not_found',
  report: EditIncidentReporter
) {
  const bytes = await deleteDocumentDrafts(key);
  if (bytes) report('discard_unsaved', reason, bytes);
}

/** Marks a document's rows `which` picks as reported (edit_incidents). */
export function markDraftsReported(
  key: string,
  which: (row: EditDraft) => boolean
): Promise<void> {
  if (!stored(key)) return Promise.resolve();
  return enqueue(async () => {
    await transact('readwrite', (stores) => {
      const rows = stores.drafts.index('key').getAll(key);
      rows.onsuccess = () => {
        for (const row of rows.result as EditDraft[])
          if (which(row) && !row.reported)
            stores.drafts.put({ ...row, reported: true });
      };
    });
  });
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
  const prefix = `${actorId}:`;
  const keys = await enqueue(async () => {
    const found = new Set<string>();
    await transact('readonly', ({ drafts }) => {
      const cursor = drafts
        .index('key')
        .openKeyCursor(IDBKeyRange.bound(prefix, `${prefix}￿`), 'nextunique');
      cursor.onsuccess = () => {
        if (!cursor.result) return;
        found.add(String(cursor.result.key));
        cursor.result.continue();
      };
    });
    return [...found];
  });
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
    const ids = new Set(group.map((row) => row.id));
    void markDraftsReported(first.key, (row) => ids.has(row.id)).catch(
      (error) => console.warn('Draft storage failed:', error)
    );
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

const FLUSH_MS = 250;
// Update rows per session before they are merged into one.
const MAX_UPDATE_ROWS = 64;

export interface DraftRecorderOptions {
  /** Rows of earlier sessions applied into `doc`: they count as edit 1. */
  adopted?: EditDraft[];
  /** A source's base, stored once beside its rows. */
  base?: { sha: string; bytes: Uint8Array };
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
  /** Whether the last write reached storage (false: private mode, a full
   * disk). Editing goes on either way. */
  onStorage?: (ok: boolean) => void;
  /** Reports a failing draft store and each offline episode, after the
   * reconnect (edit_incidents). */
  report?: EditIncidentReporter;
}

/**
 * Records a session's unsaved work as it happens. The host reports the
 * connection (`disconnected` once it treats the room as unreachable,
 * `connected` on sync) and each receipt (`covered` with the highest local
 * edit count it acknowledges, read from `sequence` when the checkpoint was
 * requested).
 */
export function recordDrafts({
  adopted = [],
  base,
  doc,
  fullState = false,
  ignore,
  key,
  limitBytes,
  lineage,
  onLimit,
  onStorage,
  report,
}: DraftRecorderOptions) {
  const session = crypto.randomUUID();
  const start = adopted.length ? 1 : 0;
  let sequence = start;
  let covered = 0;
  let pendingAdopted = adopted;
  // Local updates not yet written, and written update rows a receipt has not
  // covered (kept in memory to merge and to count).
  let buffer: { seq: number; data: Uint8Array }[] = [];
  let rows: { id: string; seq: number; data: Uint8Array }[] = [];
  let state: { seq: number; bytes: number } | null = null;
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
    ...(base && { base: base.sha }),
    ...(refused && { refused }),
  });
  // This session's own unsaved bytes: what the offline bound counts.
  const unsavedBytes = () =>
    fullState
      ? (state?.bytes ?? 0)
      : [...rows, ...buffer].reduce((sum, item) => sum + item.data.length, 0);
  // What the device holds unsaved for this document (edit_incidents sizes):
  // a source's last whole state, which holds the adopted edits too, else the
  // adopted rows no receipt covered yet plus this session's own.
  const heldBytes = () =>
    fullState
      ? (state?.bytes ?? draftBytes(pendingAdopted))
      : unsavedBytes() + draftBytes(pendingAdopted);
  const checkLimit = () => {
    if (offline && !over && unsavedBytes() > limitBytes) {
      over = true;
      onLimit?.(true);
    }
  };
  const write = (work: Promise<void>, whole = false) =>
    work.then(
      () => {
        if (gap && !whole) return;
        gap = false;
        if (storageOk) return;
        storageOk = true;
        onStorage?.(true);
      },
      (error) => {
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
      }
    );

  const flush = (snapshot = false) => {
    clearTimeout(timer);
    timer = undefined;
    // Nothing of this session's own to write (adopted rows are stored).
    if (stopped || sequence <= Math.max(covered, start))
      return Promise.resolve();
    const writes: EditDraft[] = [];
    const removed: { id: string; seq: number }[] = [];
    let whole = false;
    if (fullState) {
      // Past the offline bound nothing more is stored (the editor stopped).
      if ((gap || state?.seq !== sequence) && !over) {
        whole = true;
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
        writes.push(
          ...rows.slice(-1).map((last) => row('update', last.seq, last.data))
        );
      }
      // The whole document once per offline episode (and at unmount), and
      // after a failed write: the base later updates need when they open in
      // recovery. Not past the offline bound.
      if (
        !over &&
        (gap || ((snapshot || snapshotDue) && state?.seq !== sequence))
      ) {
        whole = true;
        snapshotDue = false;
        const data = Y.encodeStateAsUpdate(doc);
        state = { bytes: data.length, seq: sequence };
        writes.push(row('state', sequence, data));
      }
    }
    checkLimit();
    if (offline) requestPersistence();
    // Both queued now, in order, so a read queued next sees them.
    return write(
      Promise.all([
        putDrafts(writes, base?.bytes),
        deleteDrafts(
          removed.map((item) => ({ id: item.id, key, seq: item.seq }))
        ),
      ]).then(() => undefined),
      whole
    );
  };

  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (stopped || ignore(origin)) return;
    sequence++;
    // Past the offline bound the editor stopped taking edits; anything that
    // still arrives stays in memory and syncs on reconnect.
    if (!(fullState || over)) buffer.push({ data: update, seq: sequence });
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
    ...rows.map((item) => ({ id: item.id, key, seq: item.seq })),
    ...(state ? [{ id: `${session}:state`, key, seq: state.seq }] : []),
    ...pendingAdopted,
  ];

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
      const done: Pick<EditDraft, 'id' | 'key' | 'seq'>[] = rows
        .filter((item) => item.seq <= covered)
        .map((item) => ({ id: item.id, key, seq: item.seq }));
      rows = rows.filter((item) => item.seq > covered);
      buffer = buffer.filter((item) => item.seq > covered);
      if (state && state.seq <= covered && sequence <= covered) {
        done.push({ id: `${session}:state`, key, seq: state.seq });
        state = null;
      }
      done.push(...pendingAdopted);
      pendingAdopted = [];
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
      snapshotDue = !fullState;
      checkLimit();
      if (sequence > Math.max(covered, start)) void flush();
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
     * (shown for copying, never merged) and stop recording. Returns that
     * row, which a later delete (queued after the write) removes. */
    refuse(): Pick<EditDraft, 'id' | 'key' | 'seq'> {
      const previous = ownRows();
      const data = Y.encodeStateAsUpdate(doc);
      stop();
      const refused = row('state', sequence, data, true);
      void write(
        Promise.all([
          deleteDrafts(previous),
          putDrafts([refused], base?.bytes),
        ]).then(() => undefined)
      );
      return refused;
    },
    /** Local edits so far (1 for adopted rows): a checkpoint request
     * records it. */
    get sequence() {
      return sequence;
    },
    session,
    get unsaved() {
      return sequence > covered;
    },
    /** What this device holds unsaved for the document, adopted rows
     * included: update rows (notes) or the last whole state (sources). */
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
