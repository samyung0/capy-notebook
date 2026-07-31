import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertAllowedOrigin, verifyCollaborationToken } from './auth.js';

function token(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' })
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      access: 'write',
      aud: 'evo-collaboration',
      exp: now + 300,
      iat: now,
      iss: 'evo-api',
      jti: 'token-1',
      room: 'material:note_1:schema:1',
      schema: 1,
      sub: 'user-1',
      ...overrides,
    })
  ).toString('base64url');
  const signature = createHmac('sha256', 'secret')
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

describe('collaboration tokens', () => {
  it('accepts exact signed room claims', () => {
    expect(
      verifyCollaborationToken(token(), 'secret', 'material:note_1:schema:1')
    ).toMatchObject({ access: 'write', sub: 'user-1' });
  });

  it('rejects wrong rooms, expiry, access, and signatures', () => {
    expect(() =>
      verifyCollaborationToken(token(), 'secret', 'material:note_2:schema:1')
    ).toThrow();
    expect(() =>
      verifyCollaborationToken(
        token({ exp: 1 }),
        'secret',
        'material:note_1:schema:1'
      )
    ).toThrow();
    expect(() =>
      verifyCollaborationToken(
        token({ access: 'view' }),
        'secret',
        'material:note_1:schema:1'
      )
    ).toThrow();
    expect(() =>
      verifyCollaborationToken(token(), 'wrong', 'material:note_1:schema:1')
    ).toThrow();
  });

  it('requires an explicitly allowed browser origin', () => {
    expect(() =>
      assertAllowedOrigin(
        new Request('http://localhost', {
          headers: { origin: 'https://app.example.com' },
        }),
        new Set(['https://app.example.com'])
      )
    ).not.toThrow();
    expect(() =>
      assertAllowedOrigin(
        new Request('http://localhost'),
        new Set(['https://app.example.com'])
      )
    ).toThrow();
  });
});
