import {
  MutationCache,
  type Query,
  QueryCache,
  QueryClient,
} from '@tanstack/react-query';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { trackQuotaBlocked } from '@/lib/analytics';
import {
  deferStorageRefusal,
  describeError,
  isAbortError,
  toastKeyFor,
} from '@/lib/errors';
import {
  deletedItemOf,
  isAccountBlockingError,
  isAccountForbiddenError,
  isApiError,
  qk,
} from './client';
import { isPersisted } from './queryPersistence';

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: {
      errorToast?: false;
    };
    queryMeta: {
      /** false: the component renders every error itself. 'unlessMissing':
       * it renders only private or missing (401/404); the rest throw. */
      errorBoundary?: false | 'unlessMissing';
    };
  }
}

/** Private or missing: one non-disclosing answer for both; deleted (410, a
 * trashed item its reader could open were it not, Q41) is missing too. */
export function isMissing(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.status === 404 || error.status === 401 || error.status === 410)
  );
}

/** Any query, whatever its error type. */
type AnyQuery = Query<unknown, unknown>;

/** When each query last answered a fetch: a cache write (`setQueryData`,
 * a restored store) is no answer. */
const answers = new WeakMap<AnyQuery, number>();

/** Notes a query's fetch answering, for `freshAnswer`; a `QueryCache`'s
 * `onSuccess`. */
export function noteAnswer(_data: unknown, query: AnyQuery) {
  answers.set(query, Date.now());
}

/** How long a fetch's answer still counts for a page opening on it: a hover's
 * preload or a route's loader lands seconds before the page shows, while an
 * answer from an earlier visit is no sign of this one, whatever its stale
 * time (review 2026-11-20). */
const OPENING_MS = 10_000;

/** Whether what a query holds is a fetch's answer from the last `OPENING_MS`,
 * not marked stale since: a page opening on it opens on a real read. */
export function freshAnswer(query: AnyQuery | undefined) {
  const at = query && answers.get(query);
  return (
    !!query &&
    at !== undefined &&
    query.state.status === 'success' &&
    !query.state.isInvalidated &&
    Date.now() - at < OPENING_MS
  );
}

function shouldRetry(failureCount: number, error: unknown): boolean {
  // A rate-limited read is the user's to retry, not ours.
  if (
    isApiError(error) &&
    (error.status === 401 ||
      error.status === 403 ||
      error.status === 404 ||
      error.status === 409 ||
      error.status === 410 ||
      error.status === 429)
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
      staleTime: 5 * 60 * 1000,
      throwOnError: (error, query) =>
        query.state.data === undefined &&
        query.meta?.errorBoundary !== false &&
        !(query.meta?.errorBoundary === 'unlessMissing' && isMissing(error)) &&
        !isAccountForbiddenError(error),
    },
  },
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      // Recorded before any deferral; a surface with its own message records
      // its own quota blocks.
      if (mutation.meta?.errorToast !== false)
        trackQuotaBlocked(error, 'mutation');
      // Before errorToast: a surface with its own message still defers a
      // frozen or storage refusal to the workspace status.
      if (deferStorageRefusal(error)) return;
      if (
        mutation.meta?.errorToast === false ||
        isAbortError(error) ||
        isAccountBlockingError(error)
      )
        return;
      showErrorToast(error);
    },
    // Recent rows come from many lists (files, materials, workspaces): any
    // write may rename, move, trash or create one, so every success marks it
    // stale. It refetches only where it shows (the dashboard).
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.recent });
    },
  }),
  queryCache: new QueryCache({
    // A failed refetch keeps its data. For a stored query that data can be
    // from an earlier visit, so a resource now private or missing drops it
    // and the page shows that state instead. A deleted one (`item_deleted`)
    // keeps it: its reader could still open it, and a page showing it keeps
    // its unsent edits and its header on that read (Q39).
    onError: (error, query) => {
      if (
        isMissing(error) &&
        !deletedItemOf(error) &&
        isPersisted(query) &&
        query.state.data !== undefined
      )
        query.setState({ data: undefined, dataUpdatedAt: 0 });
    },
    onSuccess: noteAnswer,
  }),
});

/** The mutation error toast; the dev scenario panel spawns it directly. */
export function showErrorToast(error: unknown) {
  const description = describeError(error);
  const button =
    description.action === 'subscription'
      ? {
          label: m.account_banner_subscription(),
          onClick: () => {
            window.location.href = '/billing?tab=subscription';
          },
        }
      : description.action === 'signIn'
        ? {
            label: m.action_sign_in(),
            onClick: () => {
              const returnTo = `${window.location.pathname}${window.location.search}`;
              window.location.href = `/sign-in?${new URLSearchParams({
                redirect_url: returnTo,
              })}`;
            },
          }
        : description.action === 'reload'
          ? {
              label: m.error_action_reload(),
              onClick: () => window.location.reload(),
            }
          : undefined;

  userToast({
    button,
    description: description.description,
    id: toastKeyFor(error),
    title: description.title,
    variant: 'error',
  });
}
