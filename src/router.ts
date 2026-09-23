import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';
import {
  attemptQuery,
  attemptsQuery,
  billingQuery,
  canvasesQuery,
  canvasQuery,
  cardsQuery,
  chaptersQuery,
  conversationsQuery,
  eventsQuery,
  exploreFlashcardSetsQuery,
  exploreQuizzesQuery,
  exploreWorkspacesQuery,
  fileQuery,
  filesQuery,
  flashcardSetQuery,
  labelsQuery,
  materialQuery,
  materialsQuery,
  meQuery,
  modelsQuery,
  ownedFilesQuery,
  ownedMaterialsQuery,
  quizQuery,
  recentFilesQuery,
  recentMaterialsQuery,
  tasksQuery,
  usageQuery,
  workspaceQuery,
  workspacesQuery,
} from '@/api/hooks';
import { queryClient } from '@/api/queryClient';
import {
  RouteErrorComponent,
  RouteNotFoundComponent,
  ShareRouteErrorComponent,
} from '@/components/app/AppErrorBoundary';
import {
  AuthShellRoute,
  RootRoute,
  SharedFlashcardsRoute,
  SharedQuizRoute,
} from '@/components/app/RouteComponents';
import { parseWorkspaceOpenSearch } from '@/features/materials/openItem';
import { parseSettingsSearch } from '@/features/settings/settingsSearch';
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
  component: RootRoute,
});

const authShellRoute = createRoute({
  component: AuthShellRoute,
  getParentRoute: () => rootRoute,
  id: 'auth-shell',
  // Every signed-in page reads /me, which also carries the account banner's
  // lifecycle. Starting it with the route, not when the shell chunk mounts,
  // puts it in the first wave on every page.
  loader: ({ context: { queryClient: qc } }) => {
    qc.prefetchQuery(meQuery());
  },
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
    // Discard whatever the loader returns: an expression-bodied
    // `() => qc.prefetchQuery(...)` hands back the prefetch promise, and the
    // router would then hold the whole branch, shell included, until it settles.
    ...(loader
      ? {
          loader: (args: Parameters<Loader>[0]) => {
            loader(args);
          },
        }
      : {}),
  });

const publicRoutes = [
  createRoute({
    component: lazyRouteComponent(
      () => import('@/routes/WorkspaceInviteAccept')
    ),
    getParentRoute: () => rootRoute,
    path: '/workspace-invites/$token',
  }),
  createRoute({
    component: SharedQuizRoute,
    errorComponent: ShareRouteErrorComponent,
    getParentRoute: () => rootRoute,
    loader: ({ context: { queryClient: qc }, params }) => {
      qc.prefetchQuery(quizQuery(params.quizId));
    },
    path: '/share/quizzes/$quizId',
  }),
  createRoute({
    component: SharedFlashcardsRoute,
    errorComponent: ShareRouteErrorComponent,
    getParentRoute: () => rootRoute,
    loader: ({ context: { queryClient: qc }, params }) => {
      qc.prefetchQuery(flashcardSetQuery(params.flashcardSetId));
      qc.prefetchQuery(cardsQuery(params.flashcardSetId));
    },
    path: '/share/flashcards/$flashcardSetId',
  }),
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
  createRoute({
    component: lazyRouteComponent(() => import('@/routes/ForgotPassword')),
    getParentRoute: () => rootRoute,
    path: '/forgot-password',
  }),
  createRoute({
    component: lazyRouteComponent(() => import('@/routes/SsoCallback')),
    getParentRoute: () => rootRoute,
    path: '/sso-callback',
  }),
];

