import { parseHTML } from 'linkedom';
import { act, useEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

type Auth = { isLoaded: boolean; isSignedIn?: boolean; userId?: string | null };
const clerk = vi.hoisted(() => ({
  auth: { isLoaded: false } as Auth,
  claim: (_owner: string | null) => Promise.resolve(),
}));

vi.mock('@clerk/react', () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => children,
  Show: () => null,
  useAuth: () => ({ ...clerk.auth, getToken: () => Promise.resolve('t') }),
}));
vi.mock('@/api/queryPersistence', () => ({
  startQueryPersistence: () => Promise.resolve(() => undefined),
}));
vi.mock('@/lib/accountData', () => ({
  claimAccountData: (owner: string | null) => clerk.claim(owner),
}));
vi.mock('@/lib/sentOpens', () => ({ claimSentOpens: () => undefined }));
vi.mock('@/features/canvas/useCanvasMaterials', () => ({
  forgetMadeMaterials: () => undefined,
}));
vi.mock('@/features/files/sourceOpen', () => ({
  dropSourceOpens: () => undefined,
}));

const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
// A first visit to the sign-in form: no Clerk cookie.
Object.defineProperty(window, 'location', { value: { pathname: '/sign-in' } });
Object.defineProperty(document, 'cookie', { value: '' });
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });
vi.stubEnv('VITE_CLERK_PUBLISHABLE_KEY', 'pk_test_capy');
const { createRoot } = await import('react-dom/client');
const { AppAuthProvider } = await import('./AuthProvider');

let mounts = 0;
function Form() {
  useEffect(() => {
    mounts += 1;
  }, []);
  return <form id="form" />;
}

const root = createRoot(document.getElementById('root') as never);
async function show(auth: Auth) {
  clerk.auth = auth;
  await act(async () =>
    root.render(
      <AppAuthProvider>
        <Form />
      </AppAuthProvider>
    )
  );
}

/** An account claim that finishes when the test says. */
function held() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const drawn = () =>
  document.getElementById('form')
    ? 'form'
    : document.querySelector('[role="status"]')
      ? 'loader'
      : 'nothing';

afterEach(async () => {
  await act(async () => root.render(null));
  mounts = 0;
  clerk.claim = () => Promise.resolve();
});

// Q905: the form draws before Clerk loads and stays mounted when Clerk
// confirms there is no session, so typing is never lost.
it('keeps the early auth form mounted when Clerk finds no session', async () => {
  await show({ isLoaded: false });
  expect(drawn()).toBe('form');
  await show({ isLoaded: true, isSignedIn: false, userId: null });
  expect(drawn()).toBe('form');
  expect(mounts).toBe(1);
});

it('waits for a session Clerk does find, and for a later sign-out', async () => {
  await show({ isLoaded: false });
  let claimed = held();
  clerk.claim = () => claimed.promise;
  await show({ isLoaded: true, isSignedIn: true, userId: 'user_1' });
  expect(drawn()).toBe('loader');
  await act(async () => claimed.resolve());
  expect(drawn()).toBe('form');

  // Signed out later: the old account's pages wait for the cleared one (r1 S2).
  claimed = held();
  await show({ isLoaded: true, isSignedIn: false, userId: null });
  expect(drawn()).toBe('loader');
  await act(async () => claimed.resolve());
  expect(drawn()).toBe('form');
});
