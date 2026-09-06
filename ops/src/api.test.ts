import { describe, expect, it, vi } from 'vitest';
import { createOpsApi, ingestHostMetricsSchema, OpsApiError } from './api';

describe('ops API errors', () => {
  it('accepts environment-separated ingest telemetry with no customer content', () => {
    expect(
      ingestHostMetricsSchema.parse({
        dataAsOf: '2026-08-31T12:00:00Z',
        environments: [
          {
            attempts: {
              abandonedProviderCalls: 1,
              attempts: 4,
              averageDurationMilliseconds: 1200,
              averageQueueMilliseconds: 200,
              capacityWaits: 1,
              chunksCreated: 20,
              failed: 1,
              figuresCached: 0,
              figuresCaptioned: 2,
              figuresFailed: 0,
              figuresSelected: 2,
              inputTokens: 100,
              leaseExpired: 0,
              ocrPages: 2,
              outputTokens: 40,
              p95DurationMilliseconds: 1800,
              p95QueueMilliseconds: 300,
              pages: 10,
              providerCalls: 3,
              retrying: 0,
              slices: 1,
              succeeded: 2,
            },
            dataAsOf: '2026-08-31T12:00:00Z',
            environment: 'uat',
            errors: [],
            lastJobActivityAt: '2026-08-31T11:59:00Z',
            queue: {
              expiredLeases: 0,
              importDelayed: 0,
              importReady: 0,
              importRunning: 0,
              ingestDelayed: 0,
              ingestReady: 0,
              ingestRunning: 1,
              oldestQueuedMilliseconds: 0,
              parseDelayed: 0,
              parseReady: 0,
              parseRunning: 0,
            },
            recentAttempts: [],
            samples: [],
            workerSamples: [],
            workers: [
              {
                cpuCores: 0.5,
                hostId: 'ingest-1',
                jobAttemptId: 42,
                memoryBytes: 1024,
                memoryLimitBytes: 2048,
                oomEvents: 0,
                oomKillEvents: 0,
                pidsCurrent: 4,
                pidsLimit: 64,
                releaseSha: 'a'.repeat(40),
                role: 'ingest',
                sampledAt: '2026-08-31T12:00:00Z',
                stage: 'indexing',
                stale: false,
                state: 'busy',
                workerInstanceId: 'ingest:worker-1',
              },
            ],
          },
        ],
        hours: 24,
      })
    ).toMatchObject({ environments: [{ environment: 'uat' }] });
  });

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
      new Response(
        JSON.stringify({
          attempts: [],
          bucket: 'month',
          contextSummary: {
            calls: 0,
            callsAtLeast80Percent: 0,
            callsAtLeast90Percent: 0,
            callsAtLeast95Percent: 0,
            conversationTokens: 0,
            maxWindowUtilization: 0,
            p50WindowUtilization: 0,
            p95WindowUtilization: 0,
            systemTokens: 0,
            toolTokens: 0,
            totalTokens: 0,
            windowTokens: 0,
          },
          dataAsOf: '2026-08-24T12:00:00Z',
          from: '2026-08-01',
          rows: [],
          to: '2026-08-24',
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }
      )
    );
    const api = createOpsApi({
      fetcher,
      getToken: async () => 'operator-token',
    });

    await api.costs('2026-08-01', '2026-08-24', 'kind', 'month');

    const requested = new URL(
      String(fetcher.mock.calls[0][0]),
      'https://ops.example.test'
    );
    expect(requested.pathname).toBe('/api/ops/costs');
    expect(Object.fromEntries(requested.searchParams)).toEqual({
      bucket: 'month',
      from: '2026-08-01',
      groupBy: 'kind',
      to: '2026-08-24',
    });
  });

  it('requests a manual reconciliation with operator auth', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          alreadyQueued: false,
          requestedAt: '2026-08-26T12:00:00Z',
          runId: 42,
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 202,
        }
      )
    );
    const api = createOpsApi({
      fetcher,
      getToken: async () => 'operator-token',
    });

    await expect(api.requestReconciliation('storage')).resolves.toMatchObject({
      alreadyQueued: false,
      runId: 42,
    });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('/api/ops/reconciliation/storage');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer operator-token'
    );
  });

  it('reads reconciliation history without starting a job', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          dataAsOf: '2026-08-26T12:00:00Z',
          reports: [],
          runs: [
            {
              error: '',
              errorCount: 0,
              finishedAt: null,
              id: 42,
              jobType: 'storage',
              repairedCount: 0,
              requestedAt: '2026-08-26T11:59:00Z',
              requestedById: '',
              requestedByName: 'scheduled',
              scannedCount: 0,
              startedAt: null,
              status: 'pending',
              trigger: 'scheduled',
            },
          ],
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }
      )
    );
    const api = createOpsApi({
      fetcher,
      getToken: async () => 'operator-token',
    });

    await expect(api.reconciliation()).resolves.toMatchObject({
      runs: [{ id: 42, status: 'pending' }],
    });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('/api/ops/reconciliation');
    expect(init?.method).toBeUndefined();
  });

  it('requests older operator audit events with a cursor', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          events: [
            {
              action: 'registry.saved',
              actorRole: 'admin',
              actorUserId: 'operator-1',
              id: 41,
              metadata: { new_revision: 9, previous_revision: 8 },
              occurredAt: '2026-08-28T12:00:00Z',
              outcome: 'committed',
              targetId: '9',
              targetType: 'model_registry',
              traceId: 'trace-1',
            },
          ],
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }
      )
    );
    const api = createOpsApi({
      fetcher,
      getToken: async () => 'operator-token',
    });

    await expect(api.audit(42)).resolves.toMatchObject({
      events: [{ action: 'registry.saved', id: 41 }],
    });
    const requested = new URL(
      String(fetcher.mock.calls[0][0]),
      'https://ops.example.test'
    );
    expect(requested.pathname).toBe('/api/ops/audit');
    expect(Object.fromEntries(requested.searchParams)).toEqual({
      beforeId: '42',
      limit: '100',
    });
  });
});
