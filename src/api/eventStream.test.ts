import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { api, qk } from './client';
import {
  filesQuery,
  materialsQuery,
  useEventStream,
  workspacesQuery,
} from './hooks';
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

it('authenticates every connection, reconciles on connect, applies stream events, and retries failed reads after a fault', async () => {
  vi.useFakeTimers();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  state.client = client;
  let serverFiles = [pending];
  // The dashboard's list failed while the server was down.
  let workspacesDown = true;
  const get = vi
    .spyOn(api, 'get')
    .mockImplementation(async <T>(path: string) => {
      if (path.startsWith('/workspaces?')) {
        if (workspacesDown) throw new Error('server down');
        return [] as T;
      }
      return (path.endsWith('/materials') ? [] : serverFiles) as T;
    });
  const workspaceListReads = () =>
    get.mock.calls.filter(([path]) => path.startsWith('/workspaces?')).length;
  const workspaces = new QueryObserver(client, {
    ...workspacesQuery({ sort: 'accessed' }),
    staleTime: Number.POSITIVE_INFINITY,
  });
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
    workspaces.subscribe(() => {}),
  ];
  // Loaded before the stream connects (the page was open without it).
  await vi.waitFor(() => {
    expect(files.getCurrentResult().status).toBe('success');
    expect(materials.getCurrentResult().status).toBe('success');
    expect(workspaces.getCurrentResult().status).toBe('error');
  });
  await vi.advanceTimersByTimeAsync(1);
  const { fetchStream, requests, send, streams } = fakeStreamFetch();
  useEventStream(pending.workspaceId);
  const cleanup = state.effects.at(-1)?.();
  try {
    // Connecting refetches both workspace lists, read before it; a first
    // connect is no recovery, so the failed read stays failed.
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(5));
    expect(workspaceListReads()).toBe(1);
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
    expect(workspaceListReads()).toBe(1);

    // A failed connect marks the stream disconnected and backs off.
    fetchStream.mockRejectedValueOnce(new TypeError('network'));
    streams[1].close();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() =>
      expect(client.getQueryData(qk.eventStream)).toEqual({
        status: 'disconnected',
      })
    );
    workspacesDown = false;
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(fetchStream).toHaveBeenCalledTimes(4));
    expect(client.getQueryData(qk.eventStream)).toEqual({
      status: 'connected',
    });
    // Back from the fault: the failed read is retried and recovers.
    await vi.waitFor(() =>
      expect(workspaces.getCurrentResult().status).toBe('success')
    );
    expect(workspaceListReads()).toBe(2);
  } finally {
    cleanup?.();
    for (const stop of unsubscribe) stop();
    client.clear();
  }
  expect(requests.at(-1)?.init.signal?.aborted).toBe(true);
});

it("leaves the page's own reads to it on the first connect and reads the unread count once", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  state.client = client;
  let releaseFiles: (() => void) | undefined;
  const get = vi
    .spyOn(api, 'get')
    .mockImplementation(async <T>(path: string) => {
      if (path.endsWith('/files'))
        await new Promise<void>((resolve) => {
          releaseFiles = resolve;
        });
      return (path.endsWith('/unread-count') ? { count: 0 } : []) as T;
    });
  const reads = (suffix: string) =>
    get.mock.calls.filter(([path]) => path.endsWith(suffix)).length;
  const observers = [
    new QueryObserver(client, {
      queryFn: () => api.get('/notifications'),
      queryKey: qk.notifications,
      staleTime: Number.POSITIVE_INFINITY,
    }),
    new QueryObserver(client, {
      queryFn: () => api.get('/notifications/unread-count'),
      queryKey: qk.notificationUnread,
      staleTime: Number.POSITIVE_INFINITY,
    }),
  ];
  const unsubscribe = observers.map((observer) => observer.subscribe(() => {}));
  await vi.waitFor(() => expect(reads('/unread-count')).toBe(1));
  // The page refetches its file list, painted from the stored cache, when
  // the stream connects.
  client.setQueryData(qk.files(pending.workspaceId), [pending], {
    updatedAt: 1,
  });
  const files = new QueryObserver(client, filesQuery(pending.workspaceId));
  unsubscribe.push(files.subscribe(() => {}));
  await vi.waitFor(() => expect(releaseFiles).toBeDefined());
  const { fetchStream, streams } = fakeStreamFetch();
  useEventStream(pending.workspaceId);
  const cleanup = state.effects.at(-1)?.();
  try {
    await vi.waitFor(() =>
      expect(client.getQueryData(qk.eventStream)).toEqual({
        status: 'connected',
      })
    );
    releaseFiles?.();
    await vi.waitFor(() =>
      expect(files.getCurrentResult().status).toBe('success')
    );
    // Read before the connect: once more each.
    await vi.waitFor(() => expect(reads('/notifications')).toBe(2));
    expect(reads('/unread-count')).toBe(2);
    expect(reads('/files')).toBe(1);

    // A reconnect reads every list again, the count once.
    streams[0].close();
    await vi.waitFor(() => expect(fetchStream).toHaveBeenCalledTimes(2), {
      timeout: 3000,
    });
    await vi.waitFor(() => expect(reads('/files')).toBe(2));
    expect(reads('/notifications')).toBe(3);
    expect(reads('/unread-count')).toBe(3);
  } finally {
    cleanup?.();
    for (const stop of unsubscribe) stop();
    client.clear();
  }
});
