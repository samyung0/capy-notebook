import { describe, expect, it, vi } from 'vitest';
import { createOpsApi, OpsApiError } from './api';

describe('ops API errors', () => {
  it('requires a Clerk token before sending a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const api = createOpsApi({ fetcher, getToken: async () => null });

    await expect(api.session()).rejects.toMatchObject({
      name: 'OpsApiError',
      status: 401,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves the server status and message', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Version conflict' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 409,
      })
    );
    const api = createOpsApi({
      fetcher,
      getToken: async () => 'operator-token',
    });

    await expect(api.registry()).rejects.toEqual(
      new OpsApiError(409, 'Version conflict')
    );
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('/api/ops/registry');
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer operator-token'
    );
  });

  it('turns an invalid success payload into a gateway error', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ role: 'admin', userId: 42 }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      })
    );
    const api = createOpsApi({
      fetcher,
      getToken: async () => 'operator-token',
    });

    await expect(api.session()).rejects.toMatchObject({
      name: 'OpsApiError',
      status: 502,
    });
  });

  it('sends the selected cost grouping', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify([]), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      })
    );
    const api = createOpsApi({
      fetcher,
      getToken: async () => 'operator-token',
    });

    await api.costs('2026-08-01', '2026-08-24', 'kind');

    const requested = new URL(
      String(fetcher.mock.calls[0][0]),
      'https://ops.example.test'
    );
    expect(requested.pathname).toBe('/api/ops/costs');
    expect(Object.fromEntries(requested.searchParams)).toEqual({
      from: '2026-08-01',
      groupBy: 'kind',
      to: '2026-08-24',
    });
  });
});
