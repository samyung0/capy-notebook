export interface SourceDraft {
  base: Uint8Array;
  baseSourceSHA256: string;
  epoch: number;
  fileId: string;
  id: string;
  state: Uint8Array;
  version: string;
}

function openDrafts(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('capy-source-drafts', 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.createObjectStore('sessionDrafts', {
        keyPath: 'id',
      });
      store.createIndex('fileId', 'fileId');
      if (database.objectStoreNames.contains('drafts')) {
        const legacy = request.transaction!.objectStore('drafts').openCursor();
        legacy.onsuccess = () => {
          const cursor = legacy.result;
          if (!cursor) return;
          store.put({
            ...cursor.value,
            id: `legacy:${cursor.key}`,
            version: 'legacy',
          });
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readSourceDrafts(fileId: string): Promise<SourceDraft[]> {
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

export async function writeSourceDraft(draft: SourceDraft): Promise<void> {
  const database = await openDrafts();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('sessionDrafts', 'readwrite');
      transaction.objectStore('sessionDrafts').put(draft);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

/** Remove only the exact snapshots included in an acknowledged checkpoint. */
export async function clearSourceDrafts(
  drafts: Pick<SourceDraft, 'id' | 'version'>[]
): Promise<void> {
  const database = await openDrafts();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('sessionDrafts', 'readwrite');
      const store = transaction.objectStore('sessionDrafts');
      for (const draft of drafts) {
        const request = store.get(draft.id);
        request.onsuccess = () => {
          if (request.result?.version === draft.version) store.delete(draft.id);
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
