import { SOURCE_ROOM_PATTERN } from './auth.js';
import { captureError, withEventId } from './observability.js';
export interface FailedStoreSnapshot {
  checkpointIds: readonly string[];
  /** Office engine timeouts and worker losses in a row on this room. */
  engineFailures?: number;
  eventId?: string;
  state: Uint8Array;
}

type RetryFailedStore = (
  room: string,
  snapshot: FailedStoreSnapshot,
  clearIfCurrent: () => boolean
) => Promise<void>;

// A room's retries back off from 5 s, doubling, up to 60 s.
export const RETRY_FIRST_MS = 5000;
export const RETRY_MAX_MS = 60_000;

/**
 * Runs one failed-store retry pass at a time, each room on its own backoff,
 * and fences queue cleanup.
 */
export class FailedStoreRetryRunner {
  private readonly failedStores: Map<string, FailedStoreSnapshot>;
  private readonly retry: RetryFailedStore;
  private readonly now: () => number;
  private readonly backoff = new Map<string, { delay: number; due: number }>();
  private running = false;

  constructor(
    failedStores: Map<string, FailedStoreSnapshot>,
    retry: RetryFailedStore,
    now: () => number = Date.now
  ) {
    this.failedStores = failedStores;
    this.retry = retry;
    this.now = now;
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      for (const room of this.backoff.keys())
        if (!this.failedStores.has(room)) this.backoff.delete(room);
      for (const [room, snapshot] of this.failedStores) {
        // First seen: retried on this pass (the store failed up to one tick
        // ago), then after 5, 10, 20, 40 and 60 s.
        const wait = this.backoff.get(room) ?? {
          delay: RETRY_FIRST_MS / 2,
          due: this.now(),
        };
        this.backoff.set(room, wait);
        if (this.now() < wait.due) continue;
        await this.retry(room, snapshot, () =>
          this.clearIfCurrent(room, snapshot)
        );
        if (this.failedStores.has(room)) {
          wait.delay = Math.min(wait.delay * 2, RETRY_MAX_MS);
          wait.due = this.now() + wait.delay;
        } else this.backoff.delete(room);
      }
    } finally {
      this.running = false;
    }
  }

  private clearIfCurrent(room: string, snapshot: FailedStoreSnapshot) {
    if (this.failedStores.get(room) !== snapshot) return false;
    return this.failedStores.delete(room);
  }
}

export function reportFailedStore(
  previous: FailedStoreSnapshot | undefined,
  error: unknown,
  room: string
): string | undefined {
  if (previous) {
    withEventId(error, previous.eventId);
    return previous.eventId;
  }
  return captureError(error, {
    room,
    stage: SOURCE_ROOM_PATTERN.test(room) ? 'source_store' : 'document_store',
  });
}
