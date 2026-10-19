import { useSyncExternalStore } from 'react';

/**
 * Whether this tab holds back collaboration messages (Epo 2026-10-18): the
 * socket's frames wait for the update allowance, an update's pieces wait for
 * the server's acknowledgement, a draft send waits for the allowance, or the
 * user is in a timeout and the rooms resync after it. Meanwhile every editor
 * shows a loading state and takes no edits (`CollaborationHold`).
 */
const holders = new Set<object>();
const listeners = new Set<() => void>();

/** `holder` holds the tab back (or no longer does). */
export function setHeld(holder: object, held: boolean) {
  if (held === holders.has(holder)) return;
  if (held) holders.add(holder);
  else holders.delete(holder);
  for (const listener of [...listeners]) listener();
}

export function isHeld() {
  return holders.size > 0;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCollaborationHeld() {
  return useSyncExternalStore(subscribe, isHeld, () => false);
}
