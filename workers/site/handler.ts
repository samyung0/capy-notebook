import { verifiedShareID, verifiedShareToken } from '../../src/lib/shareLink';
import type { ShareKind } from '../../src/share/state';
import { handlePublicRequest, SHARED_CACHE } from './public';
import { pageClasses, usedCss } from './usedCss';

type SharePagePieces = ReturnType<
  typeof import('capy-share-render')['renderSharePagePieces']
>;

type SiteBindings = Pick<
  Cloudflare.Env,
  'API_ORIGIN' | 'APP_ORIGIN' | 'SHARE_LINK_SECRET'
> & {
  /** The deploy revision of the SPA this Worker serves (`--var` at deploy;
   * unset locally). */
  APP_RELEASE?: string;
  ASSETS: Pick<Cloudflare.Env['ASSETS'], 'fetch'>;
};
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

const STYLESHEET =
  /<link rel="stylesheet"([^>]*)href="(\/[^"]+\.css)"([^>]*)>/g;
// Hashed or deploy-scoped files, so an isolate keeps what it parsed.
const stylesheets = new Map<string, Promise<ReturnType<typeof usedCss>>>();

/** A page's stylesheets, each ready to cut to the rules a set of classes
 * uses (parsed once per isolate: the files are hashed or deploy-scoped). */
async function stylesheetCuts(
  html: string,
  assets: SiteBindings['ASSETS'],
  origin: string
) {
  const hrefs = [...new Set([...html.matchAll(STYLESHEET)].map((m) => m[2]))];
  const cuts = new Map(
    await Promise.all(
      hrefs.map(async (href) => {
        let cut = stylesheets.get(href);
        if (!cut) {
          cut = assets
            .fetch(new Request(new URL(href, origin)))
            .then(async (asset) => {
              if (!asset.ok) throw new Error(`Stylesheet ${href} unavailable`);
              return usedCss(await boundedText(asset, 1024 * 1024));
            });
          stylesheets.set(href, cut);
          cut.catch(() => stylesheets.delete(href));
        }
        return [href, await cut] as const;
      })
    )
  );
  return {
    /** `page` with each stylesheet link replaced by the rules `classes` use. */
    inline: (page: string, classes: Set<string>) =>
      page.replace(
        STYLESHEET,
        (_, before: string, href: string, after: string) =>
          `<style>${cuts.get(href)?.(classes)}</style><link rel="preload" as="style" fetchpriority="low"${before}href="${href}"${after} data-full-css>`
      ),
    /** Every stylesheet's rules for `classes`, in page order. */
    rules: (classes: Set<string>) =>
      hrefs.map((href) => cuts.get(href)?.(classes)).join(''),
  };
}

/** Puts the rules the page uses from its stylesheets in the HTML: the browser
 * paints from the document alone instead of waiting a round trip per
 * stylesheet, without the bytes of the whole Tailwind build. Each full
 * stylesheet is preloaded at low priority, so it never competes with the
 * document or fonts before first paint; the page script applies it before
 * anything renders in the browser (src/lib/fullStyles.ts). The edge caches
 * the result with the page. */
async function inlineStylesheets(
  html: string,
  assets: SiteBindings['ASSETS'],
  origin: string
): Promise<string> {
  const sheets = await stylesheetCuts(html, assets, origin);
  return sheets.inline(html, pageClasses(html));
}

/** A long note's page as it renders: the head and first blocks go out at
 * once, each later slice of blocks as soon as it is rendered. A slice that
 * uses classes not covered yet is preceded by every rule the page has used
 * so far, in stylesheet order, so later rules keep their place in the
 * cascade; the page script drops these once the full stylesheets apply. */
async function streamPage(
  { first, last, rest }: SharePagePieces,
  assets: SiteBindings['ASSETS'],
  origin: string,
  init: ResponseInit
): Promise<Response> {
  const sheets = await stylesheetCuts(first, assets, origin);
  const classes = pageClasses(first + last);
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const write = (text: string) => writer.write(encoder.encode(text));
  const send = async () => {
    await write(sheets.inline(first, classes));
    for (const render of rest) {
      // Let what is written so far leave before rendering more.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const html = render();
      const before = classes.size;
      for (const name of pageClasses(html)) classes.add(name);
      if (classes.size > before)
        await write(`<style data-css-subset>${sheets.rules(classes)}</style>`);
      await write(html);
    }
    await write(last);
    await writer.close();
  };
  send().catch((error) => {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.name : 'Error',
        event: 'share_stream_failed',
      })
    );
    return writer.abort(error);
  });
  return new Response(readable, init);
}

