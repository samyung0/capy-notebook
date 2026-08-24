import {
  ClerkLoaded,
  ClerkLoading,
  ClerkProvider,
  SignIn,
  useAuth,
} from '@clerk/react';
import * as Sentry from '@sentry/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Skeleton } from './components/ui/skeleton';
import { router } from './router';
import './styles.css';

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const rootElement = document.getElementById('root');
const sentryDsn = import.meta.env.VITE_SENTRY_DSN;
if (typeof sentryDsn === 'string' && sentryDsn.trim() !== '') {
  Sentry.init({
    dsn: sentryDsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_RELEASE_SHA,
    sendDefaultPii: false,
  });
}
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 10_000,
    },
  },
});

function AuthenticatedRoot() {
  const { isSignedIn } = useAuth();
  if (!isSignedIn) {
    return (
      <main className="grid min-h-screen place-items-center p-4">
        <SignIn routing="hash" />
      </main>
    );
  }
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

if (!rootElement) {
  throw new Error('Missing #root element.');
}

const root = createRoot(rootElement);

if (typeof publishableKey !== 'string' || publishableKey.trim() === '') {
  root.render(
    <main className="grid min-h-screen place-items-center p-6">
      <div className="max-w-lg rounded-xl border bg-card p-6 shadow-sm">
        <h1 className="font-semibold text-xl">
          Ops authentication is not configured
        </h1>
        <p className="mt-2 text-muted-foreground text-sm">
          Set VITE_CLERK_PUBLISHABLE_KEY before building this standalone app.
        </p>
      </div>
    </main>
  );
} else {
  root.render(
    <StrictMode>
      <ClerkProvider publishableKey={publishableKey}>
        <ClerkLoading>
          <main
            aria-label="Loading authentication"
            className="grid min-h-screen place-items-center"
            role="status"
          >
            <div className="space-y-3">
              <Skeleton className="mx-auto size-12 rounded-xl" />
              <Skeleton className="h-5 w-56" />
            </div>
          </main>
        </ClerkLoading>
        <ClerkLoaded>
          <AuthenticatedRoot />
        </ClerkLoaded>
      </ClerkProvider>
    </StrictMode>
  );
}
