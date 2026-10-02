import fs from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

/** Use the deployed renderer for local full-stack and tunnel sessions too. */
export function summaryVitePlugin(
  apiOrigin: string,
  appOrigin: string,
  useMsw: boolean,
  shareLinkSecret: string
): Plugin {
  return {
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = req.url?.split('?')[0] ?? '';
        // Under MSW the browser worker answers /p/ routes itself.
        const isPublic = pathname.startsWith('/p/') && !useMsw;
        if (!pathname.startsWith('/w/') && !isPublic) return next();
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
          // Browser MSW cannot intercept this server-side request.
          const fetchSummary: typeof fetch = useMsw
            ? async (input) => {
                const { mockWorkspaceSummary } = await server.ssrLoadModule(
                  '/src/mocks/workspaceSummary.ts'
                );
                const id = new URL(
                  input instanceof Request ? input.url : String(input)
                ).pathname.split('/')[4];
                const summary = mockWorkspaceSummary(id);
                return summary
                  ? Response.json(summary)
                  : new Response(null, { status: 404 });
              }
            : fetch;
          const response: Response = await handleSiteRequest(
            request,
            {
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
              SHARE_LINK_SECRET: shareLinkSecret,
            },
            fetchSummary
          );
          res.statusCode = response.status;
          response.headers.forEach((value, key) => {
            res.setHeader(key, value);
          });
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          next(error);
        }
      });
    },
    name: 'capy-workspace-summary',
  };
}
