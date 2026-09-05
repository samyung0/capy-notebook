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
