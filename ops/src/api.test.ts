import { describe, expect, it, vi } from 'vitest';
import {
  createOpsApi,
  fileNameFrom,
  ingestHostMetricsSchema,
  libraryBooksSchema,
  libraryExcerptDetailSchema,
  libraryOverviewSchema,
  OpsApiError,
} from './api';

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

describe('knowledge library reads', () => {
  it('accepts the live library counts', () => {
    expect(
      libraryOverviewSchema.parse({
        books: 3,
        chunks: 3679,
        dataAsOf: '2026-09-17T12:00:00Z',
        excerpts: 1894,
        figures: 875,
        topics: 32,
      })
    ).toMatchObject({ books: 3, topics: 32 });
  });

  it('keeps every publish of a book with its receipts', () => {
    const books = libraryBooksSchema.parse([
      {
        attribution: 'OpenIntro',
        authors: ['Diez'],
        bytes: 1024,
        chunkCount: 412,
        contentId: 'ahss_v2',
        descriptor: 'stats',
        downloadUrl: 'https://openintro.org/ahss.pdf',
        edition: '4e',
        excerptCount: 96,
        figureCount: 30,
        figureExclusions: [],
        firstContentPage: 12,
        id: 'ahss',
        license: 'CC BY-SA 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
        pages: 500,
        rightsNotes: [],
        sha256: 'book-sha',
        sourceUrl: 'https://openintro.org',
        summary: 'summary',
        title: 'Advanced High School Statistics',
        version: 2,
        versions: [
          {
            chunkerVersion: 'v10',
            corpusIdentity: 'corpus-2',
            descriptor: 'stats',
            note: 'reparse',
            objectKey: 'books/book-sha.pdf',
            parserFingerprint: 'odl-fp',
            parserRelease: 'odl-2026-09-17',
            publishedAt: '2026-09-17T08:00:00Z',
            sourceRun: 'run-2',
            status: 'current',
            summary: 'summary',
            version: 2,
          },
          {
            chunkerVersion: 'v10',
            corpusIdentity: 'corpus-1',
            descriptor: 'older stats',
            note: 'pilot',
            objectKey: 'books/book-sha.pdf',
            parserFingerprint: 'odl-fp-1',
            parserRelease: 'odl-2026-09-16',
            publishedAt: '2026-09-16T08:00:00Z',
            sourceRun: 'run-1',
            status: 'retained',
            summary: 'older summary',
            version: 1,
          },
        ],
      },
    ]);
    expect(books[0].versions.map((item) => item.status)).toEqual([
      'current',
      'retained',
    ]);
  });

  it('keeps every locator a reviewer needs on an excerpt detail', () => {
    const detail = libraryExcerptDetailSchema.parse({
      book: {
        chunkerVersion: 'v10',
        downloadUrl: 'https://openintro.org/ahss.pdf',
        edition: '4e',
        firstContentPage: 12,
        id: 'ahss',
        license: 'CC BY-SA 4.0',
        parserFingerprint: 'odl-fp',
        sha256: 'book-sha',
        sourceUrl: 'https://openintro.org',
        title: 'Advanced High School Statistics',
        version: 2,
      },
      chunks: [
        {
          confidence: 0.88,
          confidenceReasons: ['ocr_page'],
          id: 'c_intro',
          index: 0,
          lang: 'en',
          pageEnd: 341,
          pageStart: 340,
          reference: false,
          regions: [{ bbox: [10, 20, 30, 40], page: 340 }],
          searchable: true,
          sectionPath: 'Ch 8 > Intro',
          text: 'Regression introduces a fitted line',
        },
      ],
      evidence: 'quoted evidence',
      excerpt: {
        bookId: 'ahss',
        bookTitle: 'Advanced High School Statistics',
        chunkIds: ['c_intro'],
        confidence: 0.95,
        evidenceVerified: true,
        figureIds: ['fig_1'],
        id: 'e_intro',
        pages: [340],
        proposedTopic: '',
        reviewReasons: [],
        roles: ['introduction'],
        sectionPath: 'Ch 8 > Intro',
        synopsis: 'synopsis',
        tagStatus: 'tagged',
        topicIds: ['linear-regression'],
      },
      figures: [
        {
          bbox: [10, 20, 300, 400],
          blockIndex: 3,
          captionBbox: [10, 410, 300, 430],
          capturePath: 'captures/fig_1.png',
          capturePixelSize: [800, 600],
          excluded: false,
          exclusionEvidence: {},
          geometryKind: 'native',
          id: 'fig_1',
          originalCaption: { text: 'Figure 8.1' },
          originalFootnote: {},
          page: 340,
          sectionPath: 'Ch 8 > Intro',
          space: 'page',
        },
      ],
      regions: [],
      text: 'Regression introduces a fitted line',
    });
    expect(detail.book.sha256).toBe('book-sha');
    expect(detail.chunks[0].confidenceReasons).toEqual(['ocr_page']);
    expect(detail.figures[0].bbox).toEqual([10, 20, 300, 400]);
  });

  it('sends the excerpt filters and omits the empty ones', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [],
          page: 2,
          pageSize: 50,
          total: 0,
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 }
      )
    );
    const api = createOpsApi({
      fetcher,
      getToken: async () => 'operator-token',
    });

    await api.libraryExcerpts({
      page: 2,
      review: true,
      role: 'exercise',
      topic: 'linear-regression',
    });

    const requested = new URL(
      String(fetcher.mock.calls[0][0]),
      'https://ops.example.test'
    );
    expect(requested.pathname).toBe('/api/ops/library/excerpts');
    expect(Object.fromEntries(requested.searchParams)).toEqual({
      page: '2',
      review: 'true',
      role: 'exercise',
      topic: 'linear-regression',
    });
  });

  it('returns the export bytes with the digest the server computed', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"book":{"id":"ahss"}}', {
        headers: {
          'Content-Disposition': 'attachment; filename="library-ahss-v1.json"',
          'Content-Type': 'application/json',
          'X-Capy-Export-Sha256': 'a'.repeat(64),
        },
        status: 200,
      })
    );
    const api = createOpsApi({
      fetcher,
      getToken: async () => 'operator-token',
    });

    const result = await api.libraryExport('ahss', 1);

    expect(result.digest).toBe('a'.repeat(64));
    expect(result.fileName).toBe('library-ahss-v1.json');
    expect(String(fetcher.mock.calls[0][0])).toBe(
      '/api/ops/library/export/ahss?version=1'
    );
  });

  it('falls back to a safe export file name', () => {
    expect(fileNameFrom(null)).toBe('library-export.json');
    expect(fileNameFrom('attachment')).toBe('library-export.json');
  });

  it('turns an unconfigured library into a 404 the page can recognize', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 'library_unconfigured',
          message: 'the knowledge library database is not configured',
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 404 }
      )
    );
    const api = createOpsApi({
      fetcher,
      getToken: async () => 'operator-token',
    });

    await expect(api.libraryOverview()).rejects.toMatchObject({
      name: 'OpsApiError',
      status: 404,
    });
  });
});
