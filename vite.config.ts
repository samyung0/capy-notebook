import path from 'node:path';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
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
      // When MSW is disabled (VITE_USE_MSW=false) /api hits the Go gateway.
      // With MSW on, the service worker intercepts before the proxy, so this is
      // harmless either way.
      proxy: {
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
