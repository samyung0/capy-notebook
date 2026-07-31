import { createHmac, timingSafeEqual } from 'node:crypto';

export interface CollaborationClaims {
  access: 'comment' | 'write';
  aud: 'evo-collaboration';
  avatarUrl?: string;
  exp: number;
  iat: number;
  iss: 'evo-api';
  jti: string;
  name?: string;
  room: string;
  schema: 1;
  sub: string;
}

export interface CollaborationContext {
  access: CollaborationClaims['access'];
  avatarUrl?: string;
  name?: string;
  serviceCommand?: boolean;
  tokenId: string;
  userId: string;
}

function decodeJsonPart<T>(part: string): T {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
}

export function verifyCollaborationToken(
  token: string,
  secret: string,
  expectedRoom: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): CollaborationClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('invalid collaboration token');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJsonPart<{ alg?: string; typ?: string }>(encodedHeader);
  if (header.alg !== 'HS256' || header.typ !== 'JWT') {
    throw new Error('unsupported collaboration token');
  }
  const expected = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  const actual = Buffer.from(encodedSignature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('invalid collaboration token signature');
  }

  const claims = decodeJsonPart<CollaborationClaims>(encodedPayload);
  const validRoom = /^material:[A-Za-z0-9_-]+:schema:1$/.test(expectedRoom);
  if (
    !validRoom ||
    claims.aud !== 'evo-collaboration' ||
    claims.iss !== 'evo-api' ||
    claims.room !== expectedRoom ||
    claims.schema !== 1 ||
    (claims.access !== 'write' && claims.access !== 'comment') ||
    !claims.sub ||
    !claims.jti ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp) ||
    claims.iat > nowSeconds + 30 ||
    claims.exp <= nowSeconds
  ) {
    throw new Error('invalid collaboration token claims');
  }
  return claims;
}

export function claimsContext(
  claims: CollaborationClaims
): CollaborationContext {
  return {
    access: claims.access,
    avatarUrl: claims.avatarUrl,
    name: claims.name,
    tokenId: claims.jti,
    userId: claims.sub,
  };
}

export function assertAllowedOrigin(
  request: Request,
  allowedOrigins: ReadonlySet<string>
) {
  const origin = request.headers.get('origin');
  if (!origin || !allowedOrigins.has(origin)) {
    throw new Error('origin is not allowed');
  }
}
