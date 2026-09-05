import { ClerkProvider, RedirectToSignIn, Show, useAuth } from '@clerk/react';
import { useEffect, useRef, useState } from 'react';
import { setAuthTokenGetter, USE_MSW } from '@/api/auth';
import { queryClient } from '@/api/queryClient';
import { m } from '@/i18n';

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

  useEffect(() => {
    if (!isLoaded) return;

    // Workspace/material responses contain requester-specific capabilities and
    // ownership. Never reuse them after sign-in, sign-out, or account changes.
    if (previousIdentity.current !== identity) {
      queryClient.clear();
      previousIdentity.current = identity;
    }
    setAuthTokenGetter(isSignedIn ? () => getToken() : null);
    setReadyIdentity(identity);

    return () => {
      setAuthTokenGetter(null);
    };
  }, [getToken, identity, isLoaded, isSignedIn]);

  // Route loaders must not run until the matching token getter is installed.
  if (!isLoaded || readyIdentity !== identity) {
    if (pending !== undefined) return <>{pending}</>;
    return (
      <div
        aria-label={m.a11y_loading()}
        className="flex h-dvh items-center justify-center"
        role="status"
      >
        {m.common_loading()}
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
    <ClerkProvider afterSignOutUrl="/sign-in" publishableKey={PUBLISHABLE_KEY}>
      <AuthTokenBridge pending={pending}>{children}</AuthTokenBridge>
    </ClerkProvider>
  );
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
