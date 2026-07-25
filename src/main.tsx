import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { queryClient } from './api/queryClient';
import { AppAuthProvider } from './components/app/AuthProvider';
import { router } from './router';
import { ThemeProvider } from './theme/ThemeProvider';
import './styles/tailwind.css';
import 'streamdown/styles.css';

// Mocks are on by default; set VITE_USE_MSW=false to hit the real Go gateway
// (Vite proxies /api → http://localhost:8080).
const USE_MOCKS =
  import.meta.env.VITE_USE_MSW !== 'false' &&
  import.meta.env.MODE === 'development';
async function enableMocks() {
  if (!USE_MOCKS) return;
  const { startMockServer } = await import('./mocks/browser');
  await startMockServer();
}

enableMocks().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ThemeProvider>
        <AppAuthProvider>
          <QueryClientProvider client={queryClient}>
            <RouterProvider context={{ queryClient }} router={router} />
          </QueryClientProvider>
        </AppAuthProvider>
      </ThemeProvider>
    </StrictMode>
  );
});
