import { USE_MSW } from '@/api/auth';
import type { Question, SrsState } from '@/api/types';
import type { Answers } from '@/features/quizzes/grade';
import type { SrsRating } from '@/lib/srs';

/**
 * Browser-local study data for signed-out visitors: quiz attempts and
 * flashcard reviews on shared standalone materials. Nothing here reaches the
 * server or is imported into an account on sign-in. Later offline work adds
 * stores in new database versions.
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

const VERSION = 1;

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
    request.onupgradeneeded = () => {
      const database = request.result;
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
