interface OfficeEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  PARENT_ORIGINS: string;
}

const ASSET_PATH = /^\/assets\/[A-Za-z0-9_./-]+$/;
// Files stage.mjs stores only as `<name>.br` (brotli 11), by extension, with
// the type they are served as; run_worker_first sends them here.
const PRECOMPRESSED = new Map([
  ['otf', 'font/otf'],
  ['ttf', 'font/ttf'],
  ['wasm', 'application/wasm'],
]);

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
    const type = PRECOMPRESSED.get(
      url.pathname.slice(url.pathname.lastIndexOf('.') + 1)
    );
    // Forward only cache/range negotiation, never app credentials or cookies.
    // A brotli file is read whole by GET with no validators, whatever the
    // request, so its answer is a full 200 or a 404: Workers Cache never gets
    // a 304 or an empty body under the year-long header, and answers
    // conditional requests from what it stored.
    const assetHeaders = new Headers();
    if (!type)
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
    if (type) url.pathname += '.br';
    const asset = await env.ASSETS.fetch(
      new Request(url, {
        headers: assetHeaders,
        method: type ? 'GET' : request.method,
      })
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
    // `encodeBody` is Workers-only: send the stored brotli bytes as they are;
    // the edge decodes them for a client that does not accept br.
    const init: ResponseInit & { encodeBody?: 'manual' } = {
      headers,
      status: asset.status,
    };
    if (type) {
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      headers.set('Content-Type', type);
      headers.set('Content-Encoding', 'br');
      headers.delete('Accept-Ranges');
      init.encodeBody = 'manual';
    }
    // A HEAD for a brotli file keeps the body: the runtime sends only the
    // headers, and a cache filling from it stores the whole file.
    return new Response(
      request.method === 'HEAD' && !type ? null : asset.body,
      init
    );
  },
};
