import { describe, expect, it } from 'vitest';
import {
  assertAllowedOrigin,
  claimsContext,
  mintCollaborationToken,
  signCollaborationToken,
  verifyCollaborationToken,
} from './auth.js';

function token(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signCollaborationToken('secret', {
    access: 'write',
    exp: now + 300,
    iat: now,
    jti: 'token-1',
    room: 'material:note_1:schema:1',
    schema: 1,
    sub: 'user-1',
    ...overrides,
  } as never);
}

describe('collaboration tokens', () => {
  it('accepts exact signed room claims', () => {
    const claims = verifyCollaborationToken(
      token(),
      'secret',
      'material:note_1:schema:1'
    );
    expect(claims).toMatchObject({ access: 'write', sub: 'user-1' });
    expect(claimsContext(claims)).toMatchObject({
      expiresAt: claims.exp,
      userId: 'user-1',
    });
  });

  it('mints short-lived write tokens for a room', () => {
    const minted = mintCollaborationToken({
      access: 'write',
      name: 'Chaos',
      room: 'material:note_1:schema:1',
      secret: 'secret',
      userId: 'chaos_1',
    });
    expect(
      verifyCollaborationToken(minted, 'secret', 'material:note_1:schema:1')
    ).toMatchObject({ access: 'write', name: 'Chaos', sub: 'chaos_1' });
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