/** How long a render waited, as `Server-Timing`: `api` is the API read and
 * `total` the time from the request until the page was built. A Worker's
 * clock moves only on I/O, so CPU work (rendering, cutting the CSS) never
 * shows here; it is the rest of TTFB, and CPU time in Workers Logs. A cached
 * copy carries the timing of the render that filled it. */
const serverTiming = (start: number, api: number) =>
  `api;dur=${api}, total;dur=${Date.now() - start}`;

/** Every page this Worker renders carries the app's image-source policy,
 * report-only, and its script policy, enforced (vite-image-policy.ts);
 * Worker responses get no `_headers`. */
const IMAGE_POLICY_HEADER = 'Content-Security-Policy-Report-Only';
const PAGE_POLICY_HEADER = 'Content-Security-Policy';

/** An inline script. A build's templates have none (Vite bundles them); the
 * dev server's carry React's refresh preamble. */
const INLINE_SCRIPT = /<script\b(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;

/** The script policy for a page rendered into `template`: the template's own
 * inline scripts run by their hashes, so nothing the render writes into it
 * can run inline. */
async function allowTemplateScripts(
  policy: string,
  template = ''
): Promise<string> {
  const hashes = await Promise.all(
    [...template.matchAll(INLINE_SCRIPT)].map(async ([, code]) => {
      const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
      );
      return ` 'sha256-${btoa(String.fromCharCode(...digest))}'`;
    })
  );
  return policy.replace(
    "script-src 'self'",
    (directive) => directive + hashes.join('')
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
  const start = Date.now();
  const url = new URL(request.url);
  const failure = async (status: number) => {
    let template: string | undefined;
    if (request.method !== 'HEAD') {
      try {
        const asset = await env.ASSETS.fetch(
          new Request(new URL('/summary.html', url))
        );
        if (asset.ok)
          template = await inlineStylesheets(
            await boundedText(asset, 512 * 1024),
            env.ASSETS,
            url.origin
          );
        else await asset.body?.cancel();
      } catch {
        // Keep the existing self-contained error if the asset binding also fails.
      }
    }
    // A HEAD gets the page's headers, the policies included, and no body.
    const { IMAGE_POLICY, PAGE_POLICY, renderFailure } = await import(
      'capy-share-render'
    );
    const failureHeaders = headers({
      'Content-Type': 'text/html; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow',
    });
    failureHeaders.set(IMAGE_POLICY_HEADER, IMAGE_POLICY);
    failureHeaders.set(
      PAGE_POLICY_HEADER,
      await allowTemplateScripts(PAGE_POLICY, template)
    );
    return new Response(
      request.method === 'HEAD' ? null : renderFailure(status, template),
      { headers: failureHeaders, status }
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
      const apiHeaders = headers(upstream.headers);
      // The SPA a reload gets (the Worker and its assets deploy as one
      // version): an older open tab loads it at its next page change.
      if (env.APP_RELEASE)
        apiHeaders.set('X-Capy-App-Release', env.APP_RELEASE);
      return new Response(upstream.body, {
        headers: apiHeaders,
        status: upstream.status,
        statusText: upstream.statusText,
      });
    }
    if (url.pathname.startsWith('/p/'))
      return await handlePublicRequest(
        request,
        trustedOrigin(env.API_ORIGIN),
        env.SHARE_LINK_SECRET,
        fetcher
      );
    const isShare = url.pathname.startsWith('/share/');
    if (!(isSummary || isShare)) return await env.ASSETS.fetch(request);
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response(null, {
        headers: headers({ Allow: 'GET, HEAD' }),
        status: 405,
      });
    const apiOrigin = trustedOrigin(env.API_ORIGIN);
    const appOrigin = trustedOrigin(env.APP_ORIGIN);
    const head = (response: Response) =>
      request.method === 'HEAD' ? new Response(null, response) : response;
    // Shared quizzes, flashcard sets and notes render here like summaries:
    // an unknown kind or a forged link gets the 404 page before any API call.
    if (isShare) {
      const [, kind, token] = (url.pathname.match(SHARE_PAGE) ?? []) as [
        string,
        ShareKind | undefined,
        string,
      ];
      const id =
        kind && (await verifiedShareToken(env.SHARE_LINK_SECRET, token));
      if (!(kind && id)) return failure(404);
      const apiStart = Date.now();
      const upstream = await fetcher(
        new Request(`${apiOrigin}/api/public/${kind}/${token}`, {
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
      const data = JSON.parse(await boundedText(upstream, 4 * 1024 * 1024));
      const api = Date.now() - apiStart;
      const asset = await env.ASSETS.fetch(
        new Request(`${appOrigin}/share.html`)
      );
      if (!asset.ok) {
        await asset.body?.cancel();
        return failure(503);
      }
      const template = await boundedText(asset, 512 * 1024);
      const {
        IMAGE_POLICY,
        PAGE_POLICY,
        renderSharePagePieces,
        SHARE_TEMPLATE_MARKERS,
      } = await import('capy-share-render');
      if (!SHARE_TEMPLATE_MARKERS.every((marker) => template.includes(marker)))
        return failure(503);
      const page =
        kind === 'notes'
          ? { kind, note: data, token }
          : kind === 'quizzes'
            ? { kind, quiz: data, token }
            : { kind, set: data, token };
      const responseHeaders = headers({
        'Content-Type': 'text/html; charset=utf-8',
      });
      responseHeaders.set('Cache-Control', SHARED_CACHE);
      responseHeaders.set(IMAGE_POLICY_HEADER, IMAGE_POLICY);
      responseHeaders.set(
        PAGE_POLICY_HEADER,
        await allowTemplateScripts(PAGE_POLICY, template)
      );
      if (data.privacy === 'link')
        responseHeaders.set('X-Robots-Tag', 'noindex, nofollow');
      const pieces = renderSharePagePieces({
        canonical: `${appOrigin}${url.pathname}`,
        page,
        template,
      });
      // For a long note, the time until its first blocks were ready.
      responseHeaders.set('Server-Timing', serverTiming(start, api));
      if (pieces.rest.length)
        return request.method === 'HEAD'
          ? new Response(null, { headers: responseHeaders })
          : await streamPage(pieces, env.ASSETS, appOrigin, {
              headers: responseHeaders,
            });
      return head(
        new Response(
          await inlineStylesheets(pieces.first, env.ASSETS, appOrigin),
          { headers: responseHeaders }
        )
      );
    }
    // Unsigned or forged links stop here, before any API or database work.
    const id = await verifiedShareID(env.SHARE_LINK_SECRET, url.pathname);
    if (!id) return failure(404);
    const apiStart = Date.now();
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
    const { IMAGE_POLICY, PAGE_POLICY, renderSummary, summarySchema } =
      await import('capy-share-render');
    const summary = summarySchema.parse(
      JSON.parse(await boundedText(upstream, 512 * 1024))
    );
    const api = Date.now() - apiStart;
    const responseHeaders = headers({
      'Content-Type': 'text/html; charset=utf-8',
    });
    // Workers Cache holds the render for five minutes (SHARED_CACHE). Failure
    // pages stay no-store so publishing takes effect at once.
    responseHeaders.set('Cache-Control', SHARED_CACHE);
    responseHeaders.set(IMAGE_POLICY_HEADER, IMAGE_POLICY);
    if (summary.privacy === 'link')
      responseHeaders.set('X-Robots-Tag', 'noindex, nofollow');
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
    responseHeaders.set(
      PAGE_POLICY_HEADER,
      await allowTemplateScripts(PAGE_POLICY, template)
    );
    const rendered = new Response(
      await inlineStylesheets(
        renderSummary(template, summary, id, url.pathname, appOrigin),
        env.ASSETS,
        appOrigin
      ),
      { headers: responseHeaders }
    );
    rendered.headers.set('Server-Timing', serverTiming(start, api));
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
