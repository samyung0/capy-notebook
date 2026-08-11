import { MutationCache, QueryClient } from '@tanstack/react-query';
import { userToast } from '@/components/ui/userToast';
import { describeError, isAbortError, toastKeyFor } from '@/lib/errors';
import {
  isAccountBlockingError,
  isAccountForbiddenError,
  isApiError,
} from './client';

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: {
      errorToast?: false;
    };
    queryMeta: {
      errorBoundary?: false;
    };
  }
}

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (
    isApiError(error) &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  ) {
    return false;
  }
  return failureCount < 2;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: shouldRetry,
      staleTime: 30_000,
      throwOnError: (error, query) =>
        query.state.data === undefined &&
        query.meta?.errorBoundary !== false &&
        !isAccountForbiddenError(error),
    },
  },
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (
        mutation.meta?.errorToast === false ||
        isAbortError(error) ||
        isAccountBlockingError(error)
      )
        return;

      const description = describeError(error);
      const button =
        description.action === 'subscription'
          ? {
              label: 'Subscription',
              onClick: () => {
                window.location.href = '/subscription';
              },
            }
          : description.action === 'signIn'
            ? {
                label: 'Sign in',
                onClick: () => {
                  const returnTo = `${window.location.pathname}${window.location.search}`;
                  window.location.href = `/sign-in?${new URLSearchParams({
                    redirect_url: returnTo,
                  })}`;
                },
              }
            : undefined;

      userToast({
        button,
        description: description.description,
        id: toastKeyFor(error),
        title: description.title,
        variant: 'error',
      });
    },
  }),
});
