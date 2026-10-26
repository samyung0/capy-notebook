import { type RefObject, useSyncExternalStore } from 'react';

/** What the opened workspace page shows on the tour's request. */
export type TourPanels = {
  /** The right panel on Files. */
  showFiles: () => void;
  /** The left panel on Chats. */
  showChats: () => void;
};

/** The running tour: the workspace it walks through. */
type Running = { workspaceId: string };

let running: Running | null = null;
let panels: RefObject<TourPanels | null> | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function startTour(workspaceId: string) {
  running = { workspaceId };
  emit();
}

export function stopTour() {
  running = null;
  emit();
}

export function useRunningTour(): Running | null {
  return useSyncExternalStore(
    subscribe,
    () => running,
    () => null
  );
}

/** The opened workspace page hands the tour its panels while it is mounted. */
export function registerTourPanels(ref: RefObject<TourPanels | null>) {
  panels = ref;
  return () => {
    if (panels === ref) panels = null;
  };
}

export function tourPanels(): TourPanels | null {
  return panels?.current ?? null;
}
