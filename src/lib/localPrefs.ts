import { useState } from 'react';

/**
 * Display preferences one viewer keeps in this browser: list or grid views,
 * list sorts, the workspace's side panels, which chapters are open. localStorage rather than
 * IndexedDB because the first render reads them synchronously, so nothing
 * flashes from the default. Values are JSON. Storage can be blocked (private
 * windows); reads then give the fallback and writes are dropped.
 *
 * Every key lives here so the stored set stays in one place.
 */
export const PREF_KEYS = {
  filesView: 'capy.files.view',
  /** The flashcard run this browser continues: its attempt and each card's
   * ratings (flashcardRun.ts), per signed-in user on the app page (another
   * account on the same browser starts its own) and apart on share pages. */
  flashcardRun: (owner: string, setId: string) =>
    `capy.flashcardRun.${owner}.${setId}`,
  /** The Get started list, written only by the browser that ran onboarding
   * (gettingStarted.ts). */
  gettingStarted: 'capy.gettingStarted',
  /** The opened workspace's left panel (chats and files) is open. */
  leftPanel: 'capy.workspace.leftPanel',
  /** The view the left panel shows: Chats, Files or Study. */
  leftView: 'capy.workspace.leftView',
  /** Progress maps whose finish animation has played: `topic:<id>:<count>`, `workspace:<id>:<count>`. */
  mapFinishPlayed: 'capy.map.finishPlayed',
  /** A note's toolbar is shown in Edit (Q461; no key: hidden). */
  noteToolbar: 'capy.note.toolbar',
  openChapters: (workspaceId: string) =>
    `capy.workspace.openChapters.${workspaceId}`,
  /** A Quick review batch: its items, when it began, which are done; per
   * workspace, or `plan-<id>` per plan. */
  quickReview: (scope: string) => `capy.quickReview.${scope}`,
  /** The quiz attempt this browser continues, by its id: the account's
   * (`account`) or, signed out on a shared quiz, this browser's (`local`). */
  quizAttempt: (owner: 'account' | 'local', quizId: string) =>
    `capy.quizAttempt.${owner}.${quizId}`,
  recentsView: 'capy.recents.view',
  /** The opened workspace's right panel (Files, Chat, Study) is open. */
  rightPanel: 'capy.workspace.rightPanel',
  /** The view the right panel shows: Files, Chat or Study. */
  rightView: 'capy.workspace.rightView',
  /** When each workspace, file and material open was last sent (sentOpens.ts). */
  sentOpens: 'capy.opens.sent',
  sort: (list: SortedList) => `capy.sort.${list}`,
} as const;

/** The lists whose sort menu pick is remembered. */
export type SortedList =
  | 'workspaces'
  | 'files'
  | 'blocks'
  | 'pastReviews'
  | 'results';

export function readPref<T>(
  key: string,
  fallback: T,
  isValid: (value: unknown) => value is T
): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const value: unknown = JSON.parse(raw);
    return isValid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

/** A preference stored under `key`; a new key (another workspace) re-reads. */
export function useLocalPref<T>(
  key: string,
  fallback: T,
  isValid: (value: unknown) => value is T
): [T, (next: T) => void] {
  const [state, setState] = useState(() => ({
    key,
    value: readPref(key, fallback, isValid),
  }));
  let { value } = state;
  if (state.key !== key) {
    value = readPref(key, fallback, isValid);
    setState({ key, value });
  }
  function change(next: T) {
    setState({ key, value: next });
    writePref(key, next);
  }
  return [value, change];
}

export function writePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // per-viewer convenience only
  }
}

export const isBoolean = (value: unknown): value is boolean =>
  typeof value === 'boolean';

export const isString = (value: unknown): value is string =>
  typeof value === 'string';
