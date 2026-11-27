import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('./clerkSession');
});

/** Boots bootSignIn at `address` with `cookie`, and returns where it moved. */
async function boot(address: string, cookie = '', clerkActive = true) {
  const { pathname, search } = new URL(address, 'https://uat.test');
  const location = { pathname, search };
  const replaceState = vi.fn();
  vi.stubGlobal('location', location);
  vi.stubGlobal('window', { location });
  vi.stubGlobal('document', { cookie });
  vi.stubGlobal('history', { replaceState, state: null });
  vi.resetModules();
  vi.doMock('./clerkSession', async (load) => ({
    ...(await load<typeof import('./clerkSession')>()),
    clerkActive,
  }));
  await import('./bootSignIn');
  return replaceState.mock.calls.map(([, , url]) => url);
}

// Q905: a visitor with no session meets the sign-in form without the
// signed-in page first, and comes back to that page after signing in.
it('moves a visitor with no session from a signed-in page to sign-in', async () => {
  expect(await boot('/workspaces/ws_1?material=mat_1')).toEqual([
    '/sign-in?redirect_url=%2Fworkspaces%2Fws_1%3Fmaterial%3Dmat_1',
  ]);
  expect(await boot('/', '__client_uat=0')).toEqual([
    '/sign-in?redirect_url=%2F',
  ]);
});

it('leaves public pages, signed-in visitors and runs without Clerk alone', async () => {
  expect(await boot('/sign-in?redirect_url=%2F')).toEqual([]);
  expect(await boot('/workspace-invites/inv_1')).toEqual([]);
  expect(await boot('/workspaces', '__client_uat=1795740952')).toEqual([]);
  expect(await boot('/workspaces', '', false)).toEqual([]);
});
