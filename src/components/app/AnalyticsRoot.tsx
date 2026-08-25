import { useAuth, useUser } from '@clerk/react';
import { useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { USE_MSW } from '@/api/auth';
import { useMe } from '@/api/hooks';
import { identifyUser, trackPageView } from '@/lib/observability';

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as
  | string
  | undefined;

function ClerkAnalyticsIdentity() {
  const { isLoaded, userId } = useAuth();
  const { isLoaded: userLoaded, user } = useUser();
  const email = user?.primaryEmailAddress?.emailAddress;

  useEffect(() => {
    if (!isLoaded || !userLoaded) return;
    identifyUser(userId ?? null, email);
  }, [email, isLoaded, userId, userLoaded]);

  return null;
}

function MswAnalyticsIdentity() {
  const { data: me, isError } = useMe({ errorBoundary: false });

  useEffect(() => {
    if (me) {
      identifyUser(me.id, me.email);
      return;
    }
    if (isError) identifyUser(null);
  }, [isError, me]);

  return null;
}

function AnalyticsIdentity() {
  if (USE_MSW) return <MswAnalyticsIdentity />;
  if (!PUBLISHABLE_KEY) return null;
  return <ClerkAnalyticsIdentity />;
}

function AnalyticsPageViews() {
  const path = useRouterState({
    select: (state) => {
      const leaf = state.matches.at(-1);
      return leaf?.fullPath ?? state.location.pathname;
    },
  });

  useEffect(() => {
    trackPageView(path);
  }, [path]);

  return null;
}

export function AnalyticsRoot() {
  return (
    <>
      <AnalyticsIdentity />
      <AnalyticsPageViews />
    </>
  );
}
