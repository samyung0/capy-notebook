import { type RefObject, useSyncExternalStore } from 'react';
import { PREF_KEYS } from '@/lib/localPrefs';

/** What the opened workspace page shows on the tour's request. */
export type TourPanels = {
  /** The right panel on Files. */
  showFiles: () => void;
  /** The left panel on Chats. */
  showChats: () => void;
  /** The panels as their stored preferences say, once the tour put them
   * back. */
  restore: () => void;
};

/** The running tour: the workspace it walks through. */
type Running = { workspaceId: string };

let running: Running | null = null;
// The workspace panel preferences the tour changes, as they were before it:
// a panel the viewer kept closed is closed again when it stops (Epo
// 2026-10-29).
const PANEL_PREFS = [
  PREF_KEYS.leftPanel,
  PREF_KEYS.leftView,
  PREF_KEYS.rightPanel,
  PREF_KEYS.rightView,
];
let panelsBefore: (string | null)[] = [];
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
  if (!running) panelsBefore = PANEL_PREFS.map(readRaw);
  running = { workspaceId };
  emit();
}

export function stopTour() {
  if (!running) return;
  for (const [i, key] of PANEL_PREFS.entries())
    writeRaw(key, panelsBefore[i] ?? null);
  panels?.current?.restore();
  running = null;
  emit();
}

function readRaw(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // per-viewer convenience only
  }
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
