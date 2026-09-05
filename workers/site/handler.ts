import {
  localeFor,
  renderFailure,
  renderSummary,
  summarySchema,
  workspaceID,
} from './summary';

const SUMMARY_PATH = /^\/(?:w|share\/workspaces)\/([^/]+)$/;

type SiteBindings = Pick<Cloudflare.Env, 'API_ORIGIN' | 'APP_ORIGIN'> & {
  ASSETS: Pick<Cloudflare.Env['ASSETS'], 'fetch'>;
};

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
  fetcher: typeof fetch = fetch
): Promise<Response> {
  const url = new URL(request.url);
  const locale = localeFor(request);
  const failure = (status: number) =>
    new Response(
      request.method === 'HEAD' ? null : renderFailure(status, locale),
      {
        headers: headers({
          'Content-Type': 'text/html; charset=utf-8',
          'X-Robots-Tag': 'noindex, nofollow',
        }),
        status,
      }
    );
  const isSummary =
    url.pathname.startsWith('/w/') ||
    url.pathname.startsWith('/share/workspaces/');
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
    if (!isSummary) {
      const response = await env.ASSETS.fetch(request);
      if (url.pathname !== '/llm-runtime.html') return response;
      const runtimeHeaders = new Headers(response.headers);
      runtimeHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
      runtimeHeaders.set('Cross-Origin-Embedder-Policy', 'credentialless');
      runtimeHeaders.set(
        'Document-Isolation-Policy',
        'isolate-and-credentialless'
      );
      runtimeHeaders.set(
        'Content-Security-Policy',
        `frame-ancestors 'self' ${trustedOrigin(env.APP_ORIGIN)}`
      );
      return new Response(response.body, {
        headers: runtimeHeaders,
        status: response.status,
      });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response(null, {
        headers: headers({ Allow: 'GET, HEAD' }),
        status: 405,
      });
    const match = url.pathname.match(SUMMARY_PATH);
    const id = match?.[1];
    if (!id || !workspaceID.test(id)) return failure(404);
    if (url.pathname.startsWith('/share/'))
      return new Response(null, {
        headers: headers({
          Location: `/w/${id}${url.searchParams.get('lang') === 'zh' ? '?lang=zh' : ''}`,
        }),
        status: 301,
      });
    const apiOrigin = trustedOrigin(env.API_ORIGIN);
    const appOrigin = trustedOrigin(env.APP_ORIGIN);
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
    if (summary.privacy === 'link')
      responseHeaders.set('X-Robots-Tag', 'noindex, nofollow');
    if (request.method === 'HEAD')
      return new Response(null, { headers: responseHeaders });
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
    return new Response(
      renderSummary(template, summary, id, appOrigin, locale),
      { headers: responseHeaders }
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.name : 'Error',
        event: 'site_request_failed',
        path: isSummary ? '/w/:id' : '/api/*',
      })
    );
    return failure(503);
  }
}
