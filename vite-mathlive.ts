import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/** MathLive requests font filenames at runtime, so retain their package names.
 * Server-rendered notes link MathLive's static stylesheets beside them, whose
 * `fonts/` URLs resolve to the same files. */
export function mathliveFonts(): Plugin {
  const directory = path.resolve('node_modules/mathlive/fonts');
  const fonts = new Map(
    readdirSync(directory)
      .filter((file) => file.endsWith('.woff2'))
      .map((file) => [
        `/mathlive/fonts/${file}`,
        readFileSync(path.join(directory, file)),
      ])
  );
  for (const sheet of ['mathlive-static.css', 'mathlive-fonts.css'])
    fonts.set(
      `/mathlive/${sheet}`,
      readFileSync(path.resolve('node_modules/mathlive', sheet))
    );
  return {
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const bytes = fonts.get(request.url?.split('?')[0] ?? '');
        if (!bytes) return next();
        response.setHeader(
          'Content-Type',
          request.url?.endsWith('.css') ? 'text/css' : 'font/woff2'
        );
        response.end(bytes);
      });
    },
    generateBundle() {
      // The share renderer's server build carries no assets.
      if (this.environment.config.consumer === 'server') return;
      for (const [name, source] of fonts)
        this.emitFile({ fileName: name.slice(1), source, type: 'asset' });
    },
    name: 'mathlive-fonts',
  };
}
