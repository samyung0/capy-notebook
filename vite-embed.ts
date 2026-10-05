import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import type { Plugin } from 'vite';

const EMBED_DIR = path.resolve(import.meta.dirname, 'embed');

/**
 * Serves embed/ during `vite` dev at VITE_EMBED_ORIGIN when that is a loopback
 * http origin, with the headers Pages reads from embed/_headers. The frame must
 * be another site than the app (127.0.0.1 next to localhost): another port
 * alone is the same site and shares the app's renderer process.
 */
export function embedFrame(origin: string | undefined): Plugin {
  return {
    apply: 'serve',
    configureServer(server) {
      if (!origin) return;
      const url = new URL(origin);
      if (
        url.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost'].includes(url.hostname)
      )
        return;
      const frame = createServer((request, response) => {
        if (request.url !== '/') {
          response.writeHead(404).end();
          return;
        }
        // The file holds one `/*` rule; its indented lines are the headers.
        const headers = readFileSync(path.join(EMBED_DIR, '_headers'), 'utf8')
          .split('\n')
          .filter((line) => line.startsWith(' '))
          .map((line) => {
            const colon = line.indexOf(':');
            return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
          });
        response.writeHead(200, {
          ...Object.fromEntries(headers),
          'Content-Type': 'text/html; charset=utf-8',
        });
        response.end(readFileSync(path.join(EMBED_DIR, 'index.html')));
      });
      // Another dev server (or worktree) may already serve the frame there.
      frame.on('error', (error) =>
        server.config.logger.warn(
          `embed frame not served at ${url.origin}: ${error.message}`
        )
      );
      // Vite builds the new server before closing the old one on restart.
      server.httpServer?.once('listening', () =>
        frame.listen(Number(url.port), url.hostname)
      );
      server.httpServer?.once('close', () => frame.close());
    },
    name: 'embed-frame',
  };
}
