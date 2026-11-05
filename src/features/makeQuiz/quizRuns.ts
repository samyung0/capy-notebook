import { create } from 'zustand';
import type { MakeQuizChoice } from './MakeQuizDialog';

/** A run the panel follows, with what it needs to start over. */
export interface QuizRun extends MakeQuizChoice {
  id: string;
  workspaceId: string;
}

interface QuizRunState {
  runs: QuizRun[];
}

/** Runs collapsed into the upload panel once their questions were confirmed. They
 * outlive the page that started them; closing the panel only hides them. */
export const useQuizRuns = create<QuizRunState>(() => ({ runs: [] }));

export function addQuizRun(run: QuizRun) {
  useQuizRuns.setState((state) => ({ runs: [...state.runs, run] }));
}

export function dismissQuizRuns() {
  useQuizRuns.setState({ runs: [] });
}

export function isPanelRun(id: string) {
  return useQuizRuns.getState().runs.some((run) => run.id === id);
}

/** Where a run's links go: the router lives above the panel, which stays outside it. */
export interface QuizRunLinks {
  openQuiz: (workspaceId: string, quizId: string) => void;
  pickAgain: (run: QuizRun) => void;
  review: (workspaceId: string, runId: string) => void;
}

let links: QuizRunLinks | undefined;
export function setQuizRunLinks(next: QuizRunLinks) {
  links = next;
}
export const quizRunLinks = () => links;
