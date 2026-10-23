import type { Stats } from 'node:fs';
import path from 'node:path';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { DEV_SHARE_LINK_SECRET } from './src/lib/shareLink';
import { summaryVitePlugin } from './src/summary/vite';
import { embedFrame } from './vite-embed';
import { bucketOrigin, policyHeaders } from './vite-image-policy';
import { mathliveFonts } from './vite-mathlive';

const BETTEROFFICE_DOCX_SUBPATH = /^@betteroffice\/docx\/(.+)$/;
/** Modules the share renderer imports but never runs: components load them
 * in effects, on click or behind a context the share page fills itself
 * (AppEmbed). Its server build gets an empty module instead, keeping the site
 * Worker small. Matched on the import as written, relative or not. */
const BROWSER_ONLY =
  /^(jsxgraph|katex|mathlive|mermaid)$|\/(AppEmbed|editorAssets|HtmlEmbedSourceDialog|MediaPreview|mermaidPresets)$/;
const DEV_ENV_FILE = /^deploy\/\.env(?:\.[^/]+)?$/;
/** MSW's entry points (src/main.tsx, src/share). A build without MSW never
 * runs them, but Rollup loads every dynamic import, dead code included, and
 * loading the mocks emits their `?url` fixtures (Office files up to 23 MB) into
 * dist/: such a build gets an empty module instead. The editor benches build
 * with MSW on (`--mode development`) and keep them. */
const MSW_ENTRIES =
  /\/mocks\/(browser|collaboration)$|\/dev\/MockScenarioPanel$/;

// Every component reads deploy/.env; see deploy/.env.example.
const ENV_DIR = path.resolve(import.meta.dirname, 'deploy');
const WATCH_DIRECTORIES = [
  'src',
  'public',
  'messages',
  'project.inlang',
  'vendor/betteroffice/packages',
  'workers/site',
];

/** The origins an Office open connects to first, when the build knows them. */
function preconnects(env: Record<string, string>) {
  const origins: { crossorigin: boolean; href: string }[] = [];
  if (env.VITE_OFFICE_RUNTIME_ORIGIN)
    origins.push({
      crossorigin: false,
      href: new URL(env.VITE_OFFICE_RUNTIME_ORIGIN).origin,
    });
  const bucket = bucketOrigin(env);
  if (bucket) origins.push({ crossorigin: true, href: bucket });
  return origins;
}

