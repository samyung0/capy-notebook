import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/api/client', () => ({ api: { get, post } }));

import {
  holdSource,
  prefetchSourceOpen,
  type SourceOpen,
  takeSourceOpen,
} from './sourceOpen';

/** A request the test answers when it chooses, recording its abort. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const SESSION = {
  baseSourceSHA256: 'a'.repeat(64),
  epoch: 1,
  room: 'source:f_1:epoch:1',
  sourceURL: 'https://bucket.test/base',
};
const TOKEN = { epoch: 1, room: SESSION.room, token: 't', url: 'wss://c' };

let order: string[];
let fetches: { signal?: AbortSignal | null; url: string }[];
beforeEach(() => {
  order = [];
  fetches = [];
  get.mockReset();
  post.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      order.push('base');
      fetches.push({ signal: init?.signal, url });
      return new Response(new Uint8Array([1, 2, 3]));
    })
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('opening a source from its route', () => {
  it('hands the view the session and bytes the route started, reading each once', async () => {
    get.mockResolvedValue(SESSION);
    prefetchSourceOpen('f_view', 'view');
    const open = await takeSourceOpen('f_view', 'view');
    expect(open.session).toBe(SESSION);
    expect(await open.base).toEqual(new Uint8Array([1, 2, 3]));
    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith(
      '/files/f_view/source-session?view=true',
      expect.anything()
    );
    // Taken once: a later open (Retry, another frame) reads again.
    await takeSourceOpen('f_view', 'view');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('starts the base download when the session arrives, not after the token', async () => {
    const token = deferred<typeof TOKEN>();
    get.mockImplementation(async () => {
      order.push('session');
      return SESSION;
    });
    post.mockImplementation(() => token.promise);
    const opening = takeSourceOpen('f_edit', 'edit');
    await vi.waitFor(() => expect(order).toEqual(['session', 'base']));
    order.push('token');
    token.resolve(TOKEN);
    const open: SourceOpen = await opening;
    expect(open.credentials).toBe(TOKEN);
    expect(order).toEqual(['session', 'base', 'token']);
  });

  it('keeps one started open: a quick switch aborts the earlier download', async () => {
    get.mockResolvedValue(SESSION);
    prefetchSourceOpen('f_first', 'view');
    await vi.waitFor(() => expect(fetches).toHaveLength(1));
    prefetchSourceOpen('f_second', 'view');
    expect(fetches[0]?.signal?.aborted).toBe(true);
    await takeSourceOpen('f_second', 'view');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('drops an open nobody takes within 30 s', async () => {
    vi.useFakeTimers();
    const session = deferred<typeof SESSION>();
    get.mockImplementation(
      (_path: string, init: RequestInit) =>
        new Promise((resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
          void session.promise.then(resolve);
        })
    );
    prefetchSourceOpen('f_idle', 'view');
    const [, init] = get.mock.calls[0] as [string, RequestInit];
    const signal = init.signal!;
    vi.advanceTimersByTime(30_000);
    expect(signal.aborted).toBe(true);
    // The view mounting later reads afresh.
    get.mockResolvedValue(SESSION);
    vi.useRealTimers();
    await takeSourceOpen('f_idle', 'view');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('starts nothing for a file a view already shows, nor for another mode it was not started in', async () => {
    get.mockResolvedValue(SESSION);
    const release = holdSource('f_shown');
    prefetchSourceOpen('f_shown', 'view');
    expect(get).not.toHaveBeenCalled();
    release();
    prefetchSourceOpen('f_shown', 'view');
    expect(get).toHaveBeenCalledOnce();
    // Edit does not take a view's open.
    post.mockResolvedValue(TOKEN);
    await takeSourceOpen('f_shown', 'edit');
    expect(get).toHaveBeenLastCalledWith(
      '/files/f_shown/source-session',
      expect.anything()
    );
  });

  it('stops the download when the session or token is refused', async () => {
    get.mockResolvedValue(SESSION);
    post.mockRejectedValue(new Error('403'));
    await expect(takeSourceOpen('f_refused', 'edit')).rejects.toThrow('403');
    await vi.waitFor(() => expect(fetches[0]?.signal?.aborted).toBe(true));
  });
});
