import { type FetchStatus, onlineManager } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

function subscribe(onStoreChange: () => void) {
  return onlineManager.subscribe(onStoreChange);
}

function getSnapshot() {
  return onlineManager.isOnline();
}

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}

/** Whether a query shows the waiting state (`QueryPausedState`): its fetch
 * waits for the connection and it holds no data yet. A page or list holding
 * data keeps showing it while its refetch waits (Epo 2026-10-17). */
export function waitsForConnection(
  fetchStatus: FetchStatus,
  data: unknown
): boolean {
  return fetchStatus === 'paused' && data === undefined;
}
