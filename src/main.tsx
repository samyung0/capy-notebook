import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { lazy, StrictMode, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { queryClient } from './api/queryClient';
import { AppErrorBoundary } from './components/app/AppErrorBoundary';
import { AppAuthProvider } from './components/app/AuthProvider';
import { router } from './router';
import { ThemeProvider } from './theme/ThemeProvider';
import './styles/tailwind.css';
import 'streamdown/styles.css';
import { TooltipProvider } from './components/ui/Tooltip';

// Mocks are on by default; set VITE_USE_MSW=false to hit the real Go gateway
// (Vite proxies /api → http://localhost:8080).
const USE_MOCKS =
  import.meta.env.VITE_USE_MSW !== 'false' &&
  import.meta.env.MODE === 'development';
const MockScenarioPanel = USE_MOCKS
  ? lazy(() => import('./components/dev/MockScenarioPanel'))
  : null;
async function enableMocks() {
  if (!USE_MOCKS) return;
  const { startMockServer } = await import('./mocks/browser');
  const { registerMockCollaborationProvider } = await import(
    './mocks/collaboration'
  );
  registerMockCollaborationProvider();
  await startMockServer();
}

enableMocks().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ThemeProvider>
        <AppAuthProvider>
          <QueryClientProvider client={queryClient}>
            <AppErrorBoundary variant="page">
              <TooltipProvider>
                <RouterProvider context={{ queryClient }} router={router} />

                {MockScenarioPanel && (
                  <Suspense fallback={null}>
                    <MockScenarioPanel />
                  </Suspense>
                )}
              </TooltipProvider>
            </AppErrorBoundary>
            {/* no need for query dev tools for now */}
            {/* {import.meta.env.DEV && <ReactQueryDevtools />} */}
            {/* Outside the router so public /share routes and router error
                boundaries can surface toasts too. */}
            {createPortal(<Toaster visibleToasts={3} />, document.body)}
          </QueryClientProvider>
        </AppAuthProvider>
      </ThemeProvider>
    </StrictMode>
  );
});
