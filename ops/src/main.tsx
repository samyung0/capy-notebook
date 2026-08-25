import { ClerkProvider } from '@clerk/react';
import * as Sentry from '@sentry/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { router } from '@/router';
import '@/styles.css';

const sentryDsn = import.meta.env.VITE_SENTRY_DSN;
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_APP_RELEASE,
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    mutations: {
      retry: false,
    },
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('The app root element is missing.');
}

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

createRoot(container).render(
  <StrictMode>
    {publishableKey ? (
      <ClerkProvider publishableKey={publishableKey}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <RouterProvider router={router} />
          </TooltipProvider>
        </QueryClientProvider>
      </ClerkProvider>
    ) : (
      <main className="grid min-h-dvh place-items-center p-6">
        <div className="max-w-md rounded-lg border bg-card p-6 shadow-sm">
          <h1 className="font-semibold text-lg">Clerk is not configured</h1>
          <p className="mt-2 text-muted-foreground text-sm">
            Set VITE_CLERK_PUBLISHABLE_KEY before starting the operator
            dashboard.
          </p>
        </div>
      </main>
    )}
  </StrictMode>
);
