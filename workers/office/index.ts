interface OfficeEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  PARENT_ORIGINS: string;
}

const ASSET_PATH = /^\/assets\/[A-Za-z0-9_./-]+$/;

export default {
  async fetch(request: Request, env: OfficeEnv): Promise<Response> {
    const url = new URL(request.url);
    let parents: string[];
    try {
      parents = env.PARENT_ORIGINS.split(',').map((value) => {
        const origin = value.trim();
        const parent = new URL(origin);
        if (
          parent.protocol !== 'https:' ||
          parent.origin !== origin ||
          parent.hostname.includes('*') ||
          parent.origin === url.origin
        ) {
          throw new Error('Invalid parent origin');
        }
        return origin;
      });
      if (new Set(parents).size !== parents.length) {
        throw new Error('Duplicate parent origin');
      }
    } catch {
      return new Response('Office runtime is not configured', { status: 503 });
    }
    const headers = new Headers({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors ${parents.join(' ')}; base-uri 'none'; form-action 'none'`,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow',
    });
    if (url.protocol !== 'https:')
      return new Response('HTTPS required', { headers, status: 400 });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      headers.set('Allow', 'GET, HEAD');
      return new Response(null, { headers, status: 405 });
    }
    if (
      url.pathname !== '/office-runtime.html' &&
      !ASSET_PATH.test(url.pathname)
    ) {
      return new Response(null, { headers, status: 404 });
    }
    // Forward only cache/range negotiation, never app credentials or cookies.
    const assetHeaders = new Headers();
    for (const key of [
      'If-None-Match',
      'If-Modified-Since',
      'Range',
      'If-Range',
    ]) {
      const value = request.headers.get(key);
      if (value) assetHeaders.set(key, value);
    }
    url.search = '';
    const asset = await env.ASSETS.fetch(
      new Request(url, { headers: assetHeaders, method: request.method })
    );
    // Explicit allowlist prevents inherited _headers, cookies, CORS or redirects.
    for (const key of [
      'Content-Type',
      'Content-Length',
      'Content-Encoding',
      'ETag',
      'Last-Modified',
      'Content-Range',
      'Accept-Ranges',
    ]) {
      const value = asset.headers.get(key);
      if (value) headers.set(key, value);
    }
    if (![200, 206, 304].includes(asset.status)) {
      headers.delete('Content-Length');
      headers.delete('Content-Encoding');
      return new Response(null, { headers, status: 404 });
    }
    return new Response(request.method === 'HEAD' ? null : asset.body, {
      headers,
      status: asset.status,
    });
  },
};
