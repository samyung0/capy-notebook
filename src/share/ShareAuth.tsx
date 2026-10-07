import { ClerkFailed, ClerkProvider, useAuth, useUser } from '@clerk/react';
import { useEffect } from 'react';
import { setAuthTokenGetter } from '@/api/auth';
import { identifyAnalytics } from '@/lib/analytics';
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
    if (isLoaded && userLoaded) identifyAnalytics(userId ?? null, email);
  }, [email, isLoaded, userId, userLoaded]);

  return null;
}

/** Without Clerk there is no token, so saving can only happen in the browser. */
function Failed() {
  useEffect(() => settleSession(false), []);
  return null;
}

/** Loaded after first paint; renders nothing on the page. Share pages show no
 * Clerk components, so Clerk's UI bundle (about 256 KB) never loads. */
export default function ShareAuth({
  publishableKey,
}: {
  publishableKey: string;
}) {
  return (
    <ClerkProvider
      afterSignOutUrl="/sign-in"
      prefetchUI={false}
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
