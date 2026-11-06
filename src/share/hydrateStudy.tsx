import type { ReactNode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { USE_MSW } from '@/api/auth';
import { AppToaster } from '@/components/app/AppToaster';
import { StudyPage } from './StudyPage';

/* A shared quiz or flashcard set (`page`, from hydrateQuiz.tsx or
   hydrateFlashcards.tsx): hydrate the Worker's HTML. No Clerk: nothing here reads
   the session, and a visitor's events go unidentified, as on a shared note (Epo
   2026-11-06, Q668). */

export async function hydrateStudy(page: ReactNode) {
  if (USE_MSW) {
    const { startMockServer } = await import('@/mocks/browser');
    await startMockServer();
  }
  // Hydrate at once: a click before then is lost.
  hydrateRoot(document.getElementById('root')!, <StudyPage>{page}</StudyPage>);

  const extras = document.body.appendChild(document.createElement('div'));
  createRoot(extras).render(<AppToaster />);
}
