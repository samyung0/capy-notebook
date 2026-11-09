import { PREF_KEYS } from '@/lib/localPrefs';
import { savedForAccount } from './savedForAccount';

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

function isSavedWaits(value: unknown): value is { waits: QuizWait[] } {
  const waits = (value as { waits?: QuizWait[] } | null)?.waits;
  return (
    Array.isArray(waits) &&
    waits.every(
      (wait) => Array.isArray(wait?.paper) && Array.isArray(wait?.answers)
    )
  );
}

/** Kept in this browser, so a reload finds them (Epo 2026-11-05): the ids go in as soon as
 * they are known, and the files' statuses come from the server. */
const saved = savedForAccount(
  PREF_KEYS.quizWaits,
  { waits: [] as QuizWait[] },
  isSavedWaits
);
export const useQuizWaits = saved.store;
export const claimQuizWaits = saved.claim;
