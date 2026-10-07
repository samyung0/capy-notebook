import { lazy, Suspense } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { USE_MSW } from '@/api/auth';
import { AppToaster } from '@/components/app/AppToaster';
import { StudyPage, type StudyState } from './StudyPage';
import { settleSession } from './session';

/* A shared quiz or flashcard set: hydrate the Worker's HTML, then load Clerk
   only to learn whether the visitor is signed in, which decides where an
   attempt or a rating is saved (session.ts). */

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as
  | string
  | undefined;
const ShareAuth = lazy(() => import('./ShareAuth'));

export async function hydrateStudy(state: StudyState) {
  if (USE_MSW) {
    const { startMockServer } = await import('@/mocks/browser');
    await startMockServer();
  }
  // Hydrate at once: a click before then is lost.
  hydrateRoot(document.getElementById('root')!, <StudyPage state={state} />);

  const extras = document.body.appendChild(document.createElement('div'));
  // MSW and key-less local runs have no session: `?anonymous` picks the
  // signed-out path there.
  const withClerk = !USE_MSW && PUBLISHABLE_KEY;
  if (!withClerk)
    settleSession(
      !new URLSearchParams(window.location.search).has('anonymous')
    );
  createRoot(extras).render(
    <>
      <AppToaster />
      {withClerk && (
        <Suspense fallback={null}>
          <ShareAuth publishableKey={PUBLISHABLE_KEY} />
        </Suspense>
      )}
    </>
  );
}
