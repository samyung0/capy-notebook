import { QueryCache, QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { m } from '@/i18n';
import { ApiError, api, qk } from './client';
import {
  filesQuery,
  materialsQuery,
  onAssignmentEvent,
  useEventStream,
  workspaceQuery,
  workspacesQuery,
} from './hooks';
import { isMissing, noteAnswer } from './queryClient';
import type { SourceFile } from './types';

const state = vi.hoisted(() => ({
  client: undefined as QueryClient | undefined,
  effects: [] as Array<() => void | (() => void)>,
  toast: vi.fn(),
  tokens: 0,
}));

vi.mock('@/components/ui/userToast', async (original) => ({
  ...(await original<typeof import('@/components/ui/userToast')>()),
  userToast: (options: unknown) => state.toast(options),
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
  state.toast.mockReset();
  state.tokens = 0;
});

const pending: SourceFile = {
  addedAt: '2026-09-10T00:00:00Z',
  hasBytes: true,
  id: 'f_stream',
  indexed: false,
  isPayer: true,
  kind: 'md',
  name: 'notes.md',
  position: 0,
  revision: 0,
  sizeBytes: 20,
  status: 'processing',
  topicId: null,
  workspaceId: 'ws_stream',
};

/** The events endpoint; `refuse` answers 404 to the URLs it names. */
function fakeStreamFetch(refuse: (url: string) => boolean = () => false) {
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const requests: { init: RequestInit; url: string }[] = [];
  const fetchStream = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ init, url });
    if (refuse(url))
      return new Response(null, { status: 404, statusText: 'Not Found' });
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
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(3));
  // Read a minute before the stream connects.
  await vi.advanceTimersByTimeAsync(60_000);
  const { fetchStream, requests, send, streams } = fakeStreamFetch();
  useEventStream(pending.workspaceId);
  const cleanup = state.effects.at(-1)?.();
  try {
    // Connecting refetches both workspace lists; a first connect is no
    // recovery, so the failed read stays failed.
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

    // An assignment event reaches whoever listens; a malformed one doesn't.
    const heard: unknown[] = [];
    const stop = onAssignmentEvent((event) => heard.push(event));
    send('notification', { assignmentId: 7, type: 'assignment_closed' });
    send('notification', {
      assignmentId: 'as1',
      type: 'assignment_republished',
    });
    await vi.waitFor(() =>
      expect(heard).toEqual([
        { assignmentId: 'as1', type: 'assignment_republished' },
      ])
    );
    stop();

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

// Q917: a workspace opens with its page's own reads, which answer after the
// stream starts connecting; what answered before is read once, the unread
// count included (it sits under the notifications' key too).
it('a connect reads again, once each, only the lists that answered before it started connecting', async () => {
  vi.useFakeTimers();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  state.client = client;
  let answerMaterials = (_: unknown[]) => {};
  const materialsAnswer = new Promise<unknown[]>((resolve) => {
    answerMaterials = resolve;
  });
  const get = vi
    .spyOn(api, 'get')
    .mockImplementation(
      async <T>(path: string) =>
        (path.endsWith('/materials')
          ? materialsAnswer
          : path.endsWith('unread-count')
            ? { count: 0 }
            : []) as T
    );
  const reads = (end: string) =>
    get.mock.calls.filter(([path]) => path.endsWith(end)).length;
  const fresh = { staleTime: Number.POSITIVE_INFINITY };
  const ws = pending.workspaceId;
  const unsubscribe = [
    new QueryObserver(client, { ...filesQuery(ws), ...fresh }),
    new QueryObserver(client, {
      ...fresh,
      queryFn: () => api.get('/notifications/unread-count'),
      queryKey: qk.notificationUnread,
    }),
  ].map((observer) => observer.subscribe(() => {}));
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  await vi.advanceTimersByTimeAsync(60_000);
  // The page being opened reads its materials as the stream connects.
  unsubscribe.push(
    new QueryObserver(client, { ...materialsQuery(ws), ...fresh }).subscribe(
      () => {}
    )
  );
  const { fetchStream, streams } = fakeStreamFetch();
  useEventStream(ws);
  const cleanup = state.effects.at(-1)?.();
  try {
    await vi.waitFor(() =>
      expect(client.getQueryData(qk.eventStream)).toEqual({
        status: 'connected',
      })
    );
    answerMaterials([]);
    await vi.waitFor(() => expect(reads('/files')).toBe(2));
    await vi.waitFor(() => expect(reads('unread-count')).toBe(2));
    expect(reads('/materials')).toBe(1);

    // The next connect starts after every one of them answered.
    streams[0].close();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(fetchStream).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(reads('/materials')).toBe(2));
    await vi.waitFor(() => expect(reads('/files')).toBe(3));
    expect(reads('unread-count')).toBe(3);
  } finally {
    cleanup?.();
    for (const stop of unsubscribe) stop();
    client.clear();
  }
});

