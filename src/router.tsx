import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
} from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';
import { USE_MSW } from '@/api/auth';
import {
  allFilesQuery,
  attemptQuery,
  attemptsQuery,
  canvasesQuery,
  canvasQuery,
  cardsQuery,
  chaptersQuery,
  conversationsQuery,
  deckQuery,
  decksQuery,
  eventsQuery,
  exploreDecksQuery,
  exploreQuizzesQuery,
  exploreWorkspacesQuery,
  filesQuery,
  labelsQuery,
  materialsQuery,
  meQuery,
  quizQuery,
  quizzesQuery,
  tasksQuery,
  workspaceQuery,
  workspacesQuery,
} from '@/api/hooks';
import { queryClient } from '@/api/queryClient';
import { AppShell } from '@/components/app/AppShell';
import { AuthGate } from '@/components/app/AuthProvider';
import { parseWorkspaceOpenSearch } from '@/features/materials/openItem';
import { features } from '@/lib/features';

interface RouterContext {
  queryClient: QueryClient;
}

/** Loader helper: prime the React Query cache during route preload (on intent),
 * so the component's `useQuery` hits a warm cache on mount instead of firing
 * the request only after render. Returns void so loaders never contribute
 * `loaderData` (the components still read via `useQuery`). */
type Loader = (args: {
  context: RouterContext;
  params: Record<string, string>;
}) => void;

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <>
      <Outlet />
      <TanStackRouterDevtools />
    </>
  ),
});

const authShellRoute = createRoute({
  component: () => (
    <AuthGate>
      <AppShell />
    </AuthGate>
  ),
  getParentRoute: () => rootRoute,
  id: 'auth-shell',
});

const page = <const T extends string>(
  path: T,
  importer: () => Promise<{ default: React.ComponentType }>,
  loader?: Loader
) =>
  createRoute({
    component: lazyRouteComponent(importer),
    getParentRoute: () => authShellRoute,
    path,
    ...(loader ? { loader } : {}),
  });

const publicRoutes = [
  createRoute({
    component: lazyRouteComponent(() => import('@/routes/WorkspaceOpen')),
    getParentRoute: () => rootRoute,
    loader: ({ context: { queryClient: qc }, params }) => {
      const id = params.workspaceId;
      qc.prefetchQuery(workspaceQuery(id));
      qc.prefetchQuery(chaptersQuery(id));
      qc.prefetchQuery(filesQuery(id));
      qc.prefetchQuery(materialsQuery(id));
    },
    path: '/share/workspaces/$workspaceId',
    validateSearch: parseWorkspaceOpenSearch,
  }),
  createRoute({
    component: lazyRouteComponent(() => import('@/routes/QuizAttempt')),
    getParentRoute: () => rootRoute,
    loader: ({ context: { queryClient: qc }, params }) =>
      qc.prefetchQuery(quizQuery(params.quizId)),
    path: '/share/quizzes/$quizId',
  }),
  createRoute({
    component: lazyRouteComponent(() => import('@/routes/DeckStudy')),
    getParentRoute: () => rootRoute,
    loader: ({ context: { queryClient: qc }, params }) => {
      qc.prefetchQuery(deckQuery(params.deckId));
      qc.prefetchQuery(cardsQuery(params.deckId));
    },
    path: '/share/decks/$deckId',
  }),
  ...(USE_MSW
    ? []
    : [
        createRoute({
          component: lazyRouteComponent(() => import('@/routes/SignIn')),
          getParentRoute: () => rootRoute,
          path: '/sign-in',
        }),
        createRoute({
          component: lazyRouteComponent(() => import('@/routes/SignUp')),
          getParentRoute: () => rootRoute,
          path: '/sign-up',
        }),
      ]),
];

