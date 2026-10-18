import { ClerkProvider, useAuth } from '@clerk/react';
import { useEffect, useState } from 'react';
import { setAuthTokenGetter, USE_MSW } from '@/api/auth';
import { queryClient } from '@/api/queryClient';
import { Spinner } from '@/components/ui/feedback';
import { signInHref } from '@/features/auth/clerk';
import { paintStoredAccount, settleAccount } from './accountCache';

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as
  | string
  | undefined;

type AuthProviderProps = {
  children: React.ReactNode;
  pending?: React.ReactNode;
};

function AuthTokenBridge({ children, pending }: AuthProviderProps) {
  const { getToken, isLoaded, userId } = useAuth();
  const identity = isLoaded ? (userId ?? null) : undefined;
  // The account the page renders for: the last visit's while Clerk loads,
  // painted from its stored cache, then Clerk's answer.
  const [readyIdentity, setReadyIdentity] = useState<string | null | undefined>(
    undefined
  );

  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    if (identity === undefined)
      void paintStoredAccount(queryClient).then((stored) => {
        if (!cancelled && stored !== null) setReadyIdentity(stored);
      });
    else
      void settleAccount(queryClient, identity).then((stopPersistence) => {
        if (cancelled) return stopPersistence();
        stop = stopPersistence;
        setReadyIdentity(identity);
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [identity]);

  // getToken waits for Clerk, so what a painted page requests leaves once
  // Clerk answers; signed out it resolves to no token.
  useEffect(() => {
    setAuthTokenGetter(() => getToken());
    return () => {
      setAuthTokenGetter(null);
    };
  }, [getToken]);

  // Route loaders must not run until the cache matches the account: before
  // Clerk answers that is the stored account, after it Clerk's.
  const ready =
    identity === undefined
      ? typeof readyIdentity === 'string'
      : readyIdentity === identity;
  if (!ready) {
    if (pending !== undefined) return <>{pending}</>;
    return (
      <div className="flex h-dvh items-center justify-center">
        <Spinner className="size-7" />
      </div>
    );
  }
  return <>{children}</>;
}

export function AppAuthProvider({ children, pending }: AuthProviderProps) {
  if (USE_MSW) return <>{children}</>;
  if (!PUBLISHABLE_KEY) {
    console.warn('VITE_CLERK_PUBLISHABLE_KEY missing — auth disabled');
    return <>{children}</>;
  }
  return (
    <ClerkProvider
      afterSignOutUrl="/sign-in"
      // Capy draws its own auth forms, so Clerk's prebuilt UI never loads; a
      // Clerk component added later needs it back (Epo 2026-10-18).
      prefetchUI={false}
      publishableKey={PUBLISHABLE_KEY}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
    >
      <AuthTokenBridge pending={pending}>{children}</AuthTokenBridge>
    </ClerkProvider>
  );
}

/** Sends the visitor to /sign-in with this page in the `redirect_url` query,
 * which every auth page reads and keeps. Clerk's RedirectToSignIn puts it in
 * the hash (`/sign-in#/?redirect_url=`), which our auth pages never read. */
function RedirectToSignIn() {
  useEffect(() => {
    window.location.assign(signInHref());
  }, []);
  return null;
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  if (USE_MSW || !PUBLISHABLE_KEY) return <>{children}</>;
  return <SignedInGate>{children}</SignedInGate>;
}

/** Signed out sends the visitor to sign-in. Before Clerk answers, the bridge
 * renders a page only for the stored account, which shows meanwhile. */
function SignedInGate({ children }: { children: React.ReactNode }) {
  const { isLoaded, userId } = useAuth();
  if (isLoaded && !userId) return <RedirectToSignIn />;
  return <>{children}</>;
}
