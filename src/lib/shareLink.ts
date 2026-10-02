/**
 * Signed share tokens `{id}.{signature}`, matching `store.ShareToken` in Go:
 * workspace summaries at `/w/{token}`, standalone quizzes and flashcard sets at
 * `/share/quizzes/{token}` and `/share/flashcards/{token}`. The site Worker
 * rejects a token whose signature does not verify before it ever calls the API;
 * privacy is still read live there. The SPA never signs, it uses `sharePath`
 * from API responses.
 */

/** Local stacks and MSW share this value with deploy/docker-compose.yml. */
export const DEV_SHARE_LINK_SECRET = 'dev-share-link-secret-0123456789abcdef';

const SIGNATURE_BYTES = 12;
const SHARE_TOKEN = /^([a-z]+_[A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{16})$/;

let cachedKey: { key: Promise<CryptoKey>; secret: string } | undefined;

async function signature(secret: string, id: string): Promise<Uint8Array> {
  if (secret.length < 32)
    throw new Error('SHARE_LINK_SECRET must be at least 32 characters');
  if (cachedKey?.secret !== secret)
    cachedKey = {
      key: crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { hash: 'SHA-256', name: 'HMAC' },
        false,
        ['sign']
      ),
      secret,
    };
  const mac = await crypto.subtle.sign(
    'HMAC',
    await cachedKey.key,
    new TextEncoder().encode(`share:v1:${id}`)
  );
  return new Uint8Array(mac, 0, SIGNATURE_BYTES);
}

// 12 bytes encode to 16 characters without padding.
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_');

export async function shareToken(secret: string, id: string): Promise<string> {
  return `${id}.${base64url(await signature(secret, id))}`;
}

export async function sharePath(secret: string, id: string): Promise<string> {
  return `/w/${await shareToken(secret, id)}`;
}

/** Returns the workspace id when a `/w/` summary path carries a valid signature. */
export async function verifiedShareID(
  secret: string,
  pathname: string
): Promise<string | undefined> {
  if (!pathname.startsWith('/w/ws_')) return;
  return verifiedShareToken(secret, pathname.slice(3));
}

/** Returns the signed workspace or material id, or undefined when forged. */
export async function verifiedShareToken(
  secret: string,
  token: string
): Promise<string | undefined> {
  const match = token.match(SHARE_TOKEN);
  if (!match) return;
  const [, id, given] = match;
  const expected = base64url(await signature(secret, id));
  // Fixed-length comparison without an early exit.
  let diff = 0;
  for (let i = 0; i < expected.length; i++)
    diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0 ? id : undefined;
}
