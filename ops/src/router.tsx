import { SignIn, useAuth } from '@clerk/react';
import { useQuery } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
} from '@tanstack/react-router';
import { lazy, type ReactNode, Suspense, useMemo } from 'react';
import { createOpsApi, hasPermission } from '@/api';
import { AppContextProvider, useOpsApp } from '@/app-context';
import { AppShell } from '@/components/app-shell';
import { ErrorState, PageLoading } from '@/components/common';

const CostsPage = lazy(() =>
  import('@/pages/costs').then((module) => ({ default: module.CostsPage }))
);
const AuditPage = lazy(() =>
  import('@/pages/audit').then((module) => ({ default: module.AuditPage }))
);
const HealthPage = lazy(() =>
  import('@/pages/health').then((module) => ({ default: module.HealthPage }))
);
const OverviewPage = lazy(() =>
  import('@/pages/overview').then((module) => ({
    default: module.OverviewPage,
  }))
);
const IngestHostPage = lazy(() =>
  import('@/pages/ingest-host').then((module) => ({
    default: module.IngestHostPage,
  }))
);
const ReconciliationPage = lazy(() =>
  import('@/pages/reconciliation').then((module) => ({
    default: module.ReconciliationPage,
  }))
);
const RegistryPage = lazy(() =>
  import('@/pages/registry').then((module) => ({
    default: module.RegistryPage,
  }))
);
const UserDetailPage = lazy(() =>
  import('@/pages/users').then((module) => ({
    default: module.UserDetailPage,
  }))
);
const UserLookupPage = lazy(() =>
  import('@/pages/users').then((module) => ({
    default: module.UserLookupPage,
  }))
);

function PageBoundary({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<PageLoading label="Loading page" />}>
      {children}
    </Suspense>
  );
}

function Root() {
  return <Outlet />;
}

function SignInPage() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) {
    return (
      <main className="grid min-h-dvh place-items-center p-6">
        <PageLoading label="Loading sign in" />
      </main>
    );
  }
  if (isSignedIn) {
    return <Navigate to="/" />;
  }
  return (
    <main className="grid min-h-dvh place-items-center bg-muted/40 p-4">
      <div>
        <div className="mb-5 text-center">
          <h1 className="font-semibold text-2xl">Evo Notes operations</h1>
          <p className="mt-1 text-muted-foreground text-sm">
            Sign in with an authorized operator account.
          </p>
        </div>
        <SignIn fallbackRedirectUrl="/" routing="hash" />
      </div>
    </main>
  );
}

function AuthenticatedLayout() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const api = useMemo(() => createOpsApi({ getToken }), [getToken]);
  const {
    data: session,
    error,
    isPending,
    refetch,
  } = useQuery({
    enabled: isLoaded && isSignedIn,
    queryFn: api.session,
    queryKey: ['session'],
    staleTime: 5 * 60_000,
  });

  if (!isLoaded) {
    return (
      <main className="mx-auto max-w-5xl p-6">
        <PageLoading label="Loading operator session" />
      </main>
    );
  }
  if (!isSignedIn) {
    return <Navigate to="/sign-in" />;
  }
  if (isPending) {
    return (
      <main className="mx-auto max-w-5xl p-6">
        <PageLoading label="Authorizing operator" />
      </main>
    );
  }
  if (error || !session) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <ErrorState error={error} retry={() => void refetch()} />
      </main>
    );
  }

  return (
    <AppContextProvider value={{ api, session }}>
      <AppShell>
        <Outlet />
      </AppShell>
    </AppContextProvider>
  );
}

function UserDetailRoutePage() {
  const { userId } = userDetailRoute.useParams();
  return (
    <PageBoundary>
      <UserDetailPage userId={userId} />
    </PageBoundary>
  );
}

function RegistryRoutePage() {
  const { session } = useOpsApp();
  return hasPermission(session, 'write_registry') ? (
    <PageBoundary>
      <RegistryPage />
    </PageBoundary>
  ) : (
    <Navigate to="/" />
  );
}

const rootRoute = createRootRoute({ component: Root });
const signInRoute = createRoute({
  component: SignInPage,
  getParentRoute: () => rootRoute,
  path: '/sign-in',
});
const authenticatedRoute = createRoute({
  component: AuthenticatedLayout,
  getParentRoute: () => rootRoute,
  id: 'authenticated',
});
const overviewRoute = createRoute({
  component: () => (
    <PageBoundary>
      <OverviewPage />
    </PageBoundary>
  ),
  getParentRoute: () => authenticatedRoute,
  path: '/',
});
const healthRoute = createRoute({
  component: () => (
    <PageBoundary>
      <HealthPage />
    </PageBoundary>
  ),
  getParentRoute: () => authenticatedRoute,
  path: '/health',
});
const ingestHostRoute = createRoute({
  component: () => (
    <PageBoundary>
      <IngestHostPage />
    </PageBoundary>
  ),
  getParentRoute: () => authenticatedRoute,
  path: '/ingest-host',
});
const reconciliationRoute = createRoute({
  component: () => (
    <PageBoundary>
      <ReconciliationPage />
    </PageBoundary>
  ),
  getParentRoute: () => authenticatedRoute,
  path: '/reconciliation',
});
const usersRoute = createRoute({
  component: () => (
    <PageBoundary>
      <UserLookupPage />
    </PageBoundary>
  ),
  getParentRoute: () => authenticatedRoute,
  path: '/users',
});
const userDetailRoute = createRoute({
  component: UserDetailRoutePage,
  getParentRoute: () => authenticatedRoute,
  path: '/users/$userId',
});
const costsRoute = createRoute({
  component: () => (
    <PageBoundary>
      <CostsPage />
    </PageBoundary>
  ),
  getParentRoute: () => authenticatedRoute,
  path: '/costs',
});
const auditRoute = createRoute({
  component: () => (
    <PageBoundary>
      <AuditPage />
    </PageBoundary>
  ),
  getParentRoute: () => authenticatedRoute,
  path: '/audit',
});
const registryRoute = createRoute({
  component: RegistryRoutePage,
  getParentRoute: () => authenticatedRoute,
  path: '/registry',
});

const routeTree = rootRoute.addChildren([
  signInRoute,
  authenticatedRoute.addChildren([
    overviewRoute,
    healthRoute,
    ingestHostRoute,
    reconciliationRoute,
    usersRoute,
    userDetailRoute,
    costsRoute,
    auditRoute,
    registryRoute,
  ]),
]);

export const router = createRouter({
  defaultPreload: 'intent',
  routeTree,
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