const appRoutes = [
  createRoute({
    component: lazyRouteComponent(() => import('@/routes/Dashboard')),
    getParentRoute: () => authShellRoute,
    loader: ({ context: { queryClient: qc } }) => {
      qc.prefetchQuery(meQuery());
      qc.prefetchQuery(workspacesQuery({ sort: 'accessed' }));
      qc.prefetchQuery(tasksQuery());
      qc.prefetchQuery(canvasesQuery());
    },
    path: '/',
  }),
  page(
    '/workspaces',
    () => import('@/routes/Workspaces'),
    ({ context: { queryClient: qc } }) =>
      qc.prefetchQuery(
        workspacesQuery({ color: undefined, q: '', sort: 'accessed' })
      )
  ),
  createRoute({
    component: lazyRouteComponent(() => import('@/routes/WorkspaceOpen')),
    getParentRoute: () => authShellRoute,
    loader: ({ context: { queryClient: qc }, params }) => {
      const id = params.workspaceId;
      qc.prefetchQuery(workspaceQuery(id));
      qc.prefetchQuery(chaptersQuery(id));
      qc.prefetchQuery(filesQuery(id));
      qc.prefetchQuery(materialsQuery(id));
      qc.prefetchQuery(conversationsQuery(id));
    },
    path: '/workspaces/$workspaceId',
    validateSearch: parseWorkspaceOpenSearch,
  }),
  page(
    '/workspace-invites/$token',
    () => import('@/routes/WorkspaceInviteAccept')
  ),
  page(
    '/quizzes',
    () => import('@/routes/Quizzes'),
    ({ context: { queryClient: qc } }) => {
      qc.prefetchQuery(quizzesQuery());
      qc.prefetchQuery(attemptsQuery());
    }
  ),
  page(
    '/quizzes/$quizId/attempt',
    () => import('@/routes/QuizAttempt'),
    ({ context: { queryClient: qc }, params }) =>
      qc.prefetchQuery(quizQuery(params.quizId))
  ),
  page(
    '/quizzes/$quizId/edit',
    () => import('@/routes/QuizEdit'),
    ({ context: { queryClient: qc }, params }) =>
      qc.prefetchQuery(quizQuery(params.quizId))
  ),
  page(
    '/quizzes/attempts/$attemptId',
    () => import('@/routes/AttemptResult'),
    ({ context: { queryClient: qc }, params }) =>
      qc.prefetchQuery(attemptQuery(params.attemptId))
  ),
  createRoute({
    component: lazyRouteComponent(() => import('@/routes/Schedule')),
    getParentRoute: () => authShellRoute,
    loader: ({ context: { queryClient: qc } }) => {
      qc.prefetchQuery(eventsQuery());
      qc.prefetchQuery(labelsQuery());
    },
    path: '/schedule',
    validateSearch: (search: Record<string, unknown>): { event?: string } => ({
      event: typeof search.event === 'string' ? search.event : undefined,
    }),
  }),
  page(
    '/flashcards',
    () => import('@/routes/Flashcards'),
    ({ context: { queryClient: qc } }) => qc.prefetchQuery(decksQuery())
  ),
  page(
    '/flashcards/$deckId',
    () => import('@/routes/DeckStudy'),
    ({ context: { queryClient: qc }, params }) => {
      qc.prefetchQuery(deckQuery(params.deckId));
      qc.prefetchQuery(cardsQuery(params.deckId));
    }
  ),
  page(
    '/files',
    () => import('@/routes/Files'),
    ({ context: { queryClient: qc } }) => qc.prefetchQuery(allFilesQuery())
  ),
  page(
    '/tasks',
    () => import('@/routes/Tasks'),
    ({ context: { queryClient: qc } }) => qc.prefetchQuery(tasksQuery())
  ),
  ...(features.thinking
    ? [
        page(
          '/thinking',
          () => import('@/routes/Thinking'),
          ({ context: { queryClient: qc } }) =>
            qc.prefetchQuery(canvasesQuery())
        ),
        page(
          '/thinking/$canvasId',
          () => import('@/routes/Canvas'),
          ({ context: { queryClient: qc }, params }) =>
            qc.prefetchQuery(canvasQuery(params.canvasId))
        ),
      ]
    : []),
  ...(features.explore
    ? [
        page(
          '/explore',
          () => import('@/routes/Explore'),
          ({ context: { queryClient: qc } }) => {
            qc.prefetchQuery(exploreWorkspacesQuery());
            qc.prefetchQuery(exploreQuizzesQuery());
            qc.prefetchQuery(exploreDecksQuery());
          }
        ),
      ]
    : []),
  page('/support', () => import('@/routes/Support')),
  page('/settings', () => import('@/routes/Settings')),
  page('/profile', () => import('@/routes/Profile')),
  page(
    '/subscription',
    () => import('@/routes/Subscription'),
    ({ context: { queryClient: qc } }) => qc.prefetchQuery(meQuery())
  ),
];

const routeTree = rootRoute.addChildren([
  ...publicRoutes,
  authShellRoute.addChildren(appRoutes),
]);

export const router = createRouter({
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  routeTree,
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
