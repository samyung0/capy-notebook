import { existsSync } from 'node:fs';
import { defineConfig, mergeConfig, type Plugin } from 'vite';
import base from '../../../vite.config';

/**
 * The app's build for the open-at-cap bench (playwright.cap.config.ts), in a
 * checkout whose BetterOffice engines are not built (`pnpm office:prepare`
 * compiles their WASM). The bench opens no Office file, so each BetterOffice
 * artifact that is missing resolves to an empty module and the rest of the
 * build is the app's own. With the engines built it changes nothing.
 */

const STUB = '\0cap-office-stub:';
const OFFICE = /betteroffice|office-runtime/;

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
      return STUB + source;
    },
  };
}

export default defineConfig(async (env) => {
  const app = await (typeof base === 'function' ? base(env) : base);
  const workerPlugins = app.worker?.plugins;
  return mergeConfig(app, {
    // A stubbed module exports nothing by name.
    build: { rollupOptions: { shimMissingExports: true } },
    plugins: [withoutOfficeEngines()],
    // Workers are bundled with plugins of their own.
    worker: {
      plugins: () => [...(workerPlugins?.() ?? []), withoutOfficeEngines()],
      rollupOptions: { shimMissingExports: true },
    },
  });
});
