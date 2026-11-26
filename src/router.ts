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
  billingQuery,
  cardsQuery,
  continueQuery,
  conversationsQuery,
  eventsQuery,
  exploreFlashcardSetsQuery,
  exploreQuizzesQuery,
  exploreWorkspacesQuery,
  fileQuery,
  filesQuery,
  flashcardSetQuery,
  historyQuery,
  itemsQuery,
  labelsQuery,
  learningOverviewQuery,
  materialQuery,
  materialsQuery,
  meQuery,
  modelsQuery,
  notificationPrefsQuery,
  quizQuery,
  tasksQuery,
  todoQuery,
  topicsQuery,
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
import { parseThemeSearch } from '@/components/app/themeDrawerSearch';
import { prefetchOfficeFile } from '@/features/files/prefetchOfficeFile';
import {
  parseDocumentModeSearch,
  parseMaterialPageSearch,
  parseWorkspaceOpenSearch,
} from '@/features/materials/openItem';
import {
  HISTORY_SORT_DEFAULT,
  HISTORY_SORTS,
  parseHistorySearch,
  parseReviewSearch,
} from '@/features/study/reviewSearch';
import {
  isStudyTab,
  parseAssignmentsSearch,
  parseStudySearch,
  studyLink,
} from '@/features/study/studyRoutes';
import { checkReleaseOnFocus, loadUpdateOnPathChange } from '@/lib/appRelease';
import { OfflineError } from '@/lib/errors';
import { features } from '@/lib/features';
import {
  ITEM_SORT_DEFAULT,
  ITEM_SORTS,
  itemListParams,
  parseFilesSearch,
  parseTodoSearch,
  parseWorkspacesSearch,
  savedSort,
  WORKSPACE_SORT_DEFAULT,
  WORKSPACE_SORTS,
  type WorkspacesSearch,
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
  // `?theme=open` opens the Theme drawer over any signed-in page.
  validateSearch: parseThemeSearch,
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
  // Dev builds only, so production builds drop BlockSuite's chunk until a page
  // that ships opens the board. The canvas bench's production build turns it on
  // (VITE_BENCH_ROUTES, bench:canvas); a deploy pins it off (scripts/env/config.py).
  ...(import.meta.env.DEV || import.meta.env.VITE_BENCH_ROUTES === 'true'
    ? [
        createRoute({
          component: lazyPage(() => import('@/routes/DevDrawingBoard')),
          getParentRoute: () => rootRoute,
          path: '/dev/drawing',
        }),
      ]
    : []),
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
// page's list.
const blocksRedirect = <const T extends string>(path: T) =>
  createRoute({
    beforeLoad: () => {
      throw redirect({
        replace: true,
        to: '/files',
      });
    },
    component: () => null,
    getParentRoute: () => authShellRoute,
    path,
  });

// biome-ignore assist/source/useSortedKeys: TanStack types `deps` in the loader from `loaderDeps`, which must come first.
const workspaceRoute = createRoute({
  component: lazyPage(() => import('@/routes/WorkspaceOpen')),
  getParentRoute: () => authShellRoute,
  loaderDeps: ({ search }) => ({ file: search.file }),
  loader: ({
    abortController,
    context: { queryClient: qc },
    deps,
    params,
    preload,
  }) => {
    const id = params.workspaceId;
    qc.prefetchQuery(workspaceQuery(id));
    qc.prefetchQuery(workspacesQuery({ sort: 'accessed' }));
    qc.prefetchQuery(topicsQuery(id));
    qc.prefetchQuery(filesQuery(id));
    qc.prefetchQuery(materialsQuery(id));
    qc.prefetchInfiniteQuery(conversationsQuery(id));
    // The Dashboard's Continue, beside its other sections.
    qc.prefetchQuery(continueQuery(id));
    // The open file rides the first wave instead of waiting for the page to
    // render. An open material is left out on purpose: its body is the
    // document itself, and the heavy-document gate must see the list first.
    if (deps.file) {
      qc.prefetchQuery(fileQuery(deps.file));
      // An Office file's open starts once its row arrives.
      prefetchOfficeFile(qc, deps.file, { abortController, preload });
    }
  },
  path: '/workspaces/$workspaceId',
  staticData: { hideSidebar: true },
  validateSearch: parseWorkspaceOpenSearch,
});

// The workspace's pages beside its rail and panels (Epo 2026-11-18): the
// workspace's route stays mounted and draws them in its centre, and the router
// keeps the page before on screen until a page's code is in. Declared apart
// from `addChildren`, whose argument would type them against their parent.
const workspacePages = [
  createRoute({
    component: lazyPage(() => import('@/routes/WorkspaceAssignments')),
    getParentRoute: () => workspaceRoute,
    path: 'assignments',
    validateSearch: parseAssignmentsSearch,
  }),
  createRoute({
    component: lazyPage(() => import('@/routes/WorkspaceMembers')),
    getParentRoute: () => workspaceRoute,
    path: 'members',
  }),
  // One route for Study's tabs, so a tab switch keeps the page mounted.
  createRoute({
    component: lazyPage(() => import('@/routes/WorkspaceStudy')),
    getParentRoute: () => workspaceRoute,
    params: {
      // An unknown tab is a page no one has: Practice, as for a page this
      // person doesn't have (WorkspaceOpen). The parser is handed the
      // parent's params too.
      parse: (params) => {
        if (isStudyTab(params.tab)) return { tab: params.tab };
        const { workspaceId } = params as typeof params & {
          workspaceId: string;
        };
        throw redirect({
          ...studyLink(workspaceId, 'practice'),
          replace: true,
        });
      },
      stringify: ({ tab }) => ({ tab }),
    },
    path: 'study/$tab',
    validateSearch: parseStudySearch,
  }),
];

const appRoutes = [
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
          to: '/',
        });
    },
    component: lazyPage(() => import('@/routes/Workspaces')),
    getParentRoute: () => authShellRoute,
    loaderDeps: ({ search }) => search,
    loader: ({ context: { queryClient: qc }, deps }) => {
      qc.prefetchQuery(workspacesQuery(workspaceListParams(deps)));
    },
    path: '/',
    // `clone` is the public pages' Clone link, which CloneLinkDialog reads.
    validateSearch: (
      search: Record<string, unknown>
    ): WorkspacesSearch & { clone?: unknown } => ({
      ...parseWorkspacesSearch(search),
      clone: search.clone,
    }),
  }),
  createRoute({
    beforeLoad: ({ search }) => {
      throw redirect({ replace: true, search, to: '/' });
    },
    component: () => null,
    getParentRoute: () => authShellRoute,
    path: '/workspaces',
    validateSearch: parseWorkspacesSearch,
  }),
  createRoute({
    component: lazyPage(() => import('@/routes/Todo')),
    getParentRoute: () => authShellRoute,
    loader: ({ context: { queryClient: qc } }) => {
      qc.prefetchQuery(todoQuery());
    },
    path: '/todo',
    validateSearch: parseTodoSearch,
  }),
  workspaceRoute.addChildren(workspacePages),
  // The account's Canvas page: `c` names the canvas of the person's own shown,
  // `open` what fills its screen (a plane's or chart's editor, a drawing answer).
  createRoute({
    component: lazyPage(() => import('@/routes/Canvas')),
    getParentRoute: () => authShellRoute,
    path: '/canvas',
    validateSearch: (
      search: Record<string, unknown>
    ): { c?: string; open?: string } => ({
      c: typeof search.c === 'string' ? search.c : undefined,
      open: typeof search.open === 'string' ? search.open : undefined,
    }),
  }),
  // Chat across all the user's files; the optional id keeps the page mounted
  // (and its streams running) while the shown conversation changes.
  createRoute({
    component: lazyPage(() => import('@/routes/AccountChat')),
    getParentRoute: () => authShellRoute,
    loader: ({ context: { queryClient: qc } }) => {
      qc.prefetchInfiniteQuery(conversationsQuery(null));
      // Citations show their workspace's icon.
      qc.prefetchQuery(workspacesQuery({ sort: 'accessed' }));
    },
    path: '/chat/{-$conversationId}',
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
      if (!features.learning) throw redirect({ replace: true, to: '/' });
      const saved =
        search.tab === 'history'
          ? savedSort('history', HISTORY_SORTS, HISTORY_SORT_DEFAULT, search)
          : null;
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
      void qc.prefetchInfiniteQuery(historyQuery());
      void qc.prefetchQuery(learningOverviewQuery());
      // Continue tops the Overview: fetched beside it, not once it draws.
      void qc.prefetchQuery(continueQuery());
    },
    path: '/learning',
    validateSearch: (search: Record<string, unknown>) => {
      const tab = parseLearningSearch(search);
      return {
        ...tab,
        ...(tab.tab === 'history' ? parseHistorySearch(search) : {}),
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
    validateSearch: parseMaterialPageSearch,
  }),
  createRoute({
    component: lazyPage(() => import('@/routes/MaterialOpen')),
    getParentRoute: () => authShellRoute,
    loader: ({
      abortController,
      context: { queryClient: qc },
      params,
      preload,
    }) => {
      qc.prefetchQuery(fileQuery(params.fileId));
      prefetchOfficeFile(qc, params.fileId, { abortController, preload });
    },
    path: '/files/$fileId',
    validateSearch: parseDocumentModeSearch,
  }),
  bankRoute.addChildren([
    bankChild('$topicId'),
    bankChild('$topicId/summary'),
    bankChild('$topicId/$questionId'),
  ]),
  // A member's try at an assignment, alone (Epo 2026-11-25): no sidebar and
  // no workspace shell, and no prefetch, since taking it starts only from the
  // page's own read.
  page(
    '/attempts/$attemptId',
    () => import('@/routes/AssignmentAttempt'),
    undefined,
    true
  ),
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
      const saved = search.tab
        ? undefined
        : savedSort('files', ITEM_SORTS, ITEM_SORT_DEFAULT, search);
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
      if (!deps.tab) qc.prefetchInfiniteQuery(itemsQuery(itemListParams(deps)));
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
  ...(features.explore
    ? [
        page(
          '/explore',
          () => import('@/routes/Explore'),
          ({ context: { queryClient: qc } }) => {
            qc.prefetchInfiniteQuery(exploreWorkspacesQuery());
            qc.prefetchInfiniteQuery(exploreQuizzesQuery());
            qc.prefetchInfiniteQuery(exploreFlashcardSetsQuery());
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
