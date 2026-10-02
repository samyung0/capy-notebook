import { lazyRouteComponent, Outlet } from '@tanstack/react-router';
import { AnalyticsRoot } from './AnalyticsRoot';
import { AppShell } from './AppShell';
import { AuthGate, SessionSwitch } from './AuthProvider';

const SharedQuiz = lazyRouteComponent(
  () => import('@/routes/QuizAttempt'),
  'SharedQuizAttempt'
);
const SharedFlashcards = lazyRouteComponent(
  () => import('@/routes/FlashcardStudy')
);
const AnonymousFlashcards = lazyRouteComponent(
  () => import('@/routes/AnonymousFlashcardStudy'),
  'AnonymousFlashcardStudyRoute'
);
export function RootRoute() {
  return (
    <>
      <AnalyticsRoot />
      <Outlet />
      {/* <TanStackRouterDevtools /> */}
    </>
  );
}

export function AuthShellRoute() {
  return (
    <AuthGate>
      <AppShell />
    </AuthGate>
  );
}

/** Shared links open signed in or out; signed-out visitors study locally. */
export function SharedQuizRoute() {
  return <SharedQuiz />;
}

export function SharedFlashcardsRoute() {
  return (
    <SessionSwitch
      anonymous={<AnonymousFlashcards />}
      signedIn={<SharedFlashcards />}
    />
  );
}
