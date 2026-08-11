import { useQueryErrorResetBoundary } from '@tanstack/react-query';
import { type ErrorComponentProps, Link } from '@tanstack/react-router';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { m } from '@/i18n';
import { describeError, privateErrorDescription } from '@/lib/errors';
import { ErrorState } from './ErrorState';

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

class BoundaryCore extends Component<BoundaryCoreProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Unhandled React error', error, info.componentStack);
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
      <ErrorState
        action={
          <Button
            onClick={reload ? () => window.location.reload() : this.reset}
          >
            {reload ? m.error_action_reload() : m.error_action_retry()}
          </Button>
        }
        className={
          this.props.variant === 'page'
            ? 'min-h-dvh w-full bg-page text-fg'
            : undefined
        }
        description={description.description}
        title={description.title}
        variant={this.props.variant ?? 'panel'}
      />
    );
  }
}

export function AppErrorBoundary({
  children,
  resetKeys,
  variant = 'panel',
}: BoundaryProps) {
  const { reset } = useQueryErrorResetBoundary();
  return (
    <BoundaryCore onReset={reset} resetKeys={resetKeys} variant={variant}>
      {children}
    </BoundaryCore>
  );
}

export function RouteErrorComponent({ error, reset }: ErrorComponentProps) {
  const { reset: resetQueries } = useQueryErrorResetBoundary();
  const description = describeError(error);
  const reload = description.action === 'reload';
  const retry = () => {
    resetQueries();
    reset();
  };

  return (
    <ErrorState
      action={
        <Button onClick={reload ? () => window.location.reload() : retry}>
          {reload ? m.error_action_reload() : m.error_action_retry()}
        </Button>
      }
      description={description.description}
      title={description.title}
      variant="page"
    />
  );
}

export function ShareRouteErrorComponent({ reset }: ErrorComponentProps) {
  const { reset: resetQueries } = useQueryErrorResetBoundary();
  const description = privateErrorDescription();

  return (
    <ErrorState
      action={
        <Button
          onClick={() => {
            resetQueries();
            reset();
          }}
        >
          {m.error_action_retry()}
        </Button>
      }
      description={description.description}
      testId="private-or-unavailable"
      title={description.title}
      variant="page"
    />
  );
}

export function RouteNotFoundComponent() {
  return (
    <ErrorState
      action={
        <Button asChild iconLeft="chevronLeft">
          <Link to="/">{m.error_action_go_back()}</Link>
        </Button>
      }
      description={m.error_not_found_page_body()}
      title={m.error_not_found_page_title()}
      variant="page"
    />
  );
}
