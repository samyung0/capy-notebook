import fs from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

/** Use the deployed renderer for local full-stack and tunnel sessions too. */
export function summaryVitePlugin(
  apiOrigin: string,
  appOrigin: string
): Plugin {
  return {
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = req.url?.split('?')[0] ?? '';
        if (
          !pathname.startsWith('/w/') &&
          !pathname.startsWith('/share/workspaces/')
        )
          return next();
        try {
          const { handleSiteRequest } = await server.ssrLoadModule(
            '/workers/site/handler.ts'
          );
          const request = new Request(new URL(req.url ?? '/', appOrigin), {
            headers: {
              'Accept-Language': String(req.headers['accept-language'] ?? 'en'),
            },
            method: req.method,
          });
          const response: Response = await handleSiteRequest(request, {
            API_ORIGIN: apiOrigin,
            APP_ORIGIN: appOrigin,
            ASSETS: {
              fetch: async () =>
                new Response(
                  await server.transformIndexHtml(
                    '/summary.html',
                    await fs.readFile(
                      path.resolve(server.config.root, 'summary.html'),
                      'utf8'
                    )
                  )
                ),
            },
          });
          res.statusCode = response.status;
          response.headers.forEach((value, key) => {
            res.setHeader(key, value);
          });
          res.end(await response.text());
        } catch (error) {
          next(error);
        }
      });
    },
    name: 'capy-workspace-summary',
  };
}
