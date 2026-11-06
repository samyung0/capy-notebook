import { USE_MSW } from '@/api/auth';
import type { Question, UndoPayload } from '@/api/types';
import type { Answers } from '@/features/quizzes/grade';
import type { SrsRating } from '@/lib/srs';
import type { SrsState } from './srs';

/**
 * Browser-local data: signed-out visitors' quiz attempts and flashcard reviews
 * on shared standalone materials (never sent to the server or imported into an
 * account on sign-in), the signed-in account's agent Undo payloads for a
 * day (`undoPayloads.ts`), and drawing answers' boards as they are drawn, until
 * Done sends them (Epo 2026-11-06). Later offline work adds stores in new database
 * versions.
 *
 * Every call rejects when IndexedDB is unavailable (some private modes);
 * callers tell the visitor progress cannot be saved and keep the session in
 * memory.
 */

export interface LocalQuizAttempt {
  answers: Answers;
  correct: number;
  id: string;
  /** The graded snapshot, as signed-in attempts store it. */
  questions: Question[];
  quizId: string;
  quizName: string;
  /** When the try began. */
  startedAt: string;
  /** The latest check. */
  takenAt: string;
  total: number;
}

/** One rating, append-only: the log is the source of truth for card state. */
export interface LocalCardReview {
  cardId: string;
  rating: SrsRating;
  reviewedAt: string;
  setId: string;
}

export interface LocalCardState {
  cardId: string;
  setId: string;
  srs: SrsState;
}

/** An agent step's Undo payload exactly as the server sent it (Epo
 * 2026-10-21). */
export interface LocalUndoPayload extends UndoPayload {
  actorUserId: string;
  documentId: string;
  operationId: string;
}

/** A drawing answer's board as it stood when last changed, before Done. */
export interface LocalDrawingDraft {
  /** The board's saved document (base64). */
  doc: string;
  /** Where the answer is: the attempt or quiz, then the part. */
  key: string;
  savedAt: string;
}