const appRoutes = [
  createRoute({
    component: lazyRouteComponent(() => import('@/routes/Dashboard')),
    getParentRoute: () => authShellRoute,
    loader: ({ context: { queryClient: qc } }) => {
      qc.prefetchQuery(workspacesQuery({ sort: 'accessed' }));
      qc.prefetchInfiniteQuery(recentFilesQuery());
      qc.prefetchInfiniteQuery(recentMaterialsQuery());
      qc.prefetchQuery(canvasesQuery());
    },
    path: '/',
  }),
  page(
    '/workspaces',
    () => import('@/routes/Workspaces'),
    ({ context: { queryClient: qc } }) =>
      qc.prefetchQuery(workspacesQuery({ sort: 'created', tag: [] }))
  ),
  // biome-ignore assist/source/useSortedKeys: TanStack types `deps` in the loader from `loaderDeps`, which must come first.
  createRoute({
    component: lazyRouteComponent(() => import('@/routes/WorkspaceOpen')),
    getParentRoute: () => authShellRoute,
    loaderDeps: ({ search }) => ({ file: search.file }),
    loader: ({ context: { queryClient: qc }, deps, params }) => {
      const id = params.workspaceId;
      qc.prefetchQuery(workspaceQuery(id));
      qc.prefetchQuery(workspacesQuery({ sort: 'accessed' }));
      qc.prefetchQuery(chaptersQuery(id));
      qc.prefetchQuery(filesQuery(id));
      qc.prefetchQuery(materialsQuery(id));
      qc.prefetchQuery(conversationsQuery(id));
      // The open file rides the first wave instead of waiting for the page to
      // render. An open material is left out on purpose: its body is the
      // document itself, and the heavy-document gate must see the list first.
      if (deps.file) qc.prefetchQuery(fileQuery(deps.file));
    },
    path: '/workspaces/$workspaceId',
    staticData: { hideSidebar: true },
    validateSearch: parseWorkspaceOpenSearch,
  }),
  page(
    '/create',
    () => import('@/routes/Create'),
    ({ context: { queryClient: qc } }) =>
      qc.prefetchInfiniteQuery(
        ownedMaterialsQuery({ dir: 'desc', sort: 'updated' })
      )
  ),
  page(
    '/learning',
    () => import('@/routes/Learning'),
    ({ context: { queryClient: qc } }) => qc.prefetchQuery(attemptsQuery())
  ),
  createRoute({
    component: lazyRouteComponent(() => import('@/routes/MaterialOpen')),
    getParentRoute: () => authShellRoute,
    loader: ({ context: { queryClient }, params }) => {
      void queryClient.prefetchQuery(materialQuery(params.materialId));
    },
    path: '/materials/$materialId',
    validateSearch: (search: Record<string, unknown>): { mode?: 'edit' } =>
      search.mode === 'edit' ? { mode: 'edit' } : {},
  }),
  page('/files/$fileId', () => import('@/routes/MaterialOpen')),
  createRoute({
    beforeLoad: () => {
      throw redirect({ replace: true, to: '/create' });
    },
    component: () => null,
    getParentRoute: () => authShellRoute,
    path: '/quizzes',
  }),
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
    beforeLoad: () => {
      if (!features.schedule) throw redirect({ to: '/' });
    },
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
  createRoute({
    beforeLoad: () => {
      throw redirect({ replace: true, to: '/create' });
    },
    component: () => null,
    getParentRoute: () => authShellRoute,
    path: '/flashcards',
  }),
  page(
    '/flashcards/$flashcardSetId',
    () => import('@/routes/FlashcardStudy'),
    ({ context: { queryClient: qc }, params }) => {
      qc.prefetchQuery(flashcardSetQuery(params.flashcardSetId));
      qc.prefetchQuery(cardsQuery(params.flashcardSetId));
    }
  ),
  page(
    '/files',
    () => import('@/routes/Files'),
    ({ context: { queryClient: qc } }) =>
      qc.prefetchInfiniteQuery(ownedFilesQuery({ dir: 'desc', sort: 'added' }))
  ),
  createRoute({
    beforeLoad: () => {
      if (!features.tasks) throw redirect({ to: '/' });
    },
    component: lazyRouteComponent(() => import('@/routes/Tasks')),
    getParentRoute: () => authShellRoute,
    loader: ({ context: { queryClient: qc } }) => {
      qc.prefetchQuery(tasksQuery());
    },
    path: '/tasks',
  }),
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
            qc.prefetchQuery(exploreFlashcardSetsQuery());
          }
        ),
      ]
    : []),
  createRoute({
    beforeLoad: () => {
      throw redirect({ replace: true, to: '/help-and-legal' });
    },
    getParentRoute: () => authShellRoute,
    path: '/support',
  }),
  page('/help-and-legal', () => import('@/routes/HelpAndLegal')),
  page('/help-and-legal/credits', () => import('@/routes/Credits')),
  createRoute({
    component: lazyRouteComponent(() => import('@/routes/Settings')),
    getParentRoute: () => authShellRoute,
    loader: ({ context: { queryClient: qc } }) => {
      qc.prefetchQuery(modelsQuery('chat'));
      qc.prefetchQuery(modelsQuery('generate'));
      qc.prefetchQuery(billingQuery());
    },
    path: '/settings',
    validateSearch: parseSettingsSearch,
  }),
  createRoute({
    beforeLoad: () => {
      throw redirect({ search: { tab: 'general' }, to: '/settings' });
    },
    component: () => null,
    getParentRoute: () => authShellRoute,
    path: '/profile',
  }),
  createRoute({
    beforeLoad: () => {
      throw redirect({ search: { tab: 'subscription' }, to: '/settings' });
    },
    component: () => null,
    getParentRoute: () => authShellRoute,
    path: '/subscription',
  }),
  page(
    '/billing',
    () => import('@/routes/Billing'),
    ({ context: { queryClient: qc } }) => {
      qc.prefetchQuery(billingQuery());
      qc.prefetchQuery(usageQuery());
    }
  ),
];

const routeTree = rootRoute.addChildren([
  ...publicRoutes,
  authShellRoute.addChildren(appRoutes),
]);

export const router = createRouter({
  context: { queryClient },
  defaultErrorComponent: RouteErrorComponent,
  defaultNotFoundComponent: RouteNotFoundComponent,
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  routeTree,
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
  interface StaticDataRouteOption {
    /** Route renders without the app nav. Read from committed matches, so the
     * shell only reshapes once the route's chunk has landed. */
    hideSidebar?: boolean;
  }
}
