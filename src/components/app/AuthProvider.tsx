import { ClerkProvider, Show, useAuth } from '@clerk/react';
import { useEffect, useRef, useState } from 'react';
import { setAuthTokenGetter, USE_MSW } from '@/api/auth';
import { api } from '@/api/client';
import { queryClient } from '@/api/queryClient';
import { startQueryPersistence } from '@/api/queryPersistence';
import type { User } from '@/api/types';
import { Spinner } from '@/components/ui/feedback';
import { signInHref } from '@/features/auth/clerk';
import { dropSourceOpens } from '@/features/files/sourceOpen';
import { claimAccountData } from '@/lib/accountData';
import { claimSentOpens } from '@/lib/sentOpens';

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as
  | string
  | undefined;

type AuthProviderProps = {
  children: React.ReactNode;
  pending?: React.ReactNode;
};

function AuthTokenBridge({ children, pending }: AuthProviderProps) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const identity = isLoaded ? (userId ?? null) : undefined;
  const [readyIdentity, setReadyIdentity] = useState<string | null | undefined>(
    undefined
  );
  const previousIdentity = useRef<string | null | undefined>(undefined);

  // Workspace/material responses contain requester-specific capabilities and
  // ownership. Never reuse them after sign-in, sign-out, or account changes.
  // The account's stored cache from its last visit goes in before the route
  // loaders run; signing out deletes it, as it deletes the source bytes and
  // agent Undo payloads kept on the device and the record of sent opens
  // (another account signing in does too, r1 M1) and drops an Office open
  // started for the previous account.
  useEffect(() => {
    if (identity === undefined) return;
    if (previousIdentity.current !== identity) {
      queryClient.clear();
      dropSourceOpens();
      claimSentOpens(identity);
      previousIdentity.current = identity;
    }
    let cancelled = false;
    let stop: (() => void) | undefined;
    void Promise.all([
      startQueryPersistence(queryClient, identity),
      claimAccountData(identity),
    ]).then(([stopPersistence]) => {
      if (cancelled) return stopPersistence();
      stop = stopPersistence;
      setReadyIdentity(identity);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [identity]);

  useEffect(() => {
    if (!isLoaded) return;
    setAuthTokenGetter(isSignedIn ? () => getToken() : null);
    return () => {
      setAuthTokenGetter(null);
    };
  }, [getToken, isLoaded, isSignedIn]);

  // Route loaders must not run until the matching token getter is installed.
  if (!isLoaded || readyIdentity !== identity) {
    if (pending !== undefined) return <>{pending}</>;
    return (
      <div className="flex h-dvh items-center justify-center">
        <Spinner className="size-7" />
      </div>
    );
  }
  return <>{children}</>;
}

/** No Clerk (the real-stack browser specs, a local run with no key): the server
 * says whose browser this is, and what it keeps is claimed before any read, as
 * sign-in does. Otherwise nothing is ever kept and a reopen reads whole. */
function ServerAccountBridge({ children, pending }: AuthProviderProps) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void api
      .get<User>('/me')
      .then(
        ({ id }) => claimAccountData(id),
        () => claimAccountData(null)
      )
      .then(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (ready) return <>{children}</>;
  if (pending !== undefined) return <>{pending}</>;
  return (
    <div className="flex h-dvh items-center justify-center">
      <Spinner className="size-7" />
    </div>
  );
}

export function AppAuthProvider({ children, pending }: AuthProviderProps) {
  if (USE_MSW) return <>{children}</>;
  if (!PUBLISHABLE_KEY) {
    console.warn('VITE_CLERK_PUBLISHABLE_KEY missing — auth disabled');
    return (
      <ServerAccountBridge pending={pending}>{children}</ServerAccountBridge>
    );
  }
  return (
    <ClerkProvider
      afterSignOutUrl="/sign-in"
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
  return (
    <>
      <Show when="signed-in">{children}</Show>
      <Show when="signed-out">
        <RedirectToSignIn />
      </Show>
    </>
  );
}
