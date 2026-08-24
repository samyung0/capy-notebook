import { SignOutButton, useAuth, useUser } from '@clerk/react';
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet } from '@tanstack/react-router';
import {
  Activity,
  BarChart3,
  CircleDollarSign,
  Database,
  Menu,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { createOpsApi, OpsApiError } from './api';
import { AppContextProvider } from './app-context';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Separator } from './components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './components/ui/sheet';
import { Skeleton } from './components/ui/skeleton';
import { ErrorState, POLL_INTERVAL } from './ops-ui';

const navigation = [
  { icon: BarChart3, label: 'Overview', to: '/' },
  { icon: Activity, label: 'Health', to: '/health' },
  { icon: Search, label: 'Users', to: '/users' },
  { icon: CircleDollarSign, label: 'Cost explorer', to: '/costs' },
  { icon: Database, label: 'Model registry', to: '/registry' },
] satisfies {
  to: '/' | '/health' | '/users' | '/costs' | '/registry';
  label: string;
  icon: typeof Activity;
}[];

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Ops navigation" className="space-y-1">
      {navigation.map(({ to, label, icon: Icon }) => (
        <Link
          activeProps={{ className: 'bg-accent text-accent-foreground' }}
          className="flex min-h-10 items-center gap-3 rounded-md px-3 font-medium text-muted-foreground text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
          key={to}
          onClick={onNavigate}
          search={
            to === '/users' ? { q: '' } : to === '/costs' ? true : undefined
          }
          to={to}
        >
          <Icon aria-hidden="true" className="size-4" />
          {label}
        </Link>
      ))}
    </nav>
  );
}

function Sidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 hidden w-64 border-r bg-card lg:flex lg:flex-col">
      <div className="flex h-16 items-center gap-3 px-6">
        <div className="grid size-8 place-items-center rounded-lg bg-primary font-semibold text-primary-foreground text-sm">
          E
        </div>
        <div>
          <p className="font-semibold">Evo Notes</p>
          <p className="text-muted-foreground text-xs">Operations</p>
        </div>
      </div>
      <Separator />
      <div className="flex-1 p-4">
        <Navigation />
      </div>
      <p className="px-6 pb-5 text-muted-foreground text-xs leading-relaxed">
        Internal production data. Do not share screenshots or exports.
      </p>
    </aside>
  );
}

function useLastUpdated(): number {
  const queryClient = useQueryClient();
  const queryCache = queryClient.getQueryCache();
  const subscribe = useCallback(
    (notify: () => void) => queryCache.subscribe(notify),
    [queryCache]
  );
  const getSnapshot = useCallback(() => {
    let latest = 0;
    for (const query of queryCache.getAll()) {
      latest = Math.max(latest, query.state.dataUpdatedAt);
    }
    return latest;
  }, [queryCache]);
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}

function TopBar({ role }: { role: 'viewer' | 'admin' }) {
  const queryClient = useQueryClient();
  const fetching = useIsFetching();
  const lastUpdated = useLastUpdated();
  const { user } = useUser();
  const displayName =
    user?.fullName ??
    user?.primaryEmailAddress?.emailAddress ??
    'Signed-in operator';

  return (
    <header className="sticky top-0 z-30 flex min-h-16 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur sm:px-6">
      <Sheet>
        <SheetTrigger asChild>
          <Button
            aria-label="Open navigation"
            className="lg:hidden"
            size="icon"
            type="button"
            variant="outline"
          >
            <Menu aria-hidden="true" />
          </Button>
        </SheetTrigger>
        <SheetContent className="w-72" side="left">
          <SheetHeader className="mb-6 text-left">
            <SheetTitle>Evo Notes Operations</SheetTitle>
            <SheetDescription>Internal production dashboard</SheetDescription>
          </SheetHeader>
          <Navigation />
        </SheetContent>
      </Sheet>
      <div
        aria-live="polite"
        className="min-w-0 flex-1 text-muted-foreground text-xs"
      >
        {fetching > 0 ? (
          <span className="inline-flex items-center gap-2">
            <RefreshCw aria-hidden="true" className="size-3 animate-spin" />
            Refreshing data
          </span>
        ) : lastUpdated > 0 ? (
          <span>
            Updated{' '}
            {new Intl.DateTimeFormat('en-US', {
              hour: 'numeric',
              minute: '2-digit',
              second: '2-digit',
            }).format(lastUpdated)}
          </span>
        ) : (
          <span>Waiting for data</span>
        )}
      </div>
      <Button
        aria-label="Refresh all data"
        disabled={fetching > 0}
        onClick={() => queryClient.invalidateQueries()}
        size="icon"
        type="button"
        variant="ghost"
      >
        <RefreshCw aria-hidden="true" />
      </Button>
      <div className="hidden min-w-0 text-right sm:block">
        <p className="max-w-48 truncate font-medium text-sm">{displayName}</p>
        <p className="text-muted-foreground text-xs">Signed in</p>
      </div>
      <Badge variant={role === 'admin' ? 'default' : 'secondary'}>{role}</Badge>
      <SignOutButton>
        <Button size="sm" type="button" variant="outline">
          Sign out
        </Button>
      </SignOutButton>
    </header>
  );
}

export function AppShell() {
  const { getToken } = useAuth();
  const api = useMemo(() => createOpsApi({ getToken }), [getToken]);
  const {
    data: session,
    error,
    isError,
    isPending,
    refetch,
  } = useQuery({
    queryFn: api.session,
    queryKey: ['ops', 'session'],
    refetchInterval: POLL_INTERVAL,
    retry: (count, queryError) =>
      !(queryError instanceof OpsApiError && queryError.status < 500) &&
      count < 2,
  });

  if (isPending) {
    return (
      <div className="grid min-h-screen place-items-center p-6">
        <div
          aria-label="Checking operator access"
          className="w-full max-w-sm space-y-3"
          role="status"
        >
          <Skeleton className="mx-auto size-12 rounded-xl" />
          <Skeleton className="mx-auto h-6 w-48" />
          <Skeleton className="mx-auto h-4 w-72" />
        </div>
      </div>
    );
  }

  if (isError || !session) {
    return (
      <main className="grid min-h-screen place-items-center p-6">
        <div className="w-full max-w-xl">
          <ErrorState error={error} onRetry={() => refetch()} />
        </div>
      </main>
    );
  }

  return (
    <AppContextProvider value={{ api, session }}>
      <a
        className="fixed top-4 left-4 z-[100] -translate-y-24 rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground text-sm focus:translate-y-0 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
        href="#main-content"
      >
        Skip to content
      </a>
      <Sidebar />
      <div className="min-h-screen lg:pl-64">
        <TopBar role={session.role} />
        <main className="p-4 sm:p-6 lg:p-8" id="main-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </AppContextProvider>
  );
}
