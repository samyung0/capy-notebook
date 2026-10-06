import type { EditDraft } from './editDrafts';

/**
 * The draft store's IndexedDB side, run in the drafts worker
 * (draftStore.worker.ts) so the editors' main thread pays one `postMessage`
 * per local update and no storage work (human/frontend/error-handling.md,
 * 2026-10-06). One queue runs every request in the order it was posted, so a
 * read sees each write posted before it and a receipt's delete lands after
 * the updates it covers.
 */

/** A row named exactly: deleted only while it still holds this `seq`. */
export type DraftRef = Pick<EditDraft, 'id' | 'key' | 'seq'>;

export type DraftRequest =
  /** One local update. No answer unless it fails (`failed`). */
  | { op: 'append'; row: EditDraft }
  | { op: 'put'; rows: EditDraft[]; base?: Uint8Array }
  | { op: 'read'; key: string }
  | { op: 'readBase'; key: string; base: string }
  | { op: 'delete'; rows: DraftRef[] }
  /** Every row of a document; answers what was deleted, without the data. */
  | { op: 'deleteDocument'; key: string }
  | { op: 'mark'; key: string; ids: string[] }
  | { op: 'keys'; prefix: string }
  /** Answers once everything posted before it ran. */
  | { op: 'barrier' };

export type DraftMessage = DraftRequest & {
  /** `capy-edit-drafts`, or the MSW scenarios' own database. */
  database: string;
  /** The database before notes kept drafts, copied over once. */
  sourceDatabase: string;
  /** Present when the caller waits for the answer. */
  id?: number;
};

export type StorageError = { message: string; name: string };
export type DraftReply =
  | { id: number; result?: unknown; error?: StorageError }
  | { failed: string; error: StorageError };

export type DeletedDraft = Omit<EditDraft, 'data'> & { bytes: number };

function request<T>(work: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    work.onsuccess = () => resolve(work.result);
    work.onerror = () => reject(work.error);
  });
}

// One connection per database, closed when another tab upgrades it.
const connections = new Map<string, Promise<IDBDatabase>>();
function open(name: string): Promise<IDBDatabase> {
  const known = connections.get(name);
  if (known) return known;
  if (typeof indexedDB === 'undefined')
    return Promise.reject(new Error('IndexedDB is unavailable'));
  // Version 2 added `meta`; a version 1 database (an earlier build) keeps
  // its drafts and bases and gains it.
  const opening = indexedDB.open(name, 2);
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
  const connection = request(opening).then((database) => {
    database.onversionchange = () => {
      database.close();
      connections.delete(name);
    };
    database.onclose = () => connections.delete(name);
    return database;
  });
  connection.catch(() => connections.delete(name));
  connections.set(name, connection);
  return connection;
}

type Stores = {
  bases: IDBObjectStore;
  drafts: IDBObjectStore;
  meta: IDBObjectStore;
};

