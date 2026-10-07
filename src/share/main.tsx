import { QueryClientProvider } from '@tanstack/react-query';
import {
  Component,
  lazy,
  type ReactNode,
  StrictMode,
  Suspense,
  useEffect,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import { USE_MSW } from '@/api/auth';
import { queryClient } from '@/api/queryClient';
import { AppToaster } from '@/components/app/AppToaster';
import { PublicPage } from '@/components/app/PublicHeader';
import { Skeleton } from '@/components/ui/feedback';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { getLocale } from '@/i18n';
import {
  initErrorReporting,
  reportReactError,
  trackPageView,
} from '@/lib/observability';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { ShareError } from './ShareError';
import { settleSession } from './session';
import '@/styles/tailwind.css';

/* Public `/share/*` pages: their own entry, without the app's router, shell or
   session gate, so a visitor downloads only the page. The path is
   `/share/{quizzes|flashcards|notes}/{token}`, the token `{id}.{signature}`. */

initErrorReporting();
document.documentElement.lang = getLocale();

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as
  | string
  | undefined;
const ShareAuth = lazy(() => import('./ShareAuth'));

const [, , kind, token = ''] = window.location.pathname.split('/');
// Only the visited page's code loads: a quiz never fetches the note renderer.
const pages = {
  flashcards: {
    load: () =>
      import('./SharedFlashcards').then((mod) => ({
        default: mod.SharedFlashcards,
      })),
    route: '$flashcardSetId',
  },
  notes: {
    load: () =>
      import('./SharedNote').then((mod) => ({ default: mod.SharedNote })),
    route: '$noteId',
  },
  quizzes: {
    load: () =>
      import('./SharedQuiz').then((mod) => ({ default: mod.SharedQuiz })),
    route: '$quizId',
  },
} as const;
const page = kind in pages ? pages[kind as keyof typeof pages] : undefined;
// Started now, so the page's code downloads alongside React rather than after.
const loading = page?.load();
const Page = loading && lazy(() => loading);

// MSW and key-less local runs have no session: `?anonymous` picks the
// signed-out path there.
if (USE_MSW || !PUBLISHABLE_KEY)
  settleSession(!new URLSearchParams(window.location.search).has('anonymous'));

/** Clerk loads after first paint and only settles the session. */
function DeferredAuth() {
  const [painted, setPainted] = useState(false);
  useEffect(() => setPainted(true), []);
  if (!painted || USE_MSW || !PUBLISHABLE_KEY) return null;
  return (
    <Suspense fallback={null}>
      <ShareAuth publishableKey={PUBLISHABLE_KEY} />
    </Suspense>
  );
}

// biome-ignore lint/style/useReactFunctionComponents: React error boundaries require a class.
class PageBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <ShareError status={503} />
    ) : (
      this.props.children
    );
  }
}

async function enableMocks() {
  if (!USE_MSW) return;
  const { startMockServer } = await import('@/mocks/browser');
  await startMockServer();
}

if (page) trackPageView(`/share/${kind}/${page.route}`);

enableMocks().finally(() => {
  createRoot(document.getElementById('root')!, {
    onCaughtError: reportReactError,
    onUncaughtError: reportReactError,
  }).render(
    <StrictMode>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <PageBoundary>
              {Page ? (
                <Suspense
                  fallback={
                    <PublicPage>
                      <Skeleton className="h-[60vh] w-full" />
                    </PublicPage>
                  }
                >
                  <Page token={token} />
                </Suspense>
              ) : (
                <ShareError status={404} />
              )}
            </PageBoundary>
          </TooltipProvider>
          <AppToaster />
          <DeferredAuth />
        </QueryClientProvider>
      </ThemeProvider>
    </StrictMode>
  );
});
