import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/** MathLive requests font filenames at runtime, so retain their package names. */
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
  return {
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const bytes = fonts.get(request.url?.split('?')[0] ?? '');
        if (!bytes) return next();
        response.setHeader('Content-Type', 'font/woff2');
        response.end(bytes);
      });
    },
    generateBundle() {
      for (const [name, source] of fonts)
        this.emitFile({ fileName: name.slice(1), source, type: 'asset' });
    },
    name: 'mathlive-fonts',
  };
}