async function transact<T>(
  name: string,
  mode: IDBTransactionMode,
  work: (stores: Stores) => IDBRequest<T> | undefined
): Promise<T | undefined> {
  const database = await open(name);
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(['drafts', 'bases', 'meta'], mode);
    const result = work({
      bases: transaction.objectStore('bases'),
      drafts: transaction.objectStore('drafts'),
      meta: transaction.objectStore('meta'),
    });
    transaction.oncomplete = () => resolve(result?.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
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

/** A document's rows, then `each` on them, in one transaction. */
function eachRow(
  stores: Stores,
  key: string,
  each: (rows: EditDraft[]) => void
) {
  const rows = stores.drafts.index('key').getAll(key);
  rows.onsuccess = () => each(rows.result as EditDraft[]);
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
async function migrateSourceDrafts(name: string, sourceName: string) {
  if (typeof indexedDB === 'undefined') return;
  const dropOld = () => {
    indexedDB.deleteDatabase(sourceName);
  };
  if (await transact(name, 'readonly', ({ meta }) => meta.get('migrated'))) {
    dropOld();
    return;
  }
  let rows: OldSourceDraft[] = [];
  let baseKeys: IDBValidKey[] = [];
  let baseBytes: Uint8Array[] = [];
  const listed = await indexedDB.databases?.().catch(() => undefined);
  if (!listed || listed.some((entry) => entry.name === sourceName)) {
    const old = await request(indexedDB.open(sourceName));
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
  await transact(name, 'readwrite', (stores) => {
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
        const key = `${actorId}:file:${fileId}`;
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

function put(stores: Stores, rows: EditDraft[], base?: Uint8Array) {
  for (const row of rows) {
    stores.drafts.put(row);
    if (row.base === undefined || !base) continue;
    const key = [row.key, row.base];
    const present = stores.bases.getKey(key);
    present.onsuccess = () => {
      if (present.result === undefined) stores.bases.put(base, key);
    };
  }
}

function run(name: string, message: DraftRequest): Promise<unknown> {
  switch (message.op) {
    case 'append':
      return transact(name, 'readwrite', (stores) => {
        put(stores, [message.row]);
      });
    case 'put':
      return transact(name, 'readwrite', (stores) => {
        put(stores, message.rows, message.base);
      });
    case 'read':
      return transact(name, 'readonly', ({ drafts }) =>
        drafts.index('key').getAll(message.key)
      ).then((rows) => rows ?? []);
    case 'readBase':
      return transact(name, 'readonly', ({ bases }) =>
        bases.get([message.key, message.base])
      );
    case 'delete':
      return transact(name, 'readwrite', (stores) => {
        for (const row of message.rows) {
          const current = stores.drafts.get(row.id);
          current.onsuccess = () => {
            const found = current.result as EditDraft | undefined;
            if (found?.seq === row.seq) deleteRow(stores, found);
          };
        }
      });
    case 'deleteDocument': {
      const deleted: DeletedDraft[] = [];
      return transact(name, 'readwrite', (stores) => {
        eachRow(stores, message.key, (rows) => {
          for (const row of rows) {
            const { data, ...rest } = row;
            deleted.push({ ...rest, bytes: data.byteLength });
            deleteRow(stores, row);
          }
        });
      }).then(() => deleted);
    }
    case 'mark': {
      const ids = new Set(message.ids);
      return transact(name, 'readwrite', (stores) => {
        eachRow(stores, message.key, (rows) => {
          for (const row of rows)
            if (ids.has(row.id) && !row.reported)
              stores.drafts.put({ ...row, reported: true });
        });
      });
    }
    case 'keys': {
      const found = new Set<string>();
      return transact(name, 'readonly', ({ drafts }) => {
        const cursor = drafts
          .index('key')
          .openKeyCursor(
            IDBKeyRange.bound(message.prefix, `${message.prefix}￿`),
            'nextunique'
          );
        cursor.onsuccess = () => {
          if (!cursor.result) return;
          found.add(String(cursor.result.key));
          cursor.result.continue();
        };
      }).then(() => [...found]);
    }
    case 'barrier':
      return Promise.resolve();
  }
}

function storageError(error: unknown): StorageError {
  return error instanceof Error || error instanceof DOMException
    ? { message: error.message, name: error.name }
    : { message: String(error), name: 'Error' };
}

// The old database is copied before the first request, once per worker.
let queue: Promise<unknown> | null = null;

/** Run one request after every earlier one and answer it through `reply`. */
export function handleDraftMessage(
  message: DraftMessage,
  reply: (answer: DraftReply) => void
) {
  queue ??= migrateSourceDrafts(message.database, message.sourceDatabase).catch(
    (error) => console.warn('Draft migration failed:', error)
  );
  const next = queue.then(() => run(message.database, message));
  queue = next.catch(() => undefined);
  next.then(
    (result) => {
      if (message.id !== undefined) reply({ id: message.id, result });
    },
    (error) => {
      if (message.id !== undefined)
        reply({ error: storageError(error), id: message.id });
      else if (message.op === 'append')
        reply({ error: storageError(error), failed: message.row.session });
    }
  );
}
