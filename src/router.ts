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
  learningProgressQuery,
  materialQuery,
  materialsQuery,
  meQuery,
  modelsQuery,
  notificationPrefsQuery,
  ownedFilesQuery,
  ownedMaterialsQuery,
  quizQuery,
  recentFilesQuery,
  recentMaterialsQuery,
  reviewOverviewQuery,
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
import { prefetchOfficeFile } from '@/features/files/prefetchOfficeFile';
import {
  parseDocumentModeSearch,
  parseWorkspaceOpenSearch,
} from '@/features/materials/openItem';
import {
  PAST_REVIEW_SORT_DEFAULT,
  PAST_REVIEW_SORTS,
  parsePastReviewsSearch,
  parseResultsSearch,
  parseReviewSearch,
  RESULT_SORT_DEFAULT,
  RESULT_SORTS,
} from '@/features/study/reviewSearch';
import { checkReleaseOnFocus, loadUpdateOnPathChange } from '@/lib/appRelease';
import { OfflineError } from '@/lib/errors';
import { features } from '@/lib/features';
import {
  FILE_SORT_DEFAULT,
  FILE_SORTS,
  fileListParams,
  MATERIAL_SORT_DEFAULT,
  MATERIAL_SORTS,
  materialListParams,
  parseFilesSearch,
  parseWorkspacesSearch,
  savedSort,
  WORKSPACE_SORT_DEFAULT,
  WORKSPACE_SORTS,
  workspaceListParams,
} from '@/lib/listSearch';
import {
  parseBillingSearch,
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

/** A page loaded with its route. TanStack reloads the tab once when a page's
 * code fails to load (a deploy renamed its chunk); offline that reload lands
 * on the browser's offline page, so there the failure is an OfflineError,
 * which the route's error component shows as offline (Epo 2026-10-17). Its
 * retry on reconnect loads the whole page: the browser keeps a failed import
 * for the document, so TanStack's reload then runs, online. */
const lazyPage = (importer: () => Promise<{ default: React.ComponentType }>) =>
  lazyRouteComponent(() =>
    importer().catch((error: unknown) => {
      throw navigator.onLine
        ? error
        : new OfflineError('Offline', { cause: error });
    })
  );

const page = <const T extends string>(
  path: T,
  importer: () => Promise<{ default: React.ComponentType }>,
  loader?: Loader,
  hideSidebar = false
) =>
  createRoute({
    component: lazyPage(importer),
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
    component: lazyPage(() => import('@/routes/WorkspaceInviteAccept')),
    getParentRoute: () => rootRoute,
    path: '/workspace-invites/$token',
  }),
  createRoute({
    component: lazyPage(() => import('@/routes/SignIn')),
    getParentRoute: () => rootRoute,
    path: '/sign-in',
  }),
  createRoute({
    component: lazyPage(() => import('@/routes/SignUp')),
    getParentRoute: () => rootRoute,
    path: '/sign-up',
  }),
  createRoute({
    component: lazyPage(() => import('@/routes/ForgotPassword')),
    getParentRoute: () => rootRoute,
    path: '/forgot-password',
  }),
  createRoute({
    component: lazyPage(() => import('@/routes/SsoCallback')),
    getParentRoute: () => rootRoute,
    path: '/sso-callback',
  }),
];

