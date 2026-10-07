import fs from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

/** Use the deployed renderer and routing for local full-stack and tunnel
 * sessions too. */
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
        // MSW signs share links with a placeholder the Worker would reject,
        // so there /share/* only swaps in the share entry.
        if (pathname.startsWith('/share/') && useMsw) {
          req.url = `/share.html${req.url?.slice(pathname.length) ?? ''}`;
          return next();
        }
        // Under MSW the browser worker answers /p/ routes itself.
        const isPublic =
          (pathname.startsWith('/p/') || pathname.startsWith('/share/')) &&
          !useMsw;
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
                // The Worker asks for summary.html or share.html.
                fetch: async (asset: Request) => {
                  const file =
                    new URL(asset.url).pathname === '/share.html'
                      ? 'share.html'
                      : 'summary.html';
                  return new Response(
                    await server.transformIndexHtml(
                      `/${file}`,
                      await fs.readFile(
                        path.resolve(server.config.root, file),
                        'utf8'
                      )
                    ),
                    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
                  );
                },
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
