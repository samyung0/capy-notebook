import 'fake-indexeddb/auto';
import { QueryClient } from '@tanstack/react-query';
import { clear, get } from 'idb-keyval';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { persisted, startQueryPersistence } from '@/api/queryPersistence';

const dropSourceOpens = vi.fn();
vi.mock('@/features/files/sourceOpen', () => ({ dropSourceOpens }));
vi.mock('@/lib/sourceCache', () => ({ claimSourceCache: vi.fn() }));
// Persistence flushes at the window's pagehide.
vi.stubGlobal('window', new EventTarget());

const KEY = 'capy-query-cache';
const ME = ['me'];

/** A visit by `identity` that stored its /me and left the page. */
async function storeVisit(identity: string) {
  const client = new QueryClient();
  const stop = startQueryPersistence(client, identity);
  await client.prefetchQuery({
    ...persisted,
    queryFn: () => ({ id: identity }),
    queryKey: ME,
  });
  window.dispatchEvent(new Event('pagehide'));
  stop();
  await vi.waitFor(async () => expect(await get(KEY)).toBeDefined());
}

/** A new page load: the account module starts with nothing held. */
async function loadPage() {
  vi.resetModules();
  const { paintStoredAccount, settleAccount } = await import('./accountCache');
  const client = new QueryClient();
  return {
    client,
    paint: () => paintStoredAccount(client),
    settle: (identity: string | null) => settleAccount(client, identity),
  };
}

describe('the account a page paints before Clerk answers', () => {
  beforeEach(async () => {
    await clear();
    dropSourceOpens.mockClear();
    await storeVisit('user_a');
  });

  it("paints the last account's stored lists, then keeps them when Clerk confirms it", async () => {
    const page = await loadPage();
    expect(await page.paint()).toBe('user_a');
    expect(page.client.getQueryData(ME)).toEqual({ id: 'user_a' });

    const stop = await page.settle('user_a');
    stop();
    expect(page.client.getQueryData(ME)).toEqual({ id: 'user_a' });
    expect(await get(KEY)).toMatchObject({ identity: 'user_a' });
    expect(dropSourceOpens).not.toHaveBeenCalled();
  });

  it('clears the client and deletes the store when Clerk answers with another account', async () => {
    const page = await loadPage();
    await page.paint();

    const stop = await page.settle('user_b');
    stop();
    expect(page.client.getQueryData(ME)).toBeUndefined();
    expect(await get(KEY)).toBeUndefined();
    await vi.waitFor(() => expect(dropSourceOpens).toHaveBeenCalled());
  });

  it('clears the client and deletes the store when Clerk answers signed out', async () => {
    const page = await loadPage();
    await page.paint();

    await page.settle(null);
    expect(page.client.getQueryData(ME)).toBeUndefined();
    expect(await get(KEY)).toBeUndefined();
  });
});
