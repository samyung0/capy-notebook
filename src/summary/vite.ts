import fs from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

const MSW_SHARE_LINK =
  /^(\/share\/[a-z]+\/)([a-z]+_[A-Za-z0-9_-]+)\.mswSignature0000$/;

/** Use the deployed renderer and routing (workers/site/handler.ts) for local
 * MSW, full-stack and tunnel sessions too. */
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
        // MSW's share links carry a placeholder signature; sign them so the
        // Worker's own check runs (src/mocks/db.ts mockSharePath).
        const placeholder = pathname.match(MSW_SHARE_LINK);
        if (placeholder && useMsw) {
          const { shareToken } = await server.ssrLoadModule(
            '/src/lib/shareLink.ts'
          );
          res.statusCode = 302;
          res.setHeader(
            'Location',
            `${placeholder[1]}${await shareToken(shareLinkSecret, placeholder[2])}${req.url?.slice(pathname.length) ?? ''}`
          );
          return res.end();
        }
        if (
          !['/w/', '/p/', '/share/'].some((prefix) =>
            pathname.startsWith(prefix)
          )
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
          // Browser MSW cannot intercept the Worker's server-side requests;
          // answer them from the same handlers here.
          const fetchMocked: typeof fetch = async (input) => {
            const upstream =
              input instanceof Request ? input : new Request(String(input));
            const url = new URL(upstream.url);
            if (url.pathname.startsWith('/api/public/workspaces/')) {
              const { mockWorkspaceSummary } = await server.ssrLoadModule(
                '/src/mocks/workspaceSummary.ts'
              );
              const summary = mockWorkspaceSummary(url.pathname.split('/')[4]);
              return summary
                ? Response.json(summary)
                : new Response(null, { status: 404 });
            }
            const [{ getResponse }, { handlers }] = await Promise.all([
              import('msw'),
              server.ssrLoadModule('/src/mocks/handlers.ts'),
            ]);
            return (
              (await getResponse(handlers, upstream, {
                baseUrl: url.origin,
              })) ?? new Response(null, { status: 404 })
            );
          };
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
            useMsw ? fetchMocked : fetch
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
