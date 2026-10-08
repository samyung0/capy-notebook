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
  llmCredentialsQuery,
  materialQuery,
  materialsQuery,
  meQuery,
  modelsQuery,
  notificationPrefsQuery,
  ownedFilesQuery,
  ownedMaterialsQuery,
  quizEditQuery,
  quizQuery,
  recentFilesQuery,
  recentMaterialsQuery,
  reviewWorkspacesQuery,
  tasksQuery,
  usageQuery,
  workspaceQuery,
  workspacesQuery,
} from '@/api/hooks';
import { queryClient } from '@/api/queryClient';
import {
  RouteErrorComponent,
  RouteNotFoundComponent,
} from '@/components/app/AppErrorBoundary';
import { AuthShellRoute, RootRoute } from '@/components/app/RouteComponents';
import {
  parseDocumentModeSearch,
  parseWorkspaceOpenSearch,
} from '@/features/materials/openItem';
import { parseQuizEditSearch } from '@/features/quizzes/quizNavigation';
import { parseReviewSearch } from '@/features/study/reviewSearch';
import { features } from '@/lib/features';
import {
  parseBillingSearch,
  parseFilesSearch,
  parseLearningSearch,
  parseSettingsSearch,
} from '@/lib/tabSearch';

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
  loader?: Loader,
  hideSidebar = false
) =>
  createRoute({
    component: lazyRouteComponent(importer),
    getParentRoute: () => authShellRoute,
    path,
    staticData: { hideSidebar },
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

// One page for every /qb URL: the topic and question are child routes
// without components, so moving between them keeps the page mounted and its
// filters and picks intact.
const bankRoute = createRoute({
  component: lazyRouteComponent(() => import('@/routes/QuestionBank')),
  getParentRoute: () => authShellRoute,
  path: '/qb',
  validateSearch: (search: Record<string, unknown>): { mode?: 'edit' } => ({
    mode: search.mode === 'edit' ? 'edit' : undefined,
  }),
});
const bankChild = <const T extends string>(path: T) =>
  createRoute({ getParentRoute: () => bankRoute, path });

// The old Create, Quizzes and Flashcards list pages now live in the Files
// page's Blocks tab.
const blocksRedirect = <const T extends string>(path: T) =>
  createRoute({
    beforeLoad: () => {
      throw redirect({
        replace: true,
        search: { tab: 'blocks' },
        to: '/files',
      });
    },
    component: () => null,
    getParentRoute: () => authShellRoute,
    path,
  });

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
  blocksRedirect('/create'),
  blocksRedirect('/quizzes'),
  blocksRedirect('/flashcards'),
  createRoute({
    component: lazyRouteComponent(() => import('@/routes/Learning')),
    getParentRoute: () => authShellRoute,
    loader: ({ context: { queryClient: qc } }) => {
      void qc.prefetchQuery(attemptsQuery());
      void qc.prefetchQuery(reviewWorkspacesQuery());
    },
    path: '/learning',
    validateSearch: parseLearningSearch,
  }),
  createRoute({
    component: lazyRouteComponent(() => import('@/routes/ReviewSession')),
    getParentRoute: () => authShellRoute,
    path: '/learning/review/$workspaceId',
    validateSearch: parseReviewSearch,
  }),
  createRoute({
    component: lazyRouteComponent(() => import('@/routes/MaterialOpen')),
    getParentRoute: () => authShellRoute,
    loader: ({ context: { queryClient }, params }) => {
      void queryClient.prefetchQuery(materialQuery(params.materialId));
    },
    path: '/materials/$materialId',
    validateSearch: parseDocumentModeSearch,
  }),
  createRoute({
    component: lazyRouteComponent(() => import('@/routes/MaterialOpen')),
    getParentRoute: () => authShellRoute,
    path: '/files/$fileId',
    validateSearch: parseDocumentModeSearch,
  }),
  bankRoute.addChildren([
    bankChild('$topicId'),
    bankChild('$topicId/$questionId'),
  ]),
  page(
    '/quizzes/$quizId/attempt',
    () => import('@/routes/QuizAttempt'),
    ({ context: { queryClient: qc }, params }) =>
      qc.prefetchQuery(quizQuery(params.quizId))
  ),
  createRoute({
    component: lazyRouteComponent(() => import('@/routes/QuizEdit')),
    getParentRoute: () => authShellRoute,
    loader: ({ context: { queryClient: qc }, params }) => {
      void qc.prefetchQuery(quizEditQuery(params.quizId));
    },
    path: '/quizzes/$quizId/edit',
    validateSearch: parseQuizEditSearch,
  }),
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
  page(
    '/flashcards/$flashcardSetId',
    () => import('@/routes/FlashcardStudy'),
    ({ context: { queryClient: qc }, params }) => {
      qc.prefetchQuery(flashcardSetQuery(params.flashcardSetId));
      qc.prefetchQuery(cardsQuery(params.flashcardSetId));
    }
  ),
  createRoute({
    component: lazyRouteComponent(() => import('@/routes/FlashcardsEdit')),
    getParentRoute: () => authShellRoute,
    loader: ({ context: { queryClient: qc }, params }) => {
      void qc.prefetchQuery(materialQuery(params.flashcardSetId));
    },
    path: '/flashcards/$flashcardSetId/edit',
    validateSearch: parseQuizEditSearch,
  }),
  // biome-ignore assist/source/useSortedKeys: TanStack types `deps` in the loader from `loaderDeps`, which must come first.
  createRoute({
    component: lazyRouteComponent(() => import('@/routes/Files')),
    getParentRoute: () => authShellRoute,
    loaderDeps: ({ search }) => ({ tab: search.tab }),
    loader: ({ context: { queryClient: qc }, deps }) => {
      if (deps.tab === 'blocks') {
        qc.prefetchInfiniteQuery(
          ownedMaterialsQuery({ dir: 'desc', sort: 'updated' })
        );
      } else if (deps.tab !== 'trash') {
        qc.prefetchInfiniteQuery(
          ownedFilesQuery({ dir: 'desc', sort: 'added' })
        );
      }
    },
    path: '/files',
    validateSearch: parseFilesSearch,
  }),
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
  // biome-ignore assist/source/useSortedKeys: TanStack types `deps` in the loader from `loaderDeps`, which must come first.
  createRoute({
    component: lazyRouteComponent(() => import('@/routes/Settings')),
    getParentRoute: () => authShellRoute,
    loaderDeps: ({ search }) => ({ tab: search.tab }),
    // Only the open tab's data, started with the route instead of on mount.
    loader: ({ context: { queryClient: qc }, deps }) => {
      if (deps.tab === 'notifications') {
        qc.prefetchQuery(notificationPrefsQuery());
      } else if (deps.tab === 'llm') {
        qc.prefetchQuery(modelsQuery('chat'));
        if (features.editorAi) qc.prefetchQuery(modelsQuery('editor'));
        qc.prefetchQuery(llmCredentialsQuery());
      }
    },
    path: '/settings',
    validateSearch: parseSettingsSearch,
  }),
  createRoute({
    beforeLoad: () => {
      throw redirect({ search: { tab: 'account' }, to: '/settings' });
    },
    component: () => null,
    getParentRoute: () => authShellRoute,
    path: '/profile',
  }),
  createRoute({
    beforeLoad: () => {
      throw redirect({ search: { tab: 'subscription' }, to: '/billing' });
    },
    component: () => null,
    getParentRoute: () => authShellRoute,
    path: '/subscription',
  }),
  createRoute({
    component: lazyRouteComponent(() => import('@/routes/Billing')),
    getParentRoute: () => authShellRoute,
    loader: ({ context: { queryClient: qc } }) => {
      qc.prefetchQuery(billingQuery());
      qc.prefetchQuery(usageQuery());
    },
    path: '/billing',
    validateSearch: parseBillingSearch,
  }),
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
