import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { api, qk } from './client';
import { filesQuery, useIngestProgress } from './hooks';
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

it('authenticates and reconciles every connection, then aborts when the last file completes', async () => {
  vi.useFakeTimers();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  state.client = client;
  const pending: SourceFile = {
    addedAt: '2026-09-10T00:00:00Z',
    chapterId: null,
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
  let serverFiles = [pending];
  const get = vi
    .spyOn(api, 'get')
    .mockImplementation(async <T>() => serverFiles as T);
  client.setQueryData(qk.files(pending.workspaceId), serverFiles);
  const observer = new QueryObserver(client, {
    ...filesQuery(pending.workspaceId),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const unsubscribe = observer.subscribe(() => {});
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const requests: RequestInit[] = [];
  const fetchStream = vi.fn(async (_url: string, init: RequestInit) => {
    requests.push(init);
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
  useIngestProgress(pending.workspaceId, serverFiles);
  const cleanup = state.effects.at(-1)?.();
  try {
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect(requests[0].headers).toMatchObject({
      Authorization: 'Bearer token-1',
    });

    // Completion happens while disconnected, so there is no terminal event.
    serverFiles = [{ ...pending, indexed: true, status: 'ready' }];
    streams[0].close();
    await vi.waitFor(() =>
      expect(client.getQueryData(qk.ingestStream(pending.workspaceId))).toEqual(
        { status: 'disconnected' }
      )
    );
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(requests[1].headers).toMatchObject({
      Authorization: 'Bearer token-2',
    });
    expect(client.getQueryData(qk.files(pending.workspaceId))).toEqual(
      serverFiles
    );

    // React cleans up the active effect before running it with ready files.
    cleanup?.();
    useIngestProgress(pending.workspaceId, serverFiles);
    state.effects.at(-1)?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests[1].signal?.aborted).toBe(true);
    expect(fetchStream).toHaveBeenCalledTimes(2);
    expect(
      client.getQueryData(qk.ingestStream(pending.workspaceId))
    ).toBeUndefined();
  } finally {
    cleanup?.();
    unsubscribe();
    client.clear();
  }
});
