import type { Hocuspocus } from '@hocuspocus/server';

/** Waits for extension hooks and queued app saves, not just the database call. */
export async function flushRoomStores(
  host: Hocuspocus,
  room: string,
  waitForStores: (room: string) => Promise<void>,
  timeoutMs: number
) {
  const key = `onStoreDocument-${room}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await host.debouncer.executeNow(key);
    await waitForStores(room);
    const document = host.documents.get(room);
    if (
      !host.debouncer.isDebounced(key) &&
      !host.debouncer.isCurrentlyExecuting(key) &&
      !document?.saveMutex.isLocked()
    ) {
      return;
    }
    if (Date.now() >= deadline)
      throw new Error(
        'collaboration store hooks did not finish before eviction'
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Coordinates local room eviction without conflating separate later events. */
export class RoomEvictionCoordinator {
  private readonly completionTtlMs: number;
  private readonly completed = new Map<string, number>();
  private readonly now: () => number;
  private readonly operations = new Map<string, Promise<void>>();
  private readonly rooms = new Map<string, Promise<void>>();

  constructor(completionTtlMs: number, now: () => number = Date.now) {
    this.completionTtlMs = completionTtlMs;
    this.now = now;
  }

  async run(
    room: string,
    operationId: string | undefined,
    action: () => Promise<void>
  ): Promise<void> {
    this.pruneCompleted();
    if (operationId && this.completed.has(operationId)) return;
    const sameOperation = operationId
      ? this.operations.get(operationId)
      : undefined;
    if (sameOperation) return sameOperation;

    const activeRoom = this.rooms.get(room);
    if (activeRoom) {
      await activeRoom;
      // A separate event for the same room still has to run. In particular, a
      // destructive ACL reset must not be mistaken for the compaction drain it
      // happened to overlap.
      return this.run(room, operationId, action);
    }

    const eviction = action();
    this.rooms.set(room, eviction);
    if (operationId) this.operations.set(operationId, eviction);
    try {
      await eviction;
      if (operationId) {
        this.completed.set(operationId, this.now() + this.completionTtlMs);
      }
    } finally {
      if (this.rooms.get(room) === eviction) this.rooms.delete(room);
      if (operationId && this.operations.get(operationId) === eviction) {
        this.operations.delete(operationId);
      }
    }
  }

  private pruneCompleted() {
    const now = this.now();
    for (const [operationId, expiresAt] of this.completed) {
      if (expiresAt <= now) this.completed.delete(operationId);
    }
  }
}

export type RoomEvictionMode = 'discard' | 'drain';

export function parseRoomEvictionMode(value: unknown): RoomEvictionMode {
  return value === 'drain' ? 'drain' : 'discard';
}

export function shouldCloseUserConnections(value: unknown) {
  return parseRoomEvictionMode(value) === 'discard';
}

export function shouldPreserveMaterialConnections(
  eventType: unknown,
  mode: unknown
) {
  return (
    eventType === 'account-access-restored' &&
    parseRoomEvictionMode(mode) === 'drain'
  );
}

export function drainIsDurable(
  initialFailureGeneration: number,
  currentFailureGeneration: number,
  hasFailedSnapshot: boolean
) {
  return (
    !hasFailedSnapshot && initialFailureGeneration === currentFailureGeneration
  );
}

/** Keeps destructive resets separate from compaction's durability drain. */
export class RoomEvictionState {
  private readonly discarding = new Set<string>();
  private readonly draining = new Set<string>();
  private readonly rejected = new Set<string>();

  begin(room: string, mode: RoomEvictionMode) {
    this.rooms(mode).add(room);
  }

  end(room: string, mode: RoomEvictionMode) {
    this.rooms(mode).delete(room);
  }

  blocks(room: string, storeCallback = false) {
    return (
      this.rejected.has(room) ||
      this.discarding.has(room) ||
      (!storeCallback && this.draining.has(room))
    );
  }

  accept(room: string) {
    this.rejected.delete(room);
  }

  isRejected(room: string) {
    return this.rejected.has(room);
  }

  reject(room: string) {
    this.rejected.add(room);
  }

  isDiscarding(room: string) {
    return this.discarding.has(room);
  }

  isDraining(room: string) {
    return this.draining.has(room);
  }

  private rooms(mode: RoomEvictionMode) {
    return mode === 'drain' ? this.draining : this.discarding;
  }
}

/**
 * Evicts the room named by an outbox event and follows any compaction epochs
 * that become current before delivery finishes.
 */
export async function evictMaterialRoomEpoch(options: {
  currentRoom: () => Promise<string | null>;
  evict: (room: string) => Promise<void>;
  initialRoom: string;
  waitForTransition: (room: string) => Promise<void>;
}) {
  let room = options.initialRoom;
  for (;;) {
    await options.waitForTransition(room);
    await options.evict(room);
    await options.waitForTransition(room);
    const current = await options.currentRoom();
    if (!current || current === room) return;
    room = current;
  }
}

/**
 * Unloads a room. Hocuspocus skips the unload while a save or a connection is
 * still there, and one admitted before the eviction can land late, so until
 * `deadline` this closes, flushes and unloads again; past it, a room still
 * loaded throws.
 */
export async function unloadRoom<T>(options: {
  close: () => void;
  deadline: number;
  flush: () => Promise<unknown>;
  loaded: () => T | undefined;
  unload: (document: T) => Promise<unknown>;
  pauseMs?: number;
}) {
  for (;;) {
    const loaded = options.loaded();
    if (!loaded) return;
    await options.unload(loaded);
    if (!options.loaded()) return;
    if (Date.now() >= options.deadline)
      throw new Error('collaboration document remained loaded after eviction');
    options.close();
    await options.flush();
    await new Promise((resolve) => setTimeout(resolve, options.pauseMs ?? 250));
  }
}
