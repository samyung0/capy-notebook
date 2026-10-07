import { ClerkFailed, ClerkProvider, useAuth, useUser } from '@clerk/react';
import { useEffect } from 'react';
import { setAuthTokenGetter } from '@/api/auth';
import { identifyUser } from '@/lib/observability';
import { settleSession } from './session';

function SessionBridge() {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const { isLoaded: userLoaded, user } = useUser();
  const email = user?.primaryEmailAddress?.emailAddress;

  useEffect(() => {
    if (!isLoaded) return;
    setAuthTokenGetter(isSignedIn ? () => getToken() : null);
    settleSession(Boolean(isSignedIn));
  }, [getToken, isLoaded, isSignedIn]);

  useEffect(() => {
    if (isLoaded && userLoaded) identifyUser(userId ?? null, email);
  }, [email, isLoaded, userId, userLoaded]);

  return null;
}

/** Without Clerk there is no token, so saving can only happen in the browser. */
function Failed() {
  useEffect(() => settleSession(false), []);
  return null;
}

/** Loaded after first paint; renders nothing on the page. */
export default function ShareAuth({
  publishableKey,
}: {
  publishableKey: string;
}) {
  return (
    <ClerkProvider
      afterSignOutUrl="/sign-in"
      publishableKey={publishableKey}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
    >
      <SessionBridge />
      <ClerkFailed>
        <Failed />
      </ClerkFailed>
    </ClerkProvider>
  );
}
