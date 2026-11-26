import { existsSync } from 'node:fs';
import { defineConfig, mergeConfig, type Plugin } from 'vite';
import base from '../../../vite.config';

/**
 * The app's production build for the benches that run it with MSW (built with
 * VITE_BENCH_MSW=true): the Plate editor's (`pnpm bench:editor`,
 * playwright.perf.config.ts) and the open-at-cap bench
 * (playwright.cap.config.ts). On top of the app's config it
 * - ships a service worker of its own (`BENCH_WORKER`) that keeps the build's
 *   chunks off MSW's worker, which waits on the page's main thread for every
 *   request it handles: its install step routes `/assets/*` on its own origin
 *   to the network (the static routing API), so those requests never reach a
 *   worker, as on UAT; where that API is missing its fetch listener stops them
 *   before MSW's, and the browser fetches them itself;
 * - builds in a checkout whose BetterOffice engines are not built (`pnpm
 *   office:prepare` compiles their WASM): neither bench opens an Office file,
 *   so each missing BetterOffice artifact resolves to an empty module, with a
 *   warning naming it. In CI, where the engines are built, a missing one fails
 *   the build instead (and no export is shimmed): the bench must measure what
 *   UAT's build would hold.
 */

const STUB = '\0cap-office-stub:';
const OFFICE = /betteroffice|office-runtime/;
/** Served from the root, so its scope is the whole app as MSW's is. */
const BENCH_WORKER = 'bench-msw.js';
const BENCH_WORKER_SOURCE = `// The MSW benches' service worker (bench/editor/scripts/vite.cap.config.ts).
self.addEventListener('install', (event) => {
  if (event.addRoutes)
    event.waitUntil(
      event.addRoutes({
        condition: {
          urlPattern: new URLPattern({
            baseURL: self.location.origin,
            pathname: '/assets/*',
          }),
        },
        source: 'network',
      })
    );
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith('/assets/'))
    event.stopImmediatePropagation();
});
importScripts('/mockServiceWorker.js');
`;
// CI builds with the engines: nothing is stubbed, so nothing needs shimming.
const shimMissingExports = !process.env.CI;

function withoutOfficeEngines(): Plugin {
  return {
    enforce: 'pre',
    load(id) {
      if (!id.startsWith(STUB)) return null;
      // A stylesheet's stub is read as CSS.
      return id.split('?')[0].endsWith('.css') ? '' : 'export default "";';
    },
    name: 'cap-without-office-engines',
    async resolveId(source, importer, options) {
      if (source.startsWith(STUB)) return source;
      if (!(OFFICE.test(source) || OFFICE.test(importer ?? ''))) return null;
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      const file = resolved?.id.split('?')[0];
      if (resolved && file && (!file.startsWith('/') || existsSync(file)))
        return resolved;
      const missing = `${source} (from ${importer ?? 'the entry'})`;
      if (process.env.CI) this.error(`BetterOffice artifact missing: ${missing}`);
      this.warn(`BetterOffice artifact missing, built as an empty module: ${missing}`);
      return STUB + source;
    },
  };
}

function benchWorker(): Plugin {
  return {
    apply: 'build',
    config: () => ({
      define: { __CAPY_BENCH_MSW_WORKER__: JSON.stringify(`/${BENCH_WORKER}`) },
    }),
    generateBundle() {
      this.emitFile({
        fileName: BENCH_WORKER,
        source: BENCH_WORKER_SOURCE,
        type: 'asset',
      });
    },
    name: 'bench-msw-worker',
  };
}

export default defineConfig(async (env) => {
  const app = await (typeof base === 'function' ? base(env) : base);
  const workerPlugins = app.worker?.plugins;
  return mergeConfig(app, {
    // A stubbed module exports nothing by name.
    build: { rollupOptions: { shimMissingExports } },
    plugins: [withoutOfficeEngines(), benchWorker()],
    // Workers are bundled with plugins of their own.
    worker: {
      plugins: () => [...(workerPlugins?.() ?? []), withoutOfficeEngines()],
      rollupOptions: { shimMissingExports },
    },
  });
});
