import path from 'node:path';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Match src/main.tsx: MSW is on unless explicitly disabled.
  const useMsw = env.VITE_USE_MSW !== 'false' && mode === 'development';
  return {
    plugins: [
      react(),
      tailwindcss(),
      paraglideVitePlugin({
        outdir: './src/i18n/paraglide',
        project: './project.inlang',
        strategy: ['localStorage', 'preferredLanguage', 'baseLocale'],
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
        '@paraglide': path.resolve(import.meta.dirname, './src/i18n/paraglide'),
      },
    },
    server: {
      open: true,
      port: Number.parseInt(env.VITE_PORT, 10) || 5173,
      // Only proxy when hitting the real Go gateway. With MSW on, the service
      // worker normally intercepts /api in the browser — but during HMR / SW
      // updates a request can briefly leak to Vite. If the proxy is still
      // pointed at a down backend, that shows up as noisy ECONNREFUSED
      // (often /api/notifications or its notification stream).
      proxy: useMsw
        ? undefined
        : {
            '/api': {
              changeOrigin: true,
              // Forward E2E identity headers used by Playwright actor fixtures.
              configure: (proxy) => {
                proxy.on('proxyReq', (proxyReq, req) => {
                  const user = req.headers['x-e2e-user-id'];
                  const secret = req.headers['x-e2e-secret'];
                  if (typeof user === 'string')
                    proxyReq.setHeader('X-E2E-User-Id', user);
                  if (typeof secret === 'string')
                    proxyReq.setHeader('X-E2E-Secret', secret);
                });
              },
              target: env.VITE_API_URL || 'http://localhost:8080',
            },
          },
      // Plate is lazily imported behind a Suspense boundary, so nothing pulls
      // it until a note is opened and the transform then runs as a serial
      // import waterfall. Transforming it up front costs a few seconds of
      // start-up and saves ~10s on the first note opened — which under
      // Playwright is the difference between passing and timing out.
      warmup: { clientFiles: ['./src/features/notes/NoteEditor.tsx'] },
      watch: {
        ignored: [
          '**/pipeline/**',
          '**/old-pipeline/**',
          '**/server/**',
          '**/dist/**',
        ],
      },
    },
  };
});