const WS = 'ws_access';

/** The member's notification about their access to the open workspace. */
const accessNotice = (
  kind: 'workspace_member_removed' | 'workspace_role_changed'
) => ({
  notification: {
    at: '2026-11-20T00:00:00Z',
    data: { workspaceId: WS },
    id: `n_${kind}`,
    kind,
  },
  type: 'created',
});

/** A workspace page that has shown the workspace and its files; `server.gone`
 * makes every read of it refused (404), and `start` opens the stream. */
function openWorkspace(refuse?: (url: string) => boolean) {
  vi.useFakeTimers();
  // As the app's, which notes each fetch's answer (`freshAnswer`).
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    queryCache: new QueryCache({ onSuccess: noteAnswer }),
  });
  state.client = client;
  const server = { gone: false, reads: [] as string[] };
  vi.spyOn(api, 'get').mockImplementation(async <T>(path: string) => {
    server.reads.push(path);
    if (server.gone) throw new ApiError(404, 'Not Found');
    return (path === `/workspaces/${WS}` ? { id: WS } : []) as T;
  });
  client.setQueryData(qk.workspace(WS), { id: WS });
  client.setQueryData(qk.files(WS), []);
  const workspace = new QueryObserver(client, {
    ...workspaceQuery(WS),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const files = new QueryObserver(client, {
    ...filesQuery(WS),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const unsubscribe = [
    workspace.subscribe(() => {}),
    files.subscribe(() => {}),
  ];
  const stream = fakeStreamFetch(refuse);
  let cleanup: void | (() => void);
  return {
    client,
    close: () => {
      cleanup?.();
      for (const stop of unsubscribe) stop();
      client.clear();
    },
    filesReads: () =>
      server.reads.filter((path) => path === `/workspaces/${WS}/files`).length,
    server,
    start: () => {
      useEventStream(WS);
      cleanup = state.effects.at(-1)?.();
    },
    stream,
    workspace,
  };
}

const lostToast = {
  id: 'access-lost',
  title: m.editor_access_lost(),
  variant: 'error',
};

it('a removed member sees the workspace unavailable with one toast, and the stream carries on without it', async () => {
  const page = openWorkspace();
  const { fetchStream, requests, send, streams } = page.stream;
  try {
    page.start();
    await vi.waitFor(() => expect(fetchStream).toHaveBeenCalledTimes(1));
    page.server.gone = true;
    send('notification', accessNotice('workspace_member_removed'));
    // The page keeps the row it showed, under a refusal: WorkspaceOpen shows
    // the workspace unavailable.
    await vi.waitFor(() =>
      expect(isMissing(page.workspace.getCurrentResult().error)).toBe(true)
    );
    expect(state.toast).toHaveBeenCalledExactlyOnceWith(lostToast);

    // The server ends the stream at its next access check; the reconnect
    // leaves the workspace out, with no banner.
    streams[0].close();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(fetchStream).toHaveBeenCalledTimes(2));
    expect(requests[1].url).not.toContain('workspace=');
    expect(page.client.getQueryData(qk.eventStream)).toEqual({
      status: 'connected',
    });

    // The same notice again reads the workspace again, and toasts no more.
    const reads = page.server.reads.length;
    send('notification', accessNotice('workspace_member_removed'));
    await vi.waitFor(() =>
      expect(page.server.reads.length).toBeGreaterThan(reads)
    );
    expect(state.toast).toHaveBeenCalledOnce();
  } finally {
    page.close();
  }
});

// Review 2026-11-20 (4): its row cached from an earlier visit is no sign the
// workspace worked on this page, so one opened unavailable says only that.
it('a workspace stream refused at connect is no fault: the page shows it unavailable, with no toast, and notifications go on', async () => {
  const page = openWorkspace((url) => url.includes('workspace='));
  const { fetchStream, requests } = page.stream;
  try {
    page.server.gone = true;
    page.start();
    await vi.waitFor(() =>
      expect(isMissing(page.workspace.getCurrentResult().error)).toBe(true)
    );
    expect(state.toast).not.toHaveBeenCalled();
    // Never marked disconnected: no Reconnecting banner.
    expect(page.client.getQueryData(qk.eventStream)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(fetchStream).toHaveBeenCalledTimes(2));
    expect(requests[0].url).toContain(`workspace=${WS}`);
    expect(requests[1].url).not.toContain('workspace=');
    expect(page.client.getQueryData(qk.eventStream)).toEqual({
      status: 'connected',
    });
  } finally {
    page.close();
  }
});

// Review 2026-11-20 (4): a read of the workspace that answered while the page
// was open counts, the stream never having connected with it.
it('a workspace read that answered on this page makes its later refusal toast once', async () => {
  const page = openWorkspace((url) => url.includes('workspace='));
  const { fetchStream, send } = page.stream;
  try {
    page.start();
    // The refused stream reads the workspace, which still answers.
    await vi.waitFor(() =>
      expect(page.server.reads).toContain(`/workspaces/${WS}`)
    );
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(fetchStream).toHaveBeenCalledTimes(2));
    expect(state.toast).not.toHaveBeenCalled();
    page.server.gone = true;
    send('notification', accessNotice('workspace_member_removed'));
    await vi.waitFor(() =>
      expect(isMissing(page.workspace.getCurrentResult().error)).toBe(true)
    );
    expect(state.toast).toHaveBeenCalledExactlyOnceWith(lostToast);
  } finally {
    page.close();
  }
});

// Review 2026-11-20 (5): a hover's preload answered the workspace's read just
// before the page opened on it, fresh, so the page fetched nothing itself:
// refused at connect, the workspace worked here all the same.
it('a workspace read answered just before the page opened makes its refusal toast once', async () => {
  const page = openWorkspace((url) => url.includes('workspace='));
  try {
    // Its row cached from an earlier visit; the preload reads it afresh.
    await page.client.invalidateQueries({
      queryKey: qk.workspace(WS),
      refetchType: 'none',
    });
    await page.client.prefetchQuery({
      ...workspaceQuery(WS),
      staleTime: 60_000,
    });
    expect(page.server.reads).toEqual([`/workspaces/${WS}`]);
    page.server.gone = true;
    page.start();
    await vi.waitFor(() =>
      expect(isMissing(page.workspace.getCurrentResult().error)).toBe(true)
    );
    expect(state.toast).toHaveBeenCalledExactlyOnceWith(lostToast);
  } finally {
    page.close();
  }
});

// Review 2026-11-20, round 3 (1): a member viewed the workspace, went
// elsewhere and was removed from it, then opens it again within its row's
// 5 minutes: the row paints with no read, and refused at connect it says only
// that it is unavailable.
it('a workspace read from an earlier visit, still within its stale time, makes no refusal toast', async () => {
  const page = openWorkspace((url) => url.includes('workspace='));
  try {
    await page.client.invalidateQueries({
      queryKey: qk.workspace(WS),
      refetchType: 'none',
    });
    await page.client.prefetchQuery({
      ...workspaceQuery(WS),
      staleTime: 5 * 60_000,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    page.server.gone = true;
    page.start();
    await vi.waitFor(() =>
      expect(isMissing(page.workspace.getCurrentResult().error)).toBe(true)
    );
    expect(state.toast).not.toHaveBeenCalled();
  } finally {
    page.close();
  }
});

it('a role change, or a removal from a workspace still readable, reads the workspace, its lists and its items again', async () => {
  const page = openWorkspace();
  const { fetchStream, send } = page.stream;
  try {
    // The files list answered a minute before the stream connects.
    await vi.advanceTimersByTimeAsync(60_000);
    page.start();
    await vi.waitFor(() => expect(fetchStream).toHaveBeenCalledTimes(1));
    // The connect's own refetch of the lists.
    await vi.waitFor(() => expect(page.filesReads()).toBe(1));
    for (const [kind, reads] of [
      ['workspace_role_changed', 2],
      ['workspace_member_removed', 3],
    ] as const) {
      page.client.setQueryData([...qk.canvases, WS], {
        pageParams: [],
        pages: [],
      });
      // An item of it the page holds: its read follows the new role.
      page.client.setQueryData(qk.material('mt_1'), { workspaceId: WS });
      send('notification', accessNotice(kind));
      await vi.waitFor(() => expect(page.filesReads()).toBe(reads));
      expect(
        page.client.getQueryState([...qk.canvases, WS])?.isInvalidated
      ).toBe(true);
      expect(
        page.client.getQueryState(qk.material('mt_1'))?.isInvalidated
      ).toBe(true);
    }
    expect(page.workspace.getCurrentResult().error).toBeNull();
    expect(state.toast).not.toHaveBeenCalled();
  } finally {
    page.close();
  }
});

it('a materials tree event reads the workspace canvas list again', async () => {
  const page = openWorkspace();
  const { fetchStream, send } = page.stream;
  try {
    page.start();
    await vi.waitFor(() => expect(fetchStream).toHaveBeenCalledTimes(1));
    page.client.setQueryData([...qk.canvases, WS], {
      pageParams: [],
      pages: [],
    });
    send('tree', { kind: 'materials' });
    await vi.advanceTimersByTimeAsync(300);
    expect(page.client.getQueryState([...qk.canvases, WS])?.isInvalidated).toBe(
      true
    );
  } finally {
    page.close();
  }
});
