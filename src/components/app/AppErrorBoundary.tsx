import {
  onlineManager,
  type QueryClient,
  useQueryClient,
} from '@tanstack/react-query';
import {
  type ErrorComponentProps,
  Link,
  useRouter,
} from '@tanstack/react-router';
import {
  Component,
  createContext,
  type ErrorInfo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
} from 'react';
import { ErrorAction } from '@/components/ui/Button';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { describeError, unexpectedErrorId } from '@/lib/errors';
import { ErrorState } from './ErrorState';
import { Panel } from './layout';

/** True inside AppShell's `<main>`: a fallback there must not add a second
 * main landmark. */
export const InShellMain = createContext(false);

/** A fallback's frame: the page's main landmark, or a plain box in the shell. */
/** The fallback's page panel. Inside the shell its main already pads the
 * panel, so it sits level with the sidebar; alone it pads itself. */
function FallbackFrame({
  children,
  className,
}: {
  children: ReactNode;
  className: string;
}) {
  const inShell = useContext(InShellMain);
  const Frame = inShell ? 'div' : 'main';
  return (
    <Frame
      className={cn('overflow-hidden', !inShell && 'p-1.5 sm:p-2.5', className)}
    >
      <Panel
        className="h-full w-full"
        sectionClassName="h-full w-full min-h-full flex flex-row"
      >
        {children}
      </Panel>
    </Frame>
  );
}

interface BoundaryProps {
  children: ReactNode;
  resetKeys?: readonly unknown[];
  variant?: 'page' | 'panel';
}

interface BoundaryCoreProps extends BoundaryProps {
  onReset: () => void;
}

interface BoundaryState {
  error: unknown | null;
}

function resetKeysChanged(
  previous: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined
): boolean {
  if (previous === next) return false;
  if (!previous || !next || previous.length !== next.length) return true;
  return previous.some((value, index) => !Object.is(value, next[index]));
}

/** Retry from a boundary: every query that failed without data starts over,
 * including ones whose component has not mounted yet (a route loader's
 * prefetch), which would otherwise rethrow their cached error without
 * fetching. A failed refresh keeps its data: resetting it would drop the
 * stale view, and only queries without data throw to a boundary. */
function resetFailedQueries(queryClient: QueryClient) {
  void queryClient.resetQueries({
    predicate: ({ state }) =>
      state.status === 'error' && state.data === undefined,
  });
}

class BoundaryCore extends Component<BoundaryCoreProps, BoundaryState> {
  state: BoundaryState = { error: null };
  #unsubscribeOnline?: () => void;

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Unhandled React error', error, info.componentStack);
  }

  // The failed queries' observers unmounted with the children, so
  // refetchOnReconnect cannot reach them; reset to remount and refetch.
  componentDidMount() {
    this.#unsubscribeOnline = onlineManager.subscribe((online) => {
      if (online && this.state.error) this.reset();
    });
  }

  componentWillUnmount() {
    this.#unsubscribeOnline?.();
  }

  componentDidUpdate(previous: BoundaryCoreProps) {
    if (
      this.state.error &&
      resetKeysChanged(previous.resetKeys, this.props.resetKeys)
    ) {
      this.reset();
    }
  }

  reset = () => {
    this.props.onReset();
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;

    const description = describeError(this.state.error);
    const reload = description.action === 'reload';
    const page = this.props.variant === 'page';
    const state = (
      <ErrorState
        action={
          <ErrorAction
            onClick={reload ? () => window.location.reload() : this.reset}
          >
            {reload ? m.error_action_reload() : m.error_action_retry()}
          </ErrorAction>
        }
        className="h-full w-full"
        description={description.description}
        errorId={unexpectedErrorId(this.state.error)}
        icon={description.icon}
        title={description.title}
        variant={page ? 'page' : 'panel'}
      />
    );
    // A panel boundary already sits in its panel's card (frosted over a page
    // frame); only the app-wide one draws a panel of its own.
    return page ? (
      <FallbackFrame className="h-dvh">{state}</FallbackFrame>
    ) : (
      state
    );
  }
}

export function AppErrorBoundary({
  children,
  resetKeys,
  variant = 'panel',
}: BoundaryProps) {
  const queryClient = useQueryClient();
  return (
    <BoundaryCore
      onReset={() => resetFailedQueries(queryClient)}
      resetKeys={resetKeys}
      variant={variant}
    >
      {children}
    </BoundaryCore>
  );
}

export function RouteErrorComponent({ error, reset }: ErrorComponentProps) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const description = describeError(error);
  const reload = description.action === 'reload';
  // Reloading the route also loads a page whose code failed offline again
  // (src/router.ts), and reruns its loader.
  const retry = useCallback(() => {
    resetFailedQueries(queryClient);
    reset();
    void router.invalidate();
  }, [queryClient, reset, router]);

  // Same as BoundaryCore: retry when the connection comes back.
  useEffect(
    () =>
      onlineManager.subscribe((online) => {
        if (online) retry();
      }),
    [retry]
  );

  return (
    <FallbackFrame className="h-full">
      <ErrorState
        action={
          <ErrorAction
            onClick={reload ? () => window.location.reload() : retry}
          >
            {reload ? m.error_action_reload() : m.error_action_retry()}
          </ErrorAction>
        }
        description={description.description}
        errorId={unexpectedErrorId(error)}
        icon={description.icon}
        title={description.title}
        variant="page"
      />
    </FallbackFrame>
  );
}

export function RouteNotFoundComponent() {
  return (
    <FallbackFrame className="h-full">
      <ErrorState
        action={
          <ErrorAction asChild back>
            <Link to="/">{m.error_action_go_back()}</Link>
          </ErrorAction>
        }
        description={m.error_not_found_page_body()}
        title={m.error_not_found_page_title()}
        variant="page"
      />
    </FallbackFrame>
  );
}
