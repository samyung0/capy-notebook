import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/** MathLive requests font filenames at runtime, so retain their package names.
 * Server-rendered notes also use MathLive's static stylesheet, served beside
 * them; it declares the same fonts. */
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
  // MathLive quotes `font-display:"swap"`, which browsers ignore (text then
  // waits for the font), and points at `fonts/` relative to itself, which
  // breaks once the Worker inlines the sheet into a page.
  fonts.set(
    '/mathlive/mathlive-static.css',
    Buffer.from(
      readFileSync(
        path.resolve('node_modules/mathlive/mathlive-static.css'),
        'utf8'
      )
        .replaceAll('font-display:"swap"', 'font-display:swap')
        .replaceAll('url(fonts/', 'url(/mathlive/fonts/')
    )
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
