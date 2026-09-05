export interface FailedStoreSnapshot {
  checkpointIds: readonly string[];
  state: Uint8Array;
}

type RetryFailedStore = (
  room: string,
  snapshot: FailedStoreSnapshot,
  clearIfCurrent: () => boolean
) => Promise<void>;

/** Runs one failed-store retry pass at a time and fences queue cleanup. */
export class FailedStoreRetryRunner {
  private readonly failedStores: Map<string, FailedStoreSnapshot>;
  private readonly retry: RetryFailedStore;
  private running = false;

  constructor(
    failedStores: Map<string, FailedStoreSnapshot>,
    retry: RetryFailedStore
  ) {
    this.failedStores = failedStores;
    this.retry = retry;
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      for (const [room, snapshot] of this.failedStores) {
        await this.retry(room, snapshot, () =>
          this.clearIfCurrent(room, snapshot)
        );
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
