/**
 * The site Worker's proof on its reads of `/api/public/`, matching
 * `ratelimit.ShareReadHeader` in Go: `{unix}.{address}.{base64url
 * HMAC-SHA256(SHARE_LINK_SECRET, "share-read:v2:{unix}:{address}:{path}")}`.
 * A Worker subrequest carries no visitor address, so the Worker signs the
 * visitor's `CF-Connecting-IP` and Go counts the read per visitor and shared
 * page; a header more than a minute from Go's clock, or an address that is not
 * an IP, is not trusted.
 */
export const SHARE_READ_HEADER = 'X-Capy-Share-Read';

/** The visitor's address as Cloudflare gives it to the Worker. */
export const visitorAddress = (request: Request) =>
  request.headers.get('CF-Connecting-IP') ?? '';

const encode = (text: string) => new TextEncoder().encode(text);

export async function shareReadHeader(
  secret: string,
  address: string,
  path: string,
  now = Date.now()
): Promise<string> {
  const stamp = String(Math.floor(now / 1000));
  const key = await crypto.subtle.importKey(
    'raw',
    encode(secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign']
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      encode(`share-read:v2:${stamp}:${address}:${path}`)
    )
  );
  const signature = btoa(String.fromCharCode(...mac))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  return `${stamp}.${address}.${signature}`;
}
