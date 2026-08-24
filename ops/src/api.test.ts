import { describe, expect, it, vi } from 'vitest';
import { createOpsApi, OpsApiError, overviewSchema } from './api';

describe('ops API boundary', () => {
  it('sends the Clerk bearer token to the scoped ops endpoint', async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ role: 'admin', userId: 'user_1' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        })
    );
    const api = createOpsApi({
      fetcher,
      getToken: async () => 'clerk-token',
    });

    await expect(api.session()).resolves.toEqual({
      role: 'admin',
      userId: 'user_1',
    });

    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe('/api/session');
    const headers = new Headers(call?.[1]?.headers);
    expect(headers.get('Authorization')).toBe('Bearer clerk-token');
  });

  it('refuses a request when Clerk has no token', async () => {
    const fetcher = vi.fn();
    const api = createOpsApi({
      fetcher,
      getToken: async () => null,
    });

    await expect(api.health()).rejects.toMatchObject({
      status: 401,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects malformed external JSON instead of trusting it', async () => {
    const api = createOpsApi({
      fetcher: async () =>
        new Response(JSON.stringify({ todayCredits: 'not-a-number' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      getToken: async () => 'token',
    });

    await expect(api.overview(30)).rejects.toBeInstanceOf(OpsApiError);
  });

  it('parses the current registry from a stale-save conflict', async () => {
    const current = {
      aliasesAllowed: false,
      configs: [],
      embeddingWorkspaceCounts: [],
      surfaces: [],
      version: 9,
    };
    const api = createOpsApi({
      fetcher: async () =>
        new Response(
          JSON.stringify({
            code: 'registry_conflict',
            current,
            message: 'reload',
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 409,
          }
        ),
      getToken: async () => 'token',
    });

    await expect(
      api.saveRegistry({
        cells: [],
        deprecations: [],
        drafts: [],
        embeddingAcknowledged: false,
        embeddingUpdates: [],
        expectedVersion: 8,
      })
    ).rejects.toMatchObject({
      currentRegistry: current,
      status: 409,
    });
  });

  it('accepts empty real-data collections without fixtures', () => {
    const parsed = overviewSchema.safeParse({
      activeWorkspaces7d: 0,
      byKind: [],
      bySurface: [],
      jobs: { failed24h: 0, queued: 0, running: 0 },
      monthCredits: 0,
      signupsToday: 0,
      storageTotal: 0,
      todayCredits: 0,
      topStorage: [],
      topUsers: [],
    });

    expect(parsed.success).toBe(true);
  });
});
