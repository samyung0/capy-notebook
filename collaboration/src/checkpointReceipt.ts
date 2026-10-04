import type { Hocuspocus } from '@hocuspocus/server';
import type * as Y from 'yjs';
import { hasPendingContributors } from './contributors.js';
import type { MaterialDocumentMetrics, MaterialLimitCode } from './limits.js';

interface StatelessBroadcaster {
  broadcastStateless: (payload: string) => void;
}

interface PersistedCheckpoint {
  limitCode: MaterialLimitCode | null;
  metrics: MaterialDocumentMetrics;
  version: number;
}

export function broadcastCheckpointPersisted(
  document: StatelessBroadcaster,
  pending: Set<string> | undefined,
  claimed: readonly string[],
  materialId: string,
  stored: PersistedCheckpoint
) {
  const checkpointIds = pending
    ? claimed.filter((id) => pending.delete(id))
    : [];
  document.broadcastStateless(
    JSON.stringify({
      checkpointIds,
      limitCode: stored.limitCode,
      materialId,
      metrics: stored.metrics,
      type: 'checkpoint-persisted',
      yjsVersion: stored.version,
    })
  );
}

/**
 * Registers a checkpoint request's receipt id for the room's next store. A
 * full set is drained first when the room can persist now (a source room's
 * idle receipts wait for its debounced store); otherwise the request is
 * refused (false).
 */
export async function registerCheckpointRequest(
  receipts: Map<string, Set<string>>,
  room: string,
  id: string,
  max: number,
  drain?: () => Promise<unknown>
) {
  if (drain && (receipts.get(room)?.size ?? 0) >= max)
    await drain().catch(() => undefined);
  let pending = receipts.get(room);
  if (!pending) {
    pending = new Set();
    receipts.set(room, pending);
  }
  if (pending.size >= max) return false;
  pending.add(id);
  return true;
}

/**
 * Whether a material room has nothing waiting to be saved, so a checkpoint
 * request can be answered at once: no store debounced or running, no failed
 * snapshot to retry, and no writer's update newer than the last durable
 * state (a store clears the contributor markers it saved). A store only runs
 * after a change, so without this a request that adds nothing (a reopened
 * note's restored edits the room already holds) would never be answered.
 */
export function nothingToStore(
  host: Pick<Hocuspocus, 'debouncer'>,
  document: Y.Doc & { name: string; saveMutex?: { isLocked(): boolean } },
  failedSnapshot: boolean
) {
  const key = `onStoreDocument-${document.name}`;
  return (
    !failedSnapshot &&
    !host.debouncer.isDebounced(key) &&
    !host.debouncer.isCurrentlyExecuting(key) &&
    !document.saveMutex?.isLocked() &&
    !hasPendingContributors(document)
  );
}

/** The receipt for a request with nothing to save: no metrics (the editor
 * keeps the ones it shows), only the ids it answers. */
export function nothingToStoreReceipt(materialId: string, id: string) {
  return JSON.stringify({
    checkpointIds: [id],
    materialId,
    type: 'checkpoint-persisted',
  });
}
