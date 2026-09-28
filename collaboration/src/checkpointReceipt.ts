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
