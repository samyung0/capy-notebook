import { create } from 'zustand';
import { PREF_KEYS, readPref, writePref } from '@/lib/localPrefs';

/** A chosen file, by its upload's row until it has an id. */
export interface WaitingFile {
  fileId?: string;
  key: string;
  name: string;
}

/** Files still reading when Continue was pressed (Epo 2026-11-05, "upload might take a
 * while"): the dialog has closed, and the panel follows them until the pages can open. */
export interface QuizWait {
  announced: boolean;
  answers: WaitingFile[];
  id: string;
  paper: WaitingFile[];
  title: string;
  workspaceId: string;
}

interface StoredWaits {
  owner: string | null;
  waits: QuizWait[];
}

function isStoredWaits(value: unknown): value is StoredWaits {
  if (typeof value !== 'object' || value === null) return false;
  const { owner, waits } = value as Partial<StoredWaits>;
  return (
    (owner === null || typeof owner === 'string') &&
    Array.isArray(waits) &&
    waits.every(
      (wait) => Array.isArray(wait?.paper) && Array.isArray(wait?.answers)
    )
  );
}

const stored = readPref(
  PREF_KEYS.quizWaits,
  { owner: null, waits: [] },
  isStoredWaits
);
let owner = stored.owner;

/** Kept in this browser, so a reload finds them (Epo 2026-11-05): the ids go in as soon as
 * they are known, and the files' statuses come from the server. */
export const useQuizWaits = create<{ waits: QuizWait[] }>(() => ({
  waits: stored.waits,
}));
useQuizWaits.subscribe(({ waits }) =>
  writePref(PREF_KEYS.quizWaits, { owner, waits })
);

/** Runs when the signed-in account is known: another account's file names go. */
export function claimQuizWaits(next: string | null) {
  if (owner === next) return;
  owner = next;
  useQuizWaits.setState({ waits: [] });
}