const VERSION = 5;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }
    // MSW resets its data on reload; keep its rows apart from real ones.
    const request = indexedDB.open(
      USE_MSW ? 'capy-local-msw' : 'capy-local',
      VERSION
    );
    request.onupgradeneeded = ({ oldVersion }) => {
      const database = request.result;
      if (oldVersion < 1) {
        database
          .createObjectStore('quizAttempts', { keyPath: 'id' })
          .createIndex('quizId', 'quizId');
        database
          .createObjectStore('cardReviews', { autoIncrement: true })
          .createIndex('setId', 'setId');
        database
          .createObjectStore('cardStates', { keyPath: ['setId', 'cardId'] })
          .createIndex('setId', 'setId');
        database.createObjectStore('meta');
      }
      // Version 2 kept removed note images' bytes; the server keeps them in
      // its trash now.
      if (oldVersion === 2) database.deleteObjectStore('keptAssets');
      if (oldVersion < 4) {
        const payloads = database.createObjectStore('undoPayloads', {
          keyPath: 'operationId',
        });
        payloads.createIndex('issuedAt', 'issuedAt');
        payloads.createIndex('documentId', 'documentId');
      }
      if (oldVersion < 5)
        database.createObjectStore('drawingDrafts', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(
  stores: string[],
  mode: IDBTransactionMode,
  work: (transaction: IDBTransaction) => IDBRequest<T> | undefined
): Promise<T> {
  const database = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(stores, mode);
      const request = work(transaction);
      transaction.oncomplete = () => resolve(request?.result as T);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export function localQuizAttempts(quizId: string): Promise<LocalQuizAttempt[]> {
  return run(['quizAttempts'], 'readonly', (t) =>
    t.objectStore('quizAttempts').index('quizId').getAll(quizId)
  ).then((attempts) =>
    (attempts as LocalQuizAttempt[]).sort((a, b) =>
      b.takenAt.localeCompare(a.takenAt)
    )
  );
}

export function saveLocalQuizAttempt(attempt: LocalQuizAttempt): Promise<void> {
  return run(['quizAttempts'], 'readwrite', (t) => {
    t.objectStore('quizAttempts').put(attempt);
  });
}

export function localCardStates(setId: string): Promise<LocalCardState[]> {
  return run(['cardStates'], 'readonly', (t) =>
    t.objectStore('cardStates').index('setId').getAll(setId)
  );
}

/** Appends the rating and stores the card state derived from it together. */
export function recordLocalCardReview(
  review: LocalCardReview,
  srs: SrsState
): Promise<void> {
  return run(['cardReviews', 'cardStates'], 'readwrite', (t) => {
    t.objectStore('cardReviews').add(review);
    t.objectStore('cardStates').put({
      cardId: review.cardId,
      setId: review.setId,
      srs,
    } satisfies LocalCardState);
  });
}

export function localUndoPayload(
  operationId: string
): Promise<LocalUndoPayload | undefined> {
  return run(['undoPayloads'], 'readonly', (t) =>
    t.objectStore('undoPayloads').get(operationId)
  );
}

export function saveLocalUndoPayload(payload: LocalUndoPayload): Promise<void> {
  return run(['undoPayloads'], 'readwrite', (t) => {
    t.objectStore('undoPayloads').put(payload);
  });
}

/** Drops a document's payloads made in a lineage before `epoch`. */
export function deleteLocalUndoPayloadsBefore(
  documentId: string,
  epoch: number
): Promise<void> {
  return run(['undoPayloads'], 'readwrite', (t) => {
    t
      .objectStore('undoPayloads')
      .index('documentId')
      .openCursor(IDBKeyRange.only(documentId)).onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>)
        .result;
      if (!cursor) return;
      if ((cursor.value as LocalUndoPayload).epoch < epoch) cursor.delete();
      cursor.continue();
    };
  });
}

/** The account the stored payloads belong to (M1): none yet, or signed out. */
export function localUndoPayloadsOwner(): Promise<string | undefined> {
  return run(['meta'], 'readonly', (t) =>
    t.objectStore('meta').get('undoPayloadsOwner')
  );
}

/** Deletes every stored payload and gives the store to `owner` (none: signed
 * out), in one transaction. */
export function claimLocalUndoPayloads(owner: string | null): Promise<void> {
  return run(['meta', 'undoPayloads'], 'readwrite', (t) => {
    t.objectStore('undoPayloads').clear();
    const meta = t.objectStore('meta');
    if (owner) meta.put(owner, 'undoPayloadsOwner');
    else meta.delete('undoPayloadsOwner');
  });
}

/** Drops one payload, and every payload issued before `before` (Unix
 * seconds). */
export function deleteLocalUndoPayloads(
  operationId: string | null,
  before: number
): Promise<void> {
  return run(['undoPayloads'], 'readwrite', (t) => {
    const store = t.objectStore('undoPayloads');
    if (operationId) store.delete(operationId);
    store
      .index('issuedAt')
      .openCursor(IDBKeyRange.upperBound(before, true)).onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>)
        .result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
  });
}

export function localDrawingDraft(
  key: string
): Promise<LocalDrawingDraft | undefined> {
  return run(['drawingDrafts'], 'readonly', (transaction) =>
    transaction.objectStore('drawingDrafts').get(key)
  );
}

export function saveLocalDrawingDraft(draft: LocalDrawingDraft): Promise<void> {
  return run(['drawingDrafts'], 'readwrite', (transaction) => {
    transaction.objectStore('drawingDrafts').put(draft);
  });
}

export function deleteLocalDrawingDraft(key: string): Promise<void> {
  return run(['drawingDrafts'], 'readwrite', (transaction) => {
    transaction.objectStore('drawingDrafts').delete(key);
  });
}

/** Gives the drawing drafts to `owner` (none: signed out): another account's,
 * or anyone's once signed out, are deleted first, in one transaction. A
 * draft holds a student's answer, so it never outlives its account here. */
export function claimLocalDrawingDrafts(owner: string | null): Promise<void> {
  return run(['meta', 'drawingDrafts'], 'readwrite', (t) => {
    const meta = t.objectStore('meta');
    meta.get('drawingDraftsOwner').onsuccess = (event) => {
      if (owner && (event.target as IDBRequest).result === owner) return;
      t.objectStore('drawingDrafts').clear();
      if (owner) meta.put(owner, 'drawingDraftsOwner');
      else meta.delete('drawingDraftsOwner');
    };
  });
}
