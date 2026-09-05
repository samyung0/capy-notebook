import path from 'node:path';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { llmRuntimePlugin } from './vite-llm-runtime';

const BETTEROFFICE_DOCX_SUBPATH = /^@betteroffice\/docx\/(.+)$/;

// Every component reads deploy/.env; see deploy/.env.example.
const ENV_DIR = path.resolve(import.meta.dirname, 'deploy');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ENV_DIR, '');
  // Match src/main.tsx: MSW is on unless explicitly disabled.
  const useMsw = env.VITE_USE_MSW !== 'false' && mode === 'development';
  // Public hostname when the dev server is served through a tunnel. A Clerk
  // production instance refuses to authenticate on localhost, so hitting a
  // deployed gateway from `pnpm dev` needs a real origin. Vite blocks unknown
  // Host headers, so the name is always allowed when set; only `pnpm
  // dev:public` repoints HMR at the tunnel's 443, because that override breaks
  // HMR for an ordinary localhost session.
  const devHost = env.VITE_DEV_HOST;
  const servePublic = devHost !== undefined && env.VITE_DEV_PUBLIC === 'true';
  return {
    assetsInclude: ['**/*.wasm'],
    build: {
      rollupOptions: {
        input: {
          llmRuntime: path.resolve(import.meta.dirname, 'llm-runtime.html'),
          main: path.resolve(import.meta.dirname, 'index.html'),
          officeRuntime: path.resolve(
            import.meta.dirname,
            'office-runtime.html'
          ),
        },
      },
    },
    envDir: ENV_DIR,
    optimizeDeps: {
      exclude: [
        '@betteroffice/docx',
        '@betteroffice/docx-react',
        '@betteroffice/docx/viewer',
        '@betteroffice/pptx',
        '@betteroffice/pptx/editor',
        '@betteroffice/pptx/viewer',
        '@betteroffice/pptx-react',
        '@betteroffice/xlsx',
        '@betteroffice/xlsx/collaboration',
        '@betteroffice/xlsx/editor',
        '@betteroffice/xlsx/viewer',
        '@betteroffice/xlsx-react',
        '@wllama/wllama',
      ],
    },
    plugins: [
      react(),
      tailwindcss(),
      llmRuntimePlugin(),
      paraglideVitePlugin({
        outdir: './src/i18n/paraglide',
        project: './project.inlang',
        strategy: ['localStorage', 'preferredLanguage', 'baseLocale'],
      }),
    ],
    resolve: {
      // Subpath entries must precede package roots. Vite matches string aliases
      // by prefix, so an object sorted by a formatter turns `/viewer` into
      // `index.ts/viewer`.
      alias: [
        {
          find: '@betteroffice/docx-react',
          replacement: path.resolve(
            import.meta.dirname,
            './vendor/betteroffice/packages/docx-react/src/index.ts'
          ),
        },
        {
          find: '@betteroffice/docx-i18n',
          replacement: path.resolve(
            import.meta.dirname,
            './vendor/betteroffice/packages/docx-i18n/src/index.ts'
          ),
        },
        {
          find: BETTEROFFICE_DOCX_SUBPATH,
          replacement: path.resolve(
            import.meta.dirname,
            './vendor/betteroffice/packages/docx/src/$1'
          ),
        },
        {
          find: '@betteroffice/docx',
          replacement: path.resolve(
            import.meta.dirname,
            './vendor/betteroffice/packages/docx/src/core.ts'
          ),
        },
        {
          find: '@betteroffice/pptx/editor',
          replacement: path.resolve(
            import.meta.dirname,
            './vendor/betteroffice/packages/pptx/src/editor.ts'
          ),
        },
        {
          find: '@betteroffice/pptx/viewer',
          replacement: path.resolve(
            import.meta.dirname,
            './vendor/betteroffice/packages/pptx/src/viewer.ts'
          ),
        },
        {
          find: '@betteroffice/xlsx/collaboration',
          replacement: path.resolve(
            import.meta.dirname,
            './vendor/betteroffice/packages/xlsx/src/collaboration/index.ts'
          ),
        },
        {
          find: '@betteroffice/xlsx/editor',
          replacement: path.resolve(
            import.meta.dirname,
            './vendor/betteroffice/packages/xlsx/src/editor.ts'
          ),
        },
        {
          find: '@betteroffice/xlsx/viewer',
          replacement: path.resolve(
            import.meta.dirname,
            './vendor/betteroffice/packages/xlsx/src/viewer.ts'
          ),
        },
        {
          find: '@betteroffice/pptx-react',
          replacement: path.resolve(
            import.meta.dirname,
            './vendor/betteroffice/packages/pptx-react/src/index.ts'
          ),
        },
        {
          find: '@betteroffice/pptx-i18n',
          replacement: path.resolve(
            import.meta.dirname,
            './vendor/betteroffice/packages/pptx-i18n/src/index.ts'
          ),
        },
        {
          find: '@betteroffice/pptx',
          replacement: path.resolve(
            import.meta.dirname,
            './vendor/betteroffice/packages/pptx/src/index.ts'
          ),
        },
        {
          find: '@betteroffice/xlsx-react',
          replacement: path.resolve(
            import.meta.dirname,
            './vendor/betteroffice/packages/xlsx-react/src/index.ts'
          ),
        },
        {
          find: '@betteroffice/xlsx-i18n',
          replacement: path.resolve(
            import.meta.dirname,
            './vendor/betteroffice/packages/xlsx-i18n/src/index.ts'
          ),
        },
        {
          find: '@betteroffice/xlsx',
          replacement: path.resolve(
            import.meta.dirname,
            './vendor/betteroffice/packages/xlsx/src/index.ts'
          ),
        },
        {
          find: '@paraglide',
          replacement: path.resolve(
            import.meta.dirname,
            './src/i18n/paraglide'
          ),
        },
        {
          find: '@',
          replacement: path.resolve(import.meta.dirname, './src'),
        },
      ],
    },
    server: {
      allowedHosts: devHost ? [devHost] : undefined,
      hmr: servePublic
        ? { clientPort: 443, host: devHost, protocol: 'wss' }
        : undefined,
      host: true,
      open: !servePublic,
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
    // The source-analysis worker imports PDF.js's own worker URL. ES workers
    // support that nested module split; Vite's IIFE worker output does not.
    worker: { format: 'es' },
  };
});
