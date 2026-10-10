import { verifiedShareToken } from '../../src/lib/shareLink';

/**
 * Images of shared standalone quizzes, flashcard sets and notes for
 * signed-out visitors (the pages themselves render in handler.ts). Every route
 * verifies the share token first, so forged links never reach the API. Images
 * are cached by Workers Cache for five minutes, like the pages; Go verifies the
 * token again and reads privacy live. Grading posts go straight to
 * `/api/public/.../grade`: a Worker subrequest reaches the API without the
 * visitor's IP, which the per-IP grading caps and rate limits key on.
 *
 *   GET /p/{quizzes|flashcards|notes}/{token}/assets/{assetId} → image bytes
 */

const ROUTE =
  /^\/p\/(quizzes|flashcards|notes)\/([^/]+)\/assets\/(asset_[A-Za-z0-9_-]{1,64})$/;
/** Workers Cache (wrangler.jsonc) keeps a shared render for five minutes and
 * answers repeats without running the Worker; browsers revalidate every time,
 * so an unshared item disappears once the cached copy expires. */
export const SHARED_CACHE = 'public, s-maxage=300, max-age=0, must-revalidate';
const JSON_LIMIT = 64 * 1024;
const ASSET_LIMIT = 20 * 1024 * 1024;
// Editor asset images never include SVG, so nothing served here can script.
const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

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
  secret: string,
  fetcher: typeof fetch
): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(ROUTE);
  if (!match) return error(404);
  const [, kind, token, assetId] = match;
  if (!(await verifiedShareToken(secret, token))) return error(404);

  if (request.method !== 'GET' && request.method !== 'HEAD')
    return respond(null, 405, { Allow: 'GET, HEAD' });
  const head = (response: Response) =>
    request.method === 'HEAD' ? new Response(null, response) : response;
  const upstream = await fetcher(
    new Request(`${apiOrigin}/api/public/${kind}/${token}/assets/${assetId}`, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
  );
  if ([401, 403, 404].includes(upstream.status)) {
    await upstream.body?.cancel();
    return error(404);
  }
  if (!upstream.ok) {
    await upstream.body?.cancel();
    return error(503);
  }
  const asset = JSON.parse(
    new TextDecoder().decode(await bounded(upstream.body, JSON_LIMIT))
  ) as { contentType?: unknown; url?: unknown };
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
  const response = respond(await bounded(image.body, ASSET_LIMIT), 200, {
    'Cache-Control': SHARED_CACHE,
    'Content-Type': asset.contentType,
  });
  return head(response);
}
