import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  api,
  isCreditsExhaustedError,
  isProviderBusyError,
} from './client';

class FakeUploadXHR {
  static latest: FakeUploadXHR | undefined;
  static autoComplete = true;

  readonly upload = {
    onprogress: null as
      | ((event: {
          lengthComputable: boolean;
          loaded: number;
          total: number;
        }) => void)
      | null,
  };
  readonly open = vi.fn();
  readonly setRequestHeader = vi.fn();
  readonly send = vi.fn(() => {
    this.upload.onprogress?.({
      lengthComputable: true,
      loaded: 25,
      total: 100,
    });
    if (FakeUploadXHR.autoComplete) this.onload?.();
  });
  readonly abort = vi.fn(() => this.onabort?.());
  status = 201;
  statusText = 'Created';
  responseText = '{"ok":true}';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeUploadXHR.latest = this;
  }
}

afterEach(() => {
  FakeUploadXHR.autoComplete = true;
  vi.unstubAllGlobals();
});

describe('multipart upload client', () => {
  it('reports upload progress and completes with the JSON response', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeUploadXHR);
    const progress: number[] = [];

    await expect(
      api.upload<{ ok: boolean }>(
        '/workspaces/ws_1/sources',
        new FormData(),
        (pct) => progress.push(pct)
      )
    ).resolves.toEqual({ ok: true });

    expect(progress).toEqual([25, 100]);
    expect(FakeUploadXHR.latest?.open).toHaveBeenCalledWith(
      'POST',
      '/api/workspaces/ws_1/sources'
    );
  });

  it('aborts an in-flight multipart request through the signal', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeUploadXHR);
    FakeUploadXHR.autoComplete = false;
    const controller = new AbortController();
    const request = api.upload(
      '/workspaces/ws_1/sources',
      new FormData(),
      undefined,
      controller.signal
    );

    await Promise.resolve();
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('coded API errors', () => {
  it('surfaces llm_credits_exhausted from a Huma envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            detail: 'monthly AI credits exhausted',
            errors: [
              {
                message: 'llm_credits_exhausted',
                value: { creditsLimitMicros: 1 },
              },
            ],
            status: 403,
            title: 'Forbidden',
          },
          { status: 403, statusText: 'Forbidden' }
        )
      )
    );

    await expect(api.get('/chat')).rejects.toSatisfy((err: unknown) => {
      expect(isCreditsExhaustedError(err)).toBe(true);
      return true;
    });
  });

  it('surfaces provider_busy and its wait from a Huma envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            detail: 'the model is busy right now',
            errors: [
              {
                message: 'provider_busy',
                value: { retryAfterSeconds: 7 },
              },
            ],
            status: 503,
            title: 'Service Unavailable',
          },
          { status: 503, statusText: 'Service Unavailable' }
        )
      )
    );

    await expect(api.get('/generate')).rejects.toSatisfy((err: unknown) => {
      expect(isProviderBusyError(err)).toBe(true);
      const body = (err as { body?: { retryAfterSeconds?: number } }).body;
      expect(body?.retryAfterSeconds).toBe(7);
      return true;
    });
  });
});

const TRACE_ID = /^[0-9a-f]{32}$/;

/** The ApiError a request rejected with. */
const rejection = (request: Promise<unknown>) =>
  request.then(
    () => {
      throw new Error('the request succeeded');
    },
    (error: ApiError) => error
  );

describe('failed request trace ids', () => {
  const sentTraceId = (fetchMock: ReturnType<typeof vi.fn>) =>
    String(
      (
        fetchMock.mock.calls[0][1] as RequestInit & {
          headers: Record<string, string>;
        }
      ).headers.traceparent
    ).split('-')[1];

  it.each([
    [
      'the generic answer',
      () =>
        Response.json(
          {
            detail: 'Something went wrong',
            status: 500,
            traceId: 'a'.repeat(32),
          },
          { headers: { 'X-Request-Id': 'b'.repeat(32) }, status: 500 }
        ),
      'a'.repeat(32),
    ],
    [
      'the echoed request id',
      () =>
        new Response(null, {
          headers: { 'X-Request-Id': 'b'.repeat(32) },
          status: 500,
        }),
      'b'.repeat(32),
    ],
  ])('keeps the id from %s', async (_, reply, traceId) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply())
    );
    const error = await rejection(api.get('/files'));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.traceId).toBe(traceId);
  });

  it('keeps the id it sent when a proxy answered', async () => {
    const fetchMock = vi.fn(
      async () => new Response('Bad gateway', { status: 502 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const error = await rejection(api.get('/files'));
    expect(error.traceId).toMatch(TRACE_ID);
    expect(error.traceId).toBe(sentTraceId(fetchMock));
  });

  it('keeps the id of a failed upload', async () => {
    class FailedUploadXHR extends FakeUploadXHR {
      status = 500;
      responseText = JSON.stringify({ traceId: 'c'.repeat(32) });
      getResponseHeader = () => null;
    }
    vi.stubGlobal('XMLHttpRequest', FailedUploadXHR);
    const error = await rejection(
      api.upload('/workspaces/ws_1/sources', new FormData())
    );
    expect(error.traceId).toBe('c'.repeat(32));
  });
});
