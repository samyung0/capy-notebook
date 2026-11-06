import { ClerkProvider, useAuth, useUser } from '@clerk/react';
import { useEffect } from 'react';
import { identifyAnalytics } from '@/lib/analytics';

function AnalyticsIdentity() {
  const { isLoaded, userId } = useAuth();
  const { isLoaded: userLoaded, user } = useUser();
  const email = user?.primaryEmailAddress?.emailAddress;

  useEffect(() => {
    if (isLoaded && userLoaded) identifyAnalytics(userId ?? null, email);
  }, [email, isLoaded, userId, userLoaded]);

  return null;
}

/** Loaded after first paint, only to tell analytics who a signed-in visitor is;
 * nothing on the page reads the session. It renders nothing, and share pages
 * show no Clerk components, so Clerk's UI bundle (about 256 KB) never loads. */
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
      <AnalyticsIdentity />
    </ClerkProvider>
  );
}
