import { create } from 'zustand';
import { PREF_KEYS } from '@/lib/localPrefs';
import type { MakeQuizChoice } from './MakeQuizDialog';
import { savedForAccount } from './savedForAccount';

/** A run the panel follows, with what it needs to start over. */
export interface QuizRun extends MakeQuizChoice {
  id: string;
  workspaceId: string;
}

function isSavedRuns(value: unknown): value is { runs: QuizRun[] } {
  const runs = (value as { runs?: QuizRun[] } | null)?.runs;
  return (
    Array.isArray(runs) &&
    runs.every((run) => typeof run?.id === 'string' && Array.isArray(run.paper))
  );
}

/** Runs collapsed into the upload panel once their questions were confirmed. They
 * outlive the page that started them, and a reload (Epo 2026-11-05): only which runs
 * stays in this browser, and how far each has got comes from the server. Closing the
 * panel only stops following them. */
const saved = savedForAccount(
  PREF_KEYS.quizRuns,
  { runs: [] as QuizRun[] },
  isSavedRuns
);
export const useQuizRuns = saved.store;
export const claimQuizRuns = saved.claim;

export function addQuizRun(run: QuizRun) {
  useQuizRuns.setState((state) => ({ runs: [...state.runs, run] }));
}

export function forgetQuizRun(id: string) {
  useQuizRuns.setState((state) => ({
    runs: state.runs.filter((run) => run.id !== id),
  }));
}

export function dismissQuizRuns() {
  useQuizRuns.setState({ runs: [] });
}

export function isPanelRun(id: string) {
  return useQuizRuns.getState().runs.some((run) => run.id === id);
}

/** Counts the links that reopened the dialog. One already open read its files when it
 * opened, so it starts again for these. */
export const useQuizDialogKey = create<{ key: number }>(() => ({ key: 0 }));
export function nextQuizDialog() {
  useQuizDialogKey.setState(({ key }) => ({ key: key + 1 }));
}

/** Where a run's links go: the router lives above the panel, which stays outside it. */
export interface QuizRunLinks {
  openQuiz: (workspaceId: string, quizId: string) => void;
  /** To its pages, or to the files when `step` says so. */
  pickAgain: (run: QuizRun & { step?: 'files' }) => void;
  review: (workspaceId: string, runId: string) => void;
}

let links: QuizRunLinks | undefined;
export function setQuizRunLinks(next: QuizRunLinks) {
  links = next;
}
export const quizRunLinks = () => links;
