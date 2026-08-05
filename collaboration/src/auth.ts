import { createHmac, timingSafeEqual } from 'node:crypto';

export type CollaborationAccess = 'comment' | 'write' | 'shrink';

export interface CollaborationClaims {
  access: CollaborationAccess;
  aud: 'evo-collaboration';
  avatarUrl?: string;
  exp: number;
  iat: number;
  iss: 'evo-api';
  jti: string;
  name?: string;
  room: string;
  schema: number;
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

export const MATERIAL_ROOM_PATTERN = /^material:([A-Za-z0-9_-]+):schema:(\d+)$/;
const MATERIAL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function decodeJsonPart<T>(part: string): T {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
}

export function encodeJsonPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function materialRoom(materialId: string, schema: number): string {
  if (!MATERIAL_ID_PATTERN.test(materialId)) {
    throw new Error('material id must be URL-safe');
  }
  if (!Number.isSafeInteger(schema) || schema < 1) {
    throw new Error('schema must be a positive integer');
  }
  return `material:${materialId}:schema:${schema}`;
}

export function signCollaborationToken(
  secret: string,
  claims: Omit<CollaborationClaims, 'aud' | 'iss'> &
    Partial<Pick<CollaborationClaims, 'aud' | 'iss'>>
): string {
  if (!secret) throw new Error('collaboration token signing requires a secret');
  const header = encodeJsonPart({ alg: 'HS256', typ: 'JWT' });
  const payload = encodeJsonPart({
    access: claims.access,
    aud: claims.aud ?? 'evo-collaboration',
    ...(claims.avatarUrl ? { avatarUrl: claims.avatarUrl } : {}),
    exp: claims.exp,
    iat: claims.iat,
    iss: claims.iss ?? 'evo-api',
    jti: claims.jti,
    ...(claims.name ? { name: claims.name } : {}),
    room: claims.room,
    schema: claims.schema,
    sub: claims.sub,
  } satisfies CollaborationClaims);
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function mintCollaborationToken(input: {
  access: CollaborationClaims['access'];
  avatarUrl?: string;
  expiresInSeconds?: number;
  name?: string;
  room: string;
  secret: string;
  userId: string;
}): string {
  const match = MATERIAL_ROOM_PATTERN.exec(input.room);
  if (!match) throw new Error(`invalid collaboration room: ${input.room}`);
  const schema = Number(match[2]);
  const now = Math.floor(Date.now() / 1000);
  return signCollaborationToken(input.secret, {
    access: input.access,
    avatarUrl: input.avatarUrl,
    exp: now + (input.expiresInSeconds ?? 300),
    iat: now,
    jti: `chaos_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    name: input.name,
    room: input.room,
    schema,
    sub: input.userId,
  });
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
  const roomMatch = MATERIAL_ROOM_PATTERN.exec(expectedRoom);
  const expectedSchema = roomMatch ? Number(roomMatch[2]) : 0;
  if (
    roomMatch &&
    (claims.room !== expectedRoom || claims.schema !== expectedSchema)
  ) {
    throw new Error('collaboration room mismatch');
  }
  if (
    !roomMatch ||
    !Number.isSafeInteger(expectedSchema) ||
    expectedSchema < 1 ||
    claims.aud !== 'evo-collaboration' ||
    claims.iss !== 'evo-api' ||
    (claims.access !== 'write' &&
      claims.access !== 'comment' &&
      claims.access !== 'shrink') ||
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