export default defineConfig(({ command, isSsrBuild, mode }) => {
  const env = loadEnv(mode, ENV_DIR, '');
  // Match src/main.tsx: MSW is on unless explicitly disabled.
  const useMsw = env.VITE_USE_MSW !== 'false' && mode === 'development';
  // Caddy terminates local HTTPS; plain pnpm dev keeps the localhost lane.
  const serveLocalUat = mode === 'local-uat';
  const devHost = 'local.uat.capynotebook.com';
  if (
    serveLocalUat &&
    (env.VITE_USE_MSW !== 'false' ||
      env.VITE_API_URL !== 'https://uat-api.capynotebook.com' ||
      !env.VITE_CLERK_PUBLISHABLE_KEY?.startsWith('pk_live_') ||
      Buffer.from(
        env.VITE_CLERK_PUBLISHABLE_KEY.slice(8),
        'base64'
      ).toString() !== 'clerk.uat.capynotebook.com$')
  ) {
    throw new Error(
      'dev:uat requires VITE_USE_MSW=false, VITE_API_URL=https://uat-api.capynotebook.com and the UAT Clerk pk_live key in deploy/.env.'
    );
  }
  // Maps are generated only when they will be uploaded and then deleted, so a
  // released bundle ships none and a local build pays nothing for them.
  // Without them every browser stack trace in Sentry is minified.
  const uploadSourceMaps = Boolean(env.SENTRY_AUTH_TOKEN);
  // `vite build --ssr` builds the site Worker's share page renderer
  // (src/share/server.tsx) into dist/_ssr, which public/.assetsignore keeps
  // out of the static assets and wrangler.jsonc aliases as capy-share-render.
  const ssrBuild = isSsrBuild
    ? {
        copyPublicDir: false,
        emptyOutDir: false,
        minify: true,
        outDir: 'dist/_ssr',
        rollupOptions: {
          input: path.resolve(import.meta.dirname, 'src/share/server.tsx'),
          // Lazy imports stay their own chunks: the Worker's bundler then
          // runs them only when imported, which a server render never does
          // (the app's embed editor, the asset resolve, the media preview).
          // Inlined, every one of them ran on each isolate's first render
          // (ssr.target webworker inlines them unless told not to).
          output: {
            chunkFileNames: 'chunks/[name]-[hash].js',
            entryFileNames: 'server.js',
            inlineDynamicImports: false,
          },
        },
      }
    : undefined;
  return {
    assetsInclude: ['**/*.wasm'],
    build: ssrBuild ?? {
      rollupOptions: {
        input: {
          main: path.resolve(import.meta.dirname, 'index.html'),
          officeRuntime: path.resolve(
            import.meta.dirname,
            'office-runtime.html'
          ),
          share: path.resolve(import.meta.dirname, 'share.html'),
          summary: path.resolve(import.meta.dirname, 'summary.html'),
        },
      },
      sourcemap: uploadSourceMaps ? 'hidden' : false,
    },
    // Keep the seeded test server from invalidating a running developer server.
    cacheDir:
      env.VITE_E2E_EDITOR_SEED === 'true'
        ? 'node_modules/.vite-editor-e2e'
        : undefined,
    envDir: ENV_DIR,
    optimizeDeps: {
      // '@betteroffice/docx-react' stays scanned: it imports
      // @radix-ui/react-select, which only the fork installs, and finding that
      // on the first DOCX edit re-optimizes and reloads every open page.
      exclude: [
        '@betteroffice/docx',
        '@betteroffice/docx/viewer',
        '@betteroffice/pptx',
        '@betteroffice/pptx/editor',
        '@betteroffice/pptx/viewer',
        '@betteroffice/pptx-react',
        '@betteroffice/pptx-react/presentation',
        '@betteroffice/xlsx',
        '@betteroffice/xlsx/collaboration',
        '@betteroffice/xlsx/editor',
        '@betteroffice/xlsx/viewer',
        '@betteroffice/xlsx-react',
      ],
      // Worker imports (the export worker's, the Mermaid worker's linkedom)
      // are outside the initial crawl. Discovering these on the first Word
      // export or diagram otherwise reloads every open development page.
      include: [
        'buffer',
        'katex',
        'linkedom/worker',
        'pdfjs-dist/legacy/build/pdf.mjs',
      ],
    },
    plugins: [
      isSsrBuild && {
        enforce: 'pre' as const,
        load: (id: string) =>
          id === '\0browser-only' ? 'export default undefined;' : undefined,
        name: 'share-render-browser-only',
        resolveId: (id: string) =>
          BROWSER_ONLY.test(id) ? '\0browser-only' : undefined,
      },
      command === 'build' &&
        !useMsw && {
          enforce: 'pre' as const,
          load: (id: string) =>
            id === '\0no-mocks' ? 'export {};' : undefined,
          name: 'no-mocks-in-builds',
          resolveId: (id: string) =>
            MSW_ENTRIES.test(id) ? '\0no-mocks' : undefined,
        },
      // The release an open tab compares with its own when it regains focus
      // (src/lib/appRelease.ts); public/_headers serves it uncached.
      !isSsrBuild && {
        apply: 'build' as const,
        generateBundle() {
          if (env.VITE_RELEASE_SHA)
            this.emitFile({
              fileName: 'release.txt',
              source: env.VITE_RELEASE_SHA,
              type: 'asset',
            });
        },
        name: 'release-file',
      },
      // The Office open's connections start while the app boots: the
      // runtime's origin (its frame, with credentials) and the bucket (the
      // source bytes, fetched without). Only the app page opens files.
      !isSsrBuild && {
        name: 'office-preconnect',
        transformIndexHtml: (
          _html: string,
          { path: page }: { path: string }
        ) =>
          page === '/index.html'
            ? preconnects(env).map(({ crossorigin, href }) => ({
                attrs: {
                  href,
                  rel: 'preconnect',
                  ...(crossorigin && { crossorigin: '' }),
                },
                injectTo: 'head' as const,
                tag: 'link',
              }))
            : [],
      },
      react(),
      mathliveFonts(),
      embedFrame(env.VITE_EMBED_ORIGIN),
      policyHeaders(env),
      tailwindcss(),
      summaryVitePlugin(
        env.VITE_API_URL || 'http://localhost:8080',
        serveLocalUat
          ? `https://${devHost}`
          : `http://localhost:${Number.parseInt(env.VITE_PORT, 10) || 5173}`,
        useMsw,
        // MSW signs its mock links with the dev secret (src/mocks/db.ts).
        useMsw || !env.SHARE_LINK_SECRET
          ? DEV_SHARE_LINK_SECRET
          : env.SHARE_LINK_SECRET
      ),
      paraglideVitePlugin({
        outdir: './src/i18n/paraglide',
        project: './project.inlang',
        strategy: ['localStorage', 'preferredLanguage', 'baseLocale'],
      }),
      uploadSourceMaps &&
        !isSsrBuild &&
        sentryVitePlugin({
          authToken: env.SENTRY_AUTH_TOKEN,
          org: env.SENTRY_ORG,
          project: env.SENTRY_PROJECT,
          release: { name: env.VITE_RELEASE_SHA },
          sourcemaps: { filesToDeleteAfterUpload: ['./dist/**/*.map'] },
          // The EU region has its own API host; the US default silently
          // uploads nothing an EU organization can resolve.
          url: env.SENTRY_URL,
        }),
    ],
    resolve: {
      // Subpath entries must precede package roots. Vite matches string aliases
      // by prefix, so an object sorted by a formatter turns `/viewer` into
      // `index.ts/viewer`.
      alias: [
        ...(useMsw
          ? [
              {
                find: '@/features/auth/clerkHooks',
                replacement: path.resolve(
                  import.meta.dirname,
                  './src/mocks/auth.tsx'
                ),
              },
            ]
          : []),
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
          find: '@betteroffice/fonts',
          replacement: path.resolve(
            import.meta.dirname,
            './vendor/betteroffice/packages/fonts/src/index.ts'
          ),
        },
        {
          find: '@betteroffice/fonts-cjk',
          replacement: path.resolve(
            import.meta.dirname,
            './vendor/betteroffice/packages/fonts-cjk/src/index.ts'
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
          find: '@betteroffice/pptx-react/presentation',
          replacement: path.resolve(
            import.meta.dirname,
            './vendor/betteroffice/packages/pptx-react/src/presentation.ts'
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
          find: 'capy-share-render',
          replacement: path.resolve(
            import.meta.dirname,
            './src/share/server.tsx'
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
      // Tunnels give phones an HTTPS origin, which MSW's service worker needs:
      // quick tunnels (cloudflared tunnel --url) or a developer's named one
      // (dev-<name>.capynotebook.com).
      allowedHosts: serveLocalUat
        ? [devHost]
        : ['.trycloudflare.com', '.capynotebook.com'],
      // DEV_HMR=off stops pushed updates and reloads while files keep
      // changing (e.g. agents editing); a manual refresh still serves the
      // latest code. Vite has no CLI flag for this.
      hmr:
        env.DEV_HMR === 'off'
          ? false
          : serveLocalUat
            ? { clientPort: 443, host: devHost, protocol: 'wss' }
            : undefined,
      host: serveLocalUat ? '127.0.0.1' : true,
      open: !serveLocalUat,
      port: serveLocalUat ? 5173 : Number.parseInt(env.VITE_PORT, 10) || 5173,
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
      strictPort: serveLocalUat,
      // Plate is lazily imported behind a Suspense boundary, so nothing pulls
      // it until a note is opened and the transform then runs as a serial
      // import waterfall. Transforming it up front costs a few seconds of
      // start-up and saves ~10s on the first note opened — which under
      // Playwright is the difference between passing and timing out.
      warmup: { clientFiles: ['./src/features/notes/NoteEditor.tsx'] },
      watch: {
        // chokidar hands the predicate a second `stats` argument that its
        // anymatch type does not declare, so it stays optional here.
        ignored: (file: string, stats?: Stats) => {
          const relative = path
            .relative(import.meta.dirname, file)
            .split(path.sep)
            .join('/');
          // Keep ancestors traversable and root config/HTML files watchable.
          if (!relative || relative.startsWith('../')) return false;
          if (!relative.includes('/') && !stats?.isDirectory()) return false;
          if (relative === 'deploy' || DEV_ENV_FILE.test(relative))
            return false;
          return !WATCH_DIRECTORIES.some(
            (directory) =>
              relative === directory ||
              relative.startsWith(`${directory}/`) ||
              directory.startsWith(`${relative}/`)
          );
        },
      },
    },
    // The Worker has no Node built-ins or packages at runtime: bundle all.
    ssr: isSsrBuild ? { noExternal: true, target: 'webworker' } : undefined,
    // The source-analysis worker imports PDF.js's own worker URL. ES workers
    // support that nested module split; Vite's IIFE worker output does not.
    worker: { format: 'es' },
  };
});
