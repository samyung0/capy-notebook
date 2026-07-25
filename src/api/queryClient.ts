import { QueryClient } from '@tanstack/react-query';
import { isApiError } from './client';

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
    },
  },
});
