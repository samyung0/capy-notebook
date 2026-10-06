import { USE_MSW } from '@/api/auth';
import type { EditorAssetPurpose } from '@/api/editorAssets';
import type { Question } from '@/api/types';
import type { Answers } from '@/features/quizzes/grade';
import type { SrsRating } from '@/lib/srs';
import type { SrsState } from './srs';

/**
 * Browser-local data: signed-out visitors' quiz attempts and flashcard reviews
 * on shared standalone materials (never sent to the server or imported into an
 * account on sign-in), and the bytes of editor assets a note editor session
 * removed (`keptAssets`). Later offline work adds stores in new database
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

/** An editor asset's bytes, kept when a local edit removed it from a note so
 * that session's undo, redo or paste can upload it again after the server
 * deleted it. Rows live as long as the session (the editor mount). */
export interface KeptAsset {
  assetId: string;
  /** Its type is the asset's content type. */
  blob: Blob;
  name: string;
  purpose: EditorAssetPurpose;
  savedAt: number;
  session: string;
}

/** The most kept bytes across sessions; the oldest rows go first. */
export const KEPT_ASSET_BYTES = 500 * 1024 * 1024;

const VERSION = 2;

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
      if (oldVersion < 2) {
        const kept = database.createObjectStore('keptAssets', {
          keyPath: ['session', 'assetId'],
        });
        kept.createIndex('session', 'session');
        kept.createIndex('savedAt', 'savedAt');
      }
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

/** A random id for anonymous usage reporting, created on first use. It never
 * identifies anyone beyond this browser profile. */
export async function anonymousId(): Promise<string> {
  const existing = await run<string | undefined>(['meta'], 'readonly', (t) =>
    t.objectStore('meta').get('anonymousId')
  );
  if (existing) return existing;
  const id = crypto.randomUUID();
  await run(['meta'], 'readwrite', (t) => {
    t.objectStore('meta').put(id, 'anonymousId');
  });
  return id;
}

/** Store a removed asset's bytes, then drop the oldest rows past
 * KEPT_ASSET_BYTES. A single asset over the cap is not kept. */
export function keepAsset(row: KeptAsset): Promise<void> {
  if (row.blob.size > KEPT_ASSET_BYTES) return Promise.resolve();
  return run(['keptAssets'], 'readwrite', (t) => {
    const store = t.objectStore('keptAssets');
    store.put(row);
    let total = 0;
    const cursor = store.index('savedAt').openCursor(null, 'prev');
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) return;
      total += (current.value as KeptAsset).blob.size;
      if (total > KEPT_ASSET_BYTES) current.delete();
      current.continue();
    };
  });
}

export function keptAsset(
  session: string,
  assetId: string
): Promise<KeptAsset | undefined> {
  return run(['keptAssets'], 'readonly', (t) =>
    t.objectStore('keptAssets').get([session, assetId])
  );
}

/** Delete the rows of every session `alive` rejects. */
export function dropKeptAssets(alive: (session: string) => boolean) {
  return run(['keptAssets'], 'readwrite', (t) => {
    const store = t.objectStore('keptAssets');
    const cursor = store.index('session').openKeyCursor();
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) return;
      if (!alive(String(current.key))) store.delete(current.primaryKey);
      current.continue();
    };
  });
}