// One page for every /qb URL: the topic and question are child routes
// without components, so moving between them keeps the page mounted and its
// filters and picks intact.
const bankRoute = createRoute({
  component: lazyPage(() => import('@/routes/QuestionBank')),
  getParentRoute: () => authShellRoute,
  path: '/qb',
  // `exam` is the exam open in the side panel; without it /qb lists every
  // exam, and a topic URL opens the topic's own exam. `finished` is the topic
  // a finish toast's Go check leads the landing's map with.
  validateSearch: (
    search: Record<string, unknown>
  ): { mode?: 'edit'; exam?: string; finished?: string } => ({
    exam:
      typeof search.exam === 'string' && search.exam ? search.exam : undefined,
    finished:
      typeof search.finished === 'string' && search.finished
        ? search.finished
        : undefined,
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
    component: lazyPage(() => import('@/routes/Dashboard')),
    getParentRoute: () => authShellRoute,
    loader: ({ context: { queryClient: qc } }) => {
      qc.prefetchQuery(workspacesQuery({ sort: 'accessed' }));
      qc.prefetchInfiniteQuery(recentFilesQuery());
      qc.prefetchInfiniteQuery(recentMaterialsQuery());
      qc.prefetchQuery(canvasesQuery());
    },
    path: '/',
  }),
  // biome-ignore assist/source/useSortedKeys: TanStack types `deps` in the loader from `loaderDeps`, which must come first.
  createRoute({
    // A list opened without a sort in the URL shows the viewer's last pick.
    beforeLoad: ({ search }) => {
      const saved = savedSort(
        'workspaces',
        WORKSPACE_SORTS,
        WORKSPACE_SORT_DEFAULT,
        search
      );
      if (saved)
        throw redirect({
          replace: true,
          search: { ...search, ...saved },
          to: '/workspaces',
        });
    },
    component: lazyPage(() => import('@/routes/Workspaces')),
    getParentRoute: () => authShellRoute,
    loaderDeps: ({ search }) => search,
    loader: ({ context: { queryClient: qc }, deps }) => {
      qc.prefetchQuery(workspacesQuery(workspaceListParams(deps)));
    },
    path: '/workspaces',
    validateSearch: parseWorkspacesSearch,
  }),
  // biome-ignore assist/source/useSortedKeys: TanStack types `deps` in the loader from `loaderDeps`, which must come first.
  createRoute({
    component: lazyPage(() => import('@/routes/WorkspaceOpen')),
    getParentRoute: () => authShellRoute,
    loaderDeps: ({ search }) => ({ file: search.file }),
    loader: ({
      abortController,
      context: { queryClient: qc },
      deps,
      location,
      params,
      preload,
    }) => {
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
      if (deps.file) {
        qc.prefetchQuery(fileQuery(deps.file));
        // An Office file's open starts once its row arrives.
        prefetchOfficeFile(qc, deps.file, {
          abortController,
          location,
          preload,
        });
      }
    },
    path: '/workspaces/$workspaceId',
    staticData: { hideSidebar: true },
    validateSearch: parseWorkspaceOpenSearch,
  }),
  createRoute({
    component: lazyPage(() => import('@/routes/OpenShareLink')),
    getParentRoute: () => authShellRoute,
    path: '/open/$token',
  }),
  blocksRedirect('/create'),
  blocksRedirect('/quizzes'),
  blocksRedirect('/flashcards'),
  createRoute({
    beforeLoad: ({ search }) => {
      const saved =
        search.tab === 'results'
          ? savedSort('results', RESULT_SORTS, RESULT_SORT_DEFAULT, search)
          : search.tab === 'review'
            ? savedSort(
                'pastReviews',
                PAST_REVIEW_SORTS,
                PAST_REVIEW_SORT_DEFAULT,
                search
              )
            : undefined;
      if (saved)
        throw redirect({
          replace: true,
          search: { ...search, ...saved },
          to: '/learning',
        });
    },
    component: lazyPage(() => import('@/routes/Learning')),
    getParentRoute: () => authShellRoute,
    loader: ({ context: { queryClient: qc } }) => {
      void qc.prefetchInfiniteQuery(attemptsQuery());
      void qc.prefetchQuery(learningProgressQuery());
      void qc.prefetchQuery(reviewOverviewQuery());
    },
    path: '/learning',
    validateSearch: (search: Record<string, unknown>) => {
      const tab = parseLearningSearch(search);
      return {
        ...tab,
        ...(tab.tab === 'results'
          ? parseResultsSearch(search)
          : parsePastReviewsSearch(search)),
        // The workspace a finish toast's Go check leads Progress's map with.
        ...(typeof search.finished === 'string' && search.finished
          ? { finished: search.finished }
          : {}),
      };
    },
  }),
  createRoute({
    component: lazyPage(() => import('@/routes/ReviewSession')),
    getParentRoute: () => authShellRoute,
    path: '/learning/review/$workspaceId',
    validateSearch: parseReviewSearch,
  }),
  createRoute({
    component: lazyPage(() => import('@/routes/ReviewResult')),
    getParentRoute: () => authShellRoute,
    path: '/learning/reviews/$sessionId',
  }),
  createRoute({
    component: lazyPage(() => import('@/routes/MaterialOpen')),
    getParentRoute: () => authShellRoute,
    loader: ({ context: { queryClient }, params }) => {
      void queryClient.prefetchQuery(materialQuery(params.materialId));
    },
    path: '/materials/$materialId',
    validateSearch: parseDocumentModeSearch,
  }),
  createRoute({
    component: lazyPage(() => import('@/routes/MaterialOpen')),
    getParentRoute: () => authShellRoute,
    loader: ({
      abortController,
      context: { queryClient: qc },
      location,
      params,
      preload,
    }) => {
      qc.prefetchQuery(fileQuery(params.fileId));
      prefetchOfficeFile(qc, params.fileId, {
        abortController,
        location,
        preload,
      });
    },
    path: '/files/$fileId',
    validateSearch: parseDocumentModeSearch,
  }),
  bankRoute.addChildren([
    bankChild('$topicId'),
    bankChild('$topicId/summary'),
    bankChild('$topicId/$questionId'),
  ]),
  page(
    '/quizzes/$quizId/attempt',
    () => import('@/routes/QuizAttempt'),
    ({ context: { queryClient: qc }, params }) =>
      qc.prefetchQuery(quizQuery(params.quizId))
  ),
  page(
    '/quizzes/attempts/$attemptId',
    () => import('@/routes/AttemptResult'),
    ({ context: { queryClient: qc }, params }) =>
      qc.prefetchQuery(attemptQuery(params.attemptId))
  ),
  page(
    '/flashcards/attempts/$attemptId',
    () => import('@/routes/AttemptResult'),
    ({ context: { queryClient: qc }, params }) =>
      qc.prefetchQuery(attemptQuery(params.attemptId))
  ),
  createRoute({
    beforeLoad: () => {
      if (!features.schedule) throw redirect({ to: '/' });
    },
    component: lazyPage(() => import('@/routes/Schedule')),
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
  // biome-ignore assist/source/useSortedKeys: TanStack types `deps` in the loader from `loaderDeps`, which must come first.
  createRoute({
    beforeLoad: ({ search }) => {
      const saved =
        search.tab === 'blocks'
          ? savedSort('blocks', MATERIAL_SORTS, MATERIAL_SORT_DEFAULT, search)
          : search.tab === 'trash'
            ? undefined
            : savedSort('files', FILE_SORTS, FILE_SORT_DEFAULT, search);
      if (saved)
        throw redirect({
          replace: true,
          search: { ...search, ...saved },
          to: '/files',
        });
    },
    component: lazyPage(() => import('@/routes/Files')),
    getParentRoute: () => authShellRoute,
    loaderDeps: ({ search }) => search,
    loader: ({ context: { queryClient: qc }, deps }) => {
      if (deps.tab === 'blocks') {
        qc.prefetchInfiniteQuery(ownedMaterialsQuery(materialListParams(deps)));
      } else if (deps.tab !== 'trash') {
        qc.prefetchInfiniteQuery(ownedFilesQuery(fileListParams(deps)));
      }
    },
    path: '/files',
    validateSearch: parseFilesSearch,
  }),
  createRoute({
    beforeLoad: () => {
      if (!features.tasks) throw redirect({ to: '/' });
    },
    component: lazyPage(() => import('@/routes/Tasks')),
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
  page('/notifications', () => import('@/routes/Notifications')),
  page('/help-and-legal', () => import('@/routes/HelpAndLegal')),
  page('/help-and-legal/credits', () => import('@/routes/Credits')),
  // biome-ignore assist/source/useSortedKeys: TanStack types `deps` in the loader from `loaderDeps`, which must come first.
  createRoute({
    component: lazyPage(() => import('@/routes/Settings')),
    getParentRoute: () => authShellRoute,
    loaderDeps: ({ search }) => ({ tab: search.tab }),
    // Only the open tab's data, started with the route instead of on mount.
    loader: ({ context: { queryClient: qc }, deps }) => {
      if (deps.tab === 'notifications') {
        qc.prefetchQuery(notificationPrefsQuery());
      } else if (deps.tab === 'llm') {
        qc.prefetchQuery(modelsQuery('chat'));
        if (features.editorAi) qc.prefetchQuery(modelsQuery('editor'));
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
    component: lazyPage(() => import('@/routes/Billing')),
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

// A newer app is served: the next page change loads it (the release nudge).
loadUpdateOnPathChange(router);
checkReleaseOnFocus();

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
