import { lazyRouteComponent, Outlet } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';
import { AnalyticsRoot } from './AnalyticsRoot';
import { AppShell } from './AppShell';
import { AuthGate } from './AuthProvider';

const SharedQuiz = lazyRouteComponent(() => import('@/routes/QuizAttempt'));
const SharedFlashcards = lazyRouteComponent(
  () => import('@/routes/FlashcardStudy')
);
export function RootRoute() {
  return (
    <>
      <AnalyticsRoot />
      <Outlet />
      <TanStackRouterDevtools />
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

export function SharedQuizRoute() {
  return (
    <AuthGate>
      <SharedQuiz />
    </AuthGate>
  );
}

export function SharedFlashcardsRoute() {
  return (
    <AuthGate>
      <SharedFlashcards />
    </AuthGate>
  );
}
