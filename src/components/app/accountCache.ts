import type { QueryClient } from '@tanstack/react-query';
import {
  deleteStoredQueries,
  restoreStoredQueries,
  startQueryPersistence,
} from '@/api/queryPersistence';
import { claimSourceCache } from '@/lib/sourceCache';

/** The account whose data the query client and the device's source bytes
 * hold; undefined until the stored cache is read. */
let held: string | null | undefined;
let painted: Promise<string | null> | undefined;

/**
 * Before Clerk answers: the last visit's account, read once per page load,
 * its stored cache restored into the client and the device's source bytes
 * claimed for it, so the page paints from it at once (Epo 2026-10-18). Null
 * without one.
 */
export function paintStoredAccount(client: QueryClient): Promise<string | null> {
  painted ??= restoreStoredQueries(client).then(async (stored) => {
    held = stored;
    if (stored !== null) await claimSourceCache(stored);
    return stored;
  });
  return painted;
}

/**
 * Clerk answered `identity` (null: signed out). Workspace/material responses
 * contain requester-specific capabilities and ownership, so another account
 * than the one held, or signing out, clears the client, deletes the stored
 * cache and drops an Office open started for the previous account; the
 * device's source bytes are claimed for `identity`. An account's cache is
 * then stored as it changes. Returns the stop function.
 */
export async function settleAccount(
  client: QueryClient,
  identity: string | null
): Promise<() => void> {
  await paintStoredAccount(client);
  const previous = held;
  if (previous !== identity) {
    held = identity;
    client.clear();
    // Only an account has a store or opens; the open code loads on demand,
    // so it stays out of the entry.
    if (previous !== null) {
      void import('@/features/files/sourceOpen').then((module) =>
        module.dropSourceOpens()
      );
      await deleteStoredQueries();
    }
  }
  await claimSourceCache(identity);
  return identity === null
    ? () => undefined
    : startQueryPersistence(client, identity);
}
