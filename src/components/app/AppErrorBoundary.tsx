import {
  onlineManager,
  type QueryClient,
  useQueryClient,
} from '@tanstack/react-query';
import { type ErrorComponentProps, Link } from '@tanstack/react-router';
import { Component, type ErrorInfo, type ReactNode, useEffect } from 'react';
import { ErrorAction } from '@/components/ui/Button';
import { m } from '@/i18n';
import { describeError } from '@/lib/errors';
import { ErrorState } from './ErrorState';
import { Panel } from './layout';

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
    return (
      <main className="h-dvh overflow-hidden p-1.5 sm:p-2.5">
        <Panel
          className="h-full w-full"
          sectionClassName="h-full w-full min-h-full flex flex-row"
        >
          <ErrorState
            action={
              <ErrorAction
                iconLeftClassName="me-1"
                onClick={reload ? () => window.location.reload() : this.reset}
              >
                {reload ? m.error_action_reload() : m.error_action_retry()}
              </ErrorAction>
            }
            className={
              this.props.variant === 'page' ? 'h-full w-full' : undefined
            }
            description={description.description}
            icon={description.icon}
            title={description.title}
            variant={this.props.variant ?? 'panel'}
          />
        </Panel>
      </main>
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
  const description = describeError(error);
  const reload = description.action === 'reload';
  const retry = () => {
    resetFailedQueries(queryClient);
    reset();
  };

  // Same as BoundaryCore: retry when the connection comes back.
  useEffect(
    () =>
      onlineManager.subscribe((online) => {
        if (!online) return;
        resetFailedQueries(queryClient);
        reset();
      }),
    [queryClient, reset]
  );

  return (
    <main className="h-full overflow-hidden p-1.5 sm:p-2.5">
      <Panel
        className="h-full w-full"
        sectionClassName="h-full w-full min-h-full flex flex-row"
      >
        <ErrorState
          action={
            <ErrorAction
              iconLeftClassName="me-1"
              onClick={reload ? () => window.location.reload() : retry}
            >
              {reload ? m.error_action_reload() : m.error_action_retry()}
            </ErrorAction>
          }
          description={description.description}
          icon={description.icon}
          title={description.title}
          variant="page"
        />
      </Panel>
    </main>
  );
}

export function RouteNotFoundComponent() {
  return (
    <main className="h-full overflow-hidden p-1.5 sm:p-2.5">
      <Panel
        className="h-full w-full"
        sectionClassName="h-full w-full min-h-full flex flex-row"
      >
        <ErrorState
          action={
            <ErrorAction
              asChild
              iconLeft="navigationBack"
              iconLeftClassName="me-1"
            >
              <Link to="/">{m.error_action_go_back()}</Link>
            </ErrorAction>
          }
          description={m.error_not_found_page_body()}
          title={m.error_not_found_page_title()}
          variant="page"
        />
      </Panel>
    </main>
  );
}
