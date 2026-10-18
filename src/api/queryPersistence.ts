import {
  type DehydratedState,
  dehydrate,
  hydrate,
  type QueryClient,
} from '@tanstack/react-query';
import { del, get, set } from 'idb-keyval';

/**
 * The query cache kept across visits, so a page paints from the last visit
 * while it refetches. Opt-in: a query definition spreads `persisted`; nothing
 * else is stored. File and note bodies, tokens, presigned links, live sessions,
 * billing and per-keystroke searches stay out (see
 * openwiki/frontend/error-handling.md#persisted-query-cache).
 */
export const PERSIST_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

/** The long gcTime keeps a restored query until it is used again, and marks
 * the query as one to store. */
export const persisted = { gcTime: PERSIST_MAX_AGE } as const;

const KEY = 'capy-query-cache';
const WRITE_DELAY = 1000;
const RELEASE =
  (import.meta.env.VITE_RELEASE_SHA as string | undefined) ?? 'dev';

interface StoredCache {
  /** The release it was written for; any other is discarded. */
  release: string;
  /** The account it holds. */
  identity: string;
  savedAt: number;
  state: DehydratedState;
}

export function isPersisted(query: { options: { gcTime?: number } }): boolean {
  return query.options.gcTime === PERSIST_MAX_AGE;
}

/** Infinite lists keep their first page: a refetch reloads every page held. */
function firstPageOnly(data: unknown): unknown {
  if (
    data &&
    typeof data === 'object' &&
    'pages' in data &&
    'pageParams' in data &&
    Array.isArray(data.pages) &&
    Array.isArray(data.pageParams)
  ) {
    return {
      pageParams: data.pageParams.slice(0, 1),
      pages: data.pages.slice(0, 1),
    };
  }
  return data;
}

export function dehydratePersisted(client: QueryClient): DehydratedState {
  return dehydrate(client, {
    serializeData: firstPageOnly,
    shouldDehydrateMutation: () => false,
    shouldDehydrateQuery: (query) =>
      query.state.status === 'success' && isPersisted(query),
  });
}

/** Deletes the stored cache (signing out, another account). */
export const deleteStoredQueries = () => del(KEY).catch(() => undefined);

/**
 * Restores the last account's stored cache into the empty client, before
 * Clerk confirms the session, so a page paints from it at once (Epo
 * 2026-10-18). Restored queries are marked stale, so each refetches on first
 * use while its stored data shows. Returns the account it holds, or null when
 * nothing usable was stored (the store is then empty).
 */
export async function restoreStoredQueries(
  client: QueryClient
): Promise<string | null> {
  const stored = await get<StoredCache>(KEY).catch(() => undefined);
  if (!stored) return null;
  if (
    stored.release !== RELEASE ||
    !stored.identity ||
    Date.now() - stored.savedAt >= PERSIST_MAX_AGE
  ) {
    await deleteStoredQueries();
    return null;
  }
  hydrate(client, stored.state, {
    defaultOptions: { queries: { gcTime: PERSIST_MAX_AGE } },
  });
  for (const { queryKey } of stored.state.queries)
    void client.invalidateQueries({
      exact: true,
      queryKey,
      refetchType: 'none',
    });
  return stored.identity;
}

/**
 * Keeps storing `identity`'s cache: at most once a second and at `pagehide`.
 * Returns the stop function.
 */
export function startQueryPersistence(
  client: QueryClient,
  identity: string
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = () => {
    timer = undefined;
    if (stopped) return;
    const value: StoredCache = {
      identity,
      release: RELEASE,
      savedAt: Date.now(),
      state: dehydratePersisted(client),
    };
    // A failed write (private mode, a full disk) only costs the next visit
    // its head start.
    void set(KEY, value).catch(() => undefined);
  };
  const flush = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    write();
  };
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (stopped || timer !== undefined || !isPersisted(event.query)) return;
    timer = setTimeout(write, WRITE_DELAY);
  });
  window.addEventListener('pagehide', flush);

  return () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
    window.removeEventListener('pagehide', flush);
  };
}
