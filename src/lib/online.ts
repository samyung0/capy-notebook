import { onlineManager } from '@tanstack/react-query';
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
