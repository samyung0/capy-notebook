import { verifiedShareToken } from '../../src/lib/shareLink';

/**
 * Data routes for signed-out visitors of shared standalone quizzes and
 * flashcard sets. Every route verifies the share token first, so forged links
 * never reach the API. Reads are cached at the edge for five minutes, like
 * workspace summaries; Go verifies the token again and reads privacy live.
 *
 *   GET  /p/quizzes/{token}                    → /api/public/quizzes/{token}
 *   GET  /p/quizzes/{token}/assets/{assetId}   → the image bytes
 *   POST /p/quizzes/{token}/grade              → /api/public/quizzes/{token}/grade
 *   GET  /p/flashcards/{token}                 → /api/public/flashcards/{token}
 */

const ROUTE =
  /^\/p\/(quizzes|flashcards)\/([^/]+)(?:\/(grade)|\/assets\/(asset_[A-Za-z0-9_-]{1,64}))?$/;
const SHARED_CACHE = 'public, s-maxage=300, max-age=0, must-revalidate';
const JSON_LIMIT = 4 * 1024 * 1024;
// Twenty open answers of 5,000 characters each, as UTF-8, plus framing.
const GRADE_BODY_LIMIT = 512 * 1024;
const ASSET_LIMIT = 20 * 1024 * 1024;
// Editor asset images never include SVG, so nothing served here can script.
const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

type PublicCache = Pick<Cache, 'match' | 'put'>;

const respond = (
  body: BodyInit | null,
  status: number,
  extra: Record<string, string> = {}
) =>
  new Response(body, {
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow',
      ...extra,
    },
    status,
  });
const error = (status: number) =>
  respond(
    JSON.stringify({ message: status === 404 ? 'not found' : 'unavailable' }),
    status,
    {
      'Content-Type': 'application/json',
    }
  );

async function bounded(
  body: ReadableStream<Uint8Array> | null,
  limit: number
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new RangeError('Body too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function handlePublicRequest(
  request: Request,
  apiOrigin: string,
  appOrigin: string,
  secret: string,
  fetcher: typeof fetch,
  cache?: PublicCache
): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(ROUTE);
  if (!match) return error(404);
  const [, kind, token, grade, assetId] = match;
  const id = await verifiedShareToken(secret, token);
  if (!id || (kind === 'flashcards' && (grade || assetId))) return error(404);
  const upstreamPath = `/api/public/${kind}/${token}`;

  if (grade) {
    if (request.method !== 'POST') return respond(null, 405, { Allow: 'POST' });
    let body: Uint8Array;
    try {
      body = await bounded(request.body, GRADE_BODY_LIMIT);
    } catch {
      return respond(null, 413);
    }
    // Same-zone subrequests carry the visitor's IP in CF-Connecting-IP, which
    // the API's per-IP grading caps read.
    const upstream = await fetcher(
      new Request(`${apiOrigin}${upstreamPath}/grade`, {
        body,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
      })
    );
    return respond(upstream.body, upstream.status, {
      'Content-Type':
        upstream.headers.get('Content-Type') ?? 'application/json',
    });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD')
    return respond(null, 405, { Allow: 'GET, HEAD' });
  const head = (response: Response) =>
    request.method === 'HEAD' ? new Response(null, response) : response;
  const cacheKey = new Request(
    `${appOrigin}/p/${kind}/${id}${assetId ? `/assets/${assetId}` : ''}`
  );
  const cached = await cache?.match(cacheKey);
  if (cached) return head(cached);

  const upstream = await fetcher(
    new Request(
      `${apiOrigin}${upstreamPath}${assetId ? `/assets/${assetId}` : ''}`,
      {
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      }
    )
  );
  if ([401, 403, 404].includes(upstream.status)) {
    await upstream.body?.cancel();
    return error(404);
  }
  if (!upstream.ok) {
    await upstream.body?.cancel();
    return error(503);
  }
  const json = await bounded(upstream.body, JSON_LIMIT);

  let response: Response;
  if (assetId) {
    const asset = JSON.parse(new TextDecoder().decode(json)) as {
      contentType?: unknown;
      url?: unknown;
    };
    if (
      typeof asset.url !== 'string' ||
      typeof asset.contentType !== 'string' ||
      !IMAGE_TYPES.has(asset.contentType)
    )
      return error(503);
    const image = await fetcher(asset.url, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!image.ok) {
      await image.body?.cancel();
      return error(503);
    }
    response = respond(await bounded(image.body, ASSET_LIMIT), 200, {
      'Cache-Control': SHARED_CACHE,
      'Content-Type': asset.contentType,
    });
  } else {
    response = respond(json, 200, {
      'Cache-Control': SHARED_CACHE,
      'Content-Type': 'application/json',
    });
  }
  await cache?.put(cacheKey, response.clone());
  return head(response);
}
