import { USE_MSW } from '@/api/auth';
import { m } from '@/i18n';

/**
 * One session's latest unacknowledged state. Its source base is stored once
 * per file and SHA (a never-seeded session can report an empty SHA).
 */
export interface SourceDraft {
  baseSourceSHA256: string;
  epoch: number;
  fileId: string;
  id: string;
  state: Uint8Array;
  version: string;
}

// Only explicit recovery fixtures may use storage in MSW. They share the real
// transaction code, but never the real account database.
function mockDraft(fileId: string) {
  return fileId.split(':').at(-1)?.startsWith('mock-scenario-') === true;
}

function openDrafts(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(
      USE_MSW ? 'capy-source-drafts-msw-scenarios' : 'capy-source-drafts',
      3
    );
    // Older layouts kept a base copy in every draft; they are not carried over.
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const name of [...database.objectStoreNames])
        database.deleteObjectStore(name);
      const drafts = database.createObjectStore('sessionDrafts', {
        keyPath: 'id',
      });
      drafts.createIndex('fileId', 'fileId');
      drafts.createIndex('base', ['fileId', 'baseSourceSHA256']);
      database.createObjectStore('bases');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readSourceDrafts(fileId: string): Promise<SourceDraft[]> {
  // MSW resets its database on reload. A durable draft belongs to that old Y.Doc.
  if (USE_MSW && !mockDraft(fileId)) return [];
  const database = await openDrafts();
  try {
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction('sessionDrafts')
        .objectStore('sessionDrafts')
        .index('fileId')
        .getAll(fileId);
      request.onsuccess = () => resolve(request.result as SourceDraft[]);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

/** Write the draft, storing its source base only when it is not stored yet. */
export async function writeSourceDraft(
  draft: SourceDraft,
  base: Uint8Array
): Promise<void> {
  if (USE_MSW && !mockDraft(draft.fileId)) return;
  const database = await openDrafts();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        ['sessionDrafts', 'bases'],
        'readwrite'
      );
      transaction.objectStore('sessionDrafts').put(draft);
      const bases = transaction.objectStore('bases');
      const key = [draft.fileId, draft.baseSourceSHA256];
      const stored = bases.getKey(key);
      stored.onsuccess = () => {
        if (stored.result === undefined) bases.put(base, key);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export async function readSourceBase(
  draft: Pick<SourceDraft, 'fileId' | 'baseSourceSHA256'>
): Promise<Uint8Array> {
  const database = await openDrafts();
  try {
    const base = await new Promise<Uint8Array | undefined>(
      (resolve, reject) => {
        const request = database
          .transaction('bases')
          .objectStore('bases')
          .get([draft.fileId, draft.baseSourceSHA256]);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }
    );
    if (!base) throw new Error(m.source_edit_draft_base_missing());
    return base;
  } finally {
    database.close();
  }
}

/**
 * Remove only the exact snapshots included in an acknowledged checkpoint, and
 * a base no remaining draft uses.
 */
export async function clearSourceDrafts(
  drafts: Pick<SourceDraft, 'id' | 'version' | 'fileId'>[]
): Promise<void> {
  const eligible = USE_MSW
    ? drafts.filter((draft) => mockDraft(draft.fileId))
    : drafts;
  if (!eligible.length) return;
  const database = await openDrafts();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        ['sessionDrafts', 'bases'],
        'readwrite'
      );
      const store = transaction.objectStore('sessionDrafts');
      for (const draft of eligible) {
        const request = store.get(draft.id);
        request.onsuccess = () => {
          const row = request.result as SourceDraft | undefined;
          if (row?.version !== draft.version) return;
          store.delete(draft.id);
          const key = [row.fileId, row.baseSourceSHA256];
          const users = store.index('base').count(key);
          users.onsuccess = () => {
            if (!users.result) transaction.objectStore('bases').delete(key);
          };
        };
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

/** Return one recoverable lineage, leaving current and other lineages untouched. */
export function sourceRecoveryDrafts(
  drafts: SourceDraft[],
  session: { epoch: number; baseSourceSHA256: string; format: string }
): SourceDraft[] {
  const sameLineage = (
    left: Pick<SourceDraft, 'epoch' | 'baseSourceSHA256'>,
    right: Pick<SourceDraft, 'epoch' | 'baseSourceSHA256'>
  ) =>
    left.epoch === right.epoch &&
    (session.format === 'text' ||
      left.baseSourceSHA256 === right.baseSourceSHA256);
  const first = drafts.find((draft) => !sameLineage(draft, session));
  return first ? drafts.filter((draft) => sameLineage(draft, first)) : [];
}
