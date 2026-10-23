/**
 * The site Worker's proof on its reads of `/api/public/`, matching
 * `ratelimit.ShareReadHeader` in Go: `{unix}.{base64url HMAC-SHA256(
 * SHARE_LINK_SECRET, "share-read:v1:{unix}:{path}")}`. A Worker subrequest
 * carries no visitor address, so Go counts a signed read against its share
 * token's bucket instead; a header more than a minute from Go's clock is
 * refused.
 */
export const SHARE_READ_HEADER = 'X-Capy-Share-Read';

const encode = (text: string) => new TextEncoder().encode(text);

export async function shareReadHeader(
  secret: string,
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
      encode(`share-read:v1:${stamp}:${path}`)
    )
  );
  const signature = btoa(String.fromCharCode(...mac))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  return `${stamp}.${signature}`;
}
