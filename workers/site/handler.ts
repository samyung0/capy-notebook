import { verifiedShareID, verifiedShareToken } from '../../src/lib/shareLink';
import { fromEdgeCache, handlePublicRequest, SHARED_CACHE } from './public';
import {
  localeFor,
  renderFailure,
  renderSummary,
  summarySchema,
} from './summary';

type SiteBindings = Pick<
  Cloudflare.Env,
  'API_ORIGIN' | 'APP_ORIGIN' | 'SHARE_LINK_SECRET'
> & {
  ASSETS: Pick<Cloudflare.Env['ASSETS'], 'fetch'>;
};
type SummaryCache = Pick<Cache, 'match' | 'put'>;
const SHARE_PAGE = /^\/share\/(quizzes|flashcards|notes)\/([^/]+)$/;

export function trustedOrigin(value: string): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid configured origin');
  return url.origin;
}

async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) throw new Error('Missing response body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new Error('Response too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
    bytes
  );
}

const headers = (extra: HeadersInit = {}) => {
  const result = new Headers(extra);
  result.set('Cache-Control', 'no-store');
  result.set('X-Content-Type-Options', 'nosniff');
  return result;
};

export async function handleSiteRequest(
  request: Request,
  env: SiteBindings,
  fetcher: typeof fetch = fetch,
  cache?: SummaryCache
): Promise<Response> {
  const url = new URL(request.url);
  const locale = localeFor(request);
  const failure = async (status: number) => {
    let template: string | undefined;
    if (request.method !== 'HEAD') {
      try {
        const asset = await env.ASSETS.fetch(
          new Request(new URL('/summary.html', url))
        );
        if (asset.ok) template = await boundedText(asset, 512 * 1024);
        else await asset.body?.cancel();
      } catch {
        // Keep the existing self-contained error if the asset binding also fails.
      }
    }
    return new Response(
      request.method === 'HEAD'
        ? null
        : renderFailure(status, locale, template),
      {
        headers: headers({
          'Content-Type': 'text/html; charset=utf-8',
          'X-Robots-Tag': 'noindex, nofollow',
        }),
        status,
      }
    );
  };
  const isSummary = url.pathname.startsWith('/w/');
  if (url.pathname === '/summary' || url.pathname === '/summary.html')
    return failure(404);
  try {
    if (url.pathname.startsWith('/api/')) {
      const apiOrigin = trustedOrigin(env.API_ORIGIN);
      const appOrigin = trustedOrigin(env.APP_ORIGIN);
      // The cookie-less Office host must never become another API entrance.
      if (url.origin !== appOrigin)
        return new Response(null, { headers: headers(), status: 403 });
      const upstreamHeaders = new Headers(request.headers);
      upstreamHeaders.delete('Host');
      const upstream = await fetcher(
        new Request(
          new Request(new URL(url.pathname + url.search, apiOrigin), request),
          { headers: upstreamHeaders, redirect: 'manual' }
        )
      );
      // Do not follow redirects with the incoming credentials. Go's signed-file
      // redirects remain browser redirects; request/response bodies stream.
      return new Response(upstream.body, {
        headers: headers(upstream.headers),
        status: upstream.status,
        statusText: upstream.statusText,
      });
    }
    if (url.pathname.startsWith('/p/'))
      return await handlePublicRequest(
        request,
        trustedOrigin(env.API_ORIGIN),
        trustedOrigin(env.APP_ORIGIN),
        env.SHARE_LINK_SECRET,
        fetcher,
        cache
      );
    // Public share pages have their own entry. Like /w/, an unknown kind or
    // a forged link gets the 404 page before any script or API call.
    if (url.pathname.startsWith('/share/')) {
      const [, kind, token] = url.pathname.match(SHARE_PAGE) ?? [];
      if (!(kind && (await verifiedShareToken(env.SHARE_LINK_SECRET, token))))
        return failure(404);
      return await env.ASSETS.fetch(
        new Request(new URL('/share.html', url), request)
      );
    }
    if (!isSummary) return await env.ASSETS.fetch(request);
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response(null, {
        headers: headers({ Allow: 'GET, HEAD' }),
        status: 405,
      });
    // Unsigned or forged links stop here, before any API or database work.
    const id = await verifiedShareID(env.SHARE_LINK_SECRET, url.pathname);
    if (!id) return failure(404);
    const apiOrigin = trustedOrigin(env.API_ORIGIN);
    const appOrigin = trustedOrigin(env.APP_ORIGIN);
    const head = (response: Response) =>
      request.method === 'HEAD' ? new Response(null, response) : response;
    // Cloudflare's cache ignores Vary: Accept-Language, so the resolved locale
    // belongs in the key rather than in a header the edge will not read.
    const cacheKey = new Request(`${appOrigin}/w/${id}?lang=${locale}`);
    const cached = await cache?.match(cacheKey);
    if (cached) return head(fromEdgeCache(cached));
    const upstream = await fetcher(
      new Request(`${apiOrigin}/api/public/workspaces/${id}/summary`, {
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
    );
    if ([401, 403, 404].includes(upstream.status)) {
      await upstream.body?.cancel();
      return failure(404);
    }
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return failure(503);
    }
    const summary = summarySchema.parse(
      JSON.parse(await boundedText(upstream, 512 * 1024))
    );
    const responseHeaders = headers({
      'Content-Type': 'text/html; charset=utf-8',
      Vary: 'Accept-Language',
    });
    // Shared caches hold the render for five minutes; browsers revalidate every
    // time, so a privacy change reaches a reloading reader once the edge entry
    // expires. Failure pages stay no-store so publishing takes effect at once.
    responseHeaders.set('Cache-Control', SHARED_CACHE);
    if (summary.privacy === 'link')
      responseHeaders.set('X-Robots-Tag', 'noindex, nofollow');
    // HEAD renders and caches like GET so it cannot bypass the edge cache.
    const asset = await env.ASSETS.fetch(
      new Request(`${appOrigin}/summary.html`)
    );
    if (!asset.ok) {
      await asset.body?.cancel();
      return failure(503);
    }
    const template = await boundedText(asset, 512 * 1024);
    if (
      !template.includes('<!--capy-summary-head-->') ||
      !template.includes('<!--capy-summary-body-->')
    )
      return failure(503);
    const rendered = new Response(
      renderSummary(template, summary, id, url.pathname, appOrigin, locale),
      { headers: responseHeaders }
    );
    await cache?.put(cacheKey, rendered.clone());
    return head(rendered);
  } catch (error) {
    const isPublic = url.pathname.startsWith('/p/');
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.name : 'Error',
        event: 'site_request_failed',
        path: isSummary
          ? '/w/:id'
          : isPublic
            ? '/p/*'
            : url.pathname.startsWith('/share/')
              ? '/share/*'
              : '/api/*',
      })
    );
    if (isPublic)
      return new Response(JSON.stringify({ message: 'unavailable' }), {
        headers: headers({ 'Content-Type': 'application/json' }),
        status: 503,
      });
    return failure(503);
  }
}
