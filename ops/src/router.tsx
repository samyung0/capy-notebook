import {
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { AppShell } from './app-shell';
import { CostsPage } from './costs-page';
import { HealthPage } from './health-page';
import { EmptyState } from './ops-ui';
import { OverviewPage } from './overview-page';
import { RegistryPage } from './registry-page';
import { parseCostSearch, parseUserSearch } from './search-params';
import { UserDetailPage, UserSearchPage } from './users-page';

export const routePaths = [
  '/',
  '/health',
  '/users',
  '/users/$userId',
  '/costs',
  '/registry',
];

const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: () => (
    <EmptyState
      description="The requested ops route does not exist."
      title="Page not found"
    />
  ),
});

const overviewRoute = createRoute({
  component: OverviewPage,
  getParentRoute: () => rootRoute,
  path: '/',
});

const healthRoute = createRoute({
  component: HealthPage,
  getParentRoute: () => rootRoute,
  path: '/health',
});

const usersRoute = createRoute({
  component: UserSearchPage,
  getParentRoute: () => rootRoute,
  path: '/users',
  validateSearch: parseUserSearch,
});

const userDetailRoute = createRoute({
  component: UserDetailPage,
  getParentRoute: () => rootRoute,
  path: '/users/$userId',
});

const costsRoute = createRoute({
  component: CostsPage,
  getParentRoute: () => rootRoute,
  path: '/costs',
  validateSearch: parseCostSearch,
});

const registryRoute = createRoute({
  component: RegistryPage,
  getParentRoute: () => rootRoute,
  path: '/registry',
});

const routeTree = rootRoute.addChildren([
  overviewRoute,
  healthRoute,
  usersRoute,
  userDetailRoute,
  costsRoute,
  registryRoute,
]);

export const router = createRouter({
  defaultPreload: 'intent',
  routeTree,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
