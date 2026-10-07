import { StrictMode, useEffect } from 'react';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { SharedFlashcards } from './SharedFlashcards';
import { SharedQuiz } from './SharedQuiz';
import type { ShareState } from './state';

export type StudyState = Exclude<ShareState, { kind: 'notes' }>;

/** A shared quiz or flashcard set as the Worker renders it and the browser
 * hydrates it: the same tree on both sides. */
export function StudyPage({ state }: { state: StudyState }) {
  // Answers and ratings work from here on (e2e waits for it).
  useEffect(() => {
    document.documentElement.dataset.hydrated = '';
  }, []);
  return (
    <StrictMode>
      <TooltipProvider>
        {state.kind === 'quizzes' ? (
          <SharedQuiz quiz={state.quiz} token={state.token} />
        ) : (
          <SharedFlashcards set={state.set} token={state.token} />
        )}
      </TooltipProvider>
    </StrictMode>
  );
}
