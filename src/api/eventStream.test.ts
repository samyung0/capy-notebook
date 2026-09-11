import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { api, qk } from './client';
import { filesQuery, materialsQuery, useEventStream } from './hooks';
import type { SourceFile } from './types';

const state = vi.hoisted(() => ({
  client: undefined as QueryClient | undefined,
  effects: [] as Array<() => void | (() => void)>,
  tokens: 0,
}));

// Run the hook's effect against real Query observers and response streams.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: (effect: () => void | (() => void)) => state.effects.push(effect),
}));
vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => state.client,
}));
vi.mock('./auth', () => ({
  authHeaders: async () => ({
    Authorization: `Bearer token-${++state.tokens}`,
  }),
  USE_MSW: false,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  state.effects = [];
  state.tokens = 0;
});

const pending: SourceFile = {
  addedAt: '2026-09-10T00:00:00Z',
  chapterId: null,
  hasBytes: true,
  id: 'f_stream',
  indexed: false,
  kind: 'md',
  name: 'notes.md',
  position: 0,
  revision: 0,
  sizeBytes: 20,
  status: 'processing',
  workspaceId: 'ws_stream',
};

function fakeStreamFetch() {
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const requests: { init: RequestInit; url: string }[] = [];
  const fetchStream = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ init, url });
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push(controller);
          controller.enqueue(new TextEncoder().encode(': connected\n\n'));
          init.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('Aborted', 'AbortError'))
          );
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } }
    );
  });
  vi.stubGlobal('fetch', fetchStream);
  const send = (event: string, data: unknown) =>
    streams
      .at(-1)
      ?.enqueue(
        new TextEncoder().encode(
          `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
        )
      );
  return { fetchStream, requests, send, streams };
}

it('authenticates every connection, reconciles on connect, and applies stream events', async () => {
  vi.useFakeTimers();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  state.client = client;
  let serverFiles = [pending];
  const get = vi
    .spyOn(api, 'get')
    .mockImplementation(
      async <T>(path: string) =>
        (path.endsWith('/materials') ? [] : serverFiles) as T
    );
  const files = new QueryObserver(client, {
    ...filesQuery(pending.workspaceId),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const materials = new QueryObserver(client, {
    ...materialsQuery(pending.workspaceId),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const unsubscribe = [
    files.subscribe(() => {}),
    materials.subscribe(() => {}),
  ];
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  const { fetchStream, requests, send, streams } = fakeStreamFetch();
  useEventStream(pending.workspaceId);
  const cleanup = state.effects.at(-1)?.();
  try {
    // Connecting refetches both workspace lists.
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(4));
    expect(requests[0].url).toContain('/stream?workspace=ws_stream');
    expect(requests[0].init.headers).toMatchObject({
      Authorization: 'Bearer token-1',
    });
    expect(client.getQueryData(qk.eventStream)).toEqual({
      status: 'connected',
    });

    send('ingest', { fileId: pending.id, pct: 50, status: 'processing' });
    await vi.waitFor(() =>
      expect(
        client.getQueryData<SourceFile[]>(qk.files(pending.workspaceId))?.[0]
          ?.ingestPct
      ).toBe(50)
    );

    serverFiles = [{ ...pending, indexed: true, status: 'ready' }];
    send('tree', { kind: 'files' });
    await vi.waitFor(() =>
      expect(client.getQueryData(qk.files(pending.workspaceId))).toEqual(
        serverFiles
      )
    );

    // A clean end is the server's bounded lifetime: reconnect with a fresh
    // token, without raising the banner.
    streams[0].close();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(fetchStream).toHaveBeenCalledTimes(2));
    expect(requests[1].init.headers).toMatchObject({
      Authorization: 'Bearer token-2',
    });
    expect(client.getQueryData(qk.eventStream)).toEqual({
      status: 'connected',
    });

    // A failed connect marks the stream disconnected and backs off.
    fetchStream.mockRejectedValueOnce(new TypeError('network'));
    streams[1].close();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() =>
      expect(client.getQueryData(qk.eventStream)).toEqual({
        status: 'disconnected',
      })
    );
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(fetchStream).toHaveBeenCalledTimes(4));
    expect(client.getQueryData(qk.eventStream)).toEqual({
      status: 'connected',
    });
  } finally {
    cleanup?.();
    for (const stop of unsubscribe) stop();
    client.clear();
  }
  expect(requests.at(-1)?.init.signal?.aborted).toBe(true);
});
