import { type ReactNode, StrictMode, useEffect } from 'react';
import { TooltipProvider } from '@/components/ui/Tooltip';
import type { ShareState } from './state';

export type StudyState = Exclude<ShareState, { kind: 'notes' }>;

/** The frame around a shared quiz or flashcard set (`children`, SharedQuiz or
 * SharedFlashcards), as the Worker renders it and the browser hydrates it:
 * the same tree on both sides. The page passes in its own kind, so the
 * browser downloads only that kind's code. */
export function StudyPage({ children }: { children: ReactNode }) {
  // Answers and ratings work from here on (e2e waits for it).
  useEffect(() => {
    document.documentElement.dataset.hydrated = '';
  }, []);
  return (
    <StrictMode>
      <TooltipProvider>{children}</TooltipProvider>
    </StrictMode>
  );
}
