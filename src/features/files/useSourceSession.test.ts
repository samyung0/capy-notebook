import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capy's vitest has no DOM, so the hook runs under a minimal hooks runtime:
// state and refs by call order, an effect when its deps change, enough to
// watch what one open does and read the state after it.
const hooks = vi.hoisted(() => {
  const slots: unknown[] = [];
  let next = 0;
  return {
    begin() {
      next = 0;
    },
    cleanups: [] as (() => void)[],
    get: (at: number) => slots[at],
    reset() {
      slots.length = 0;
      next = 0;
    },
    set(at: number, value: unknown) {
      slots[at] = value;
    },
    slot<T>(initial: () => T): [number, T] {
      const at = next++;
      if (!(at in slots)) slots[at] = initial();
      return [at, slots[at] as T];
    },
  };
});
vi.mock('react', async (load) => ({
  ...(await load<typeof import('react')>()),
  useCallback: <T>(callback: T) => hooks.slot(() => callback)[1],
  // No provider: the header's presence slot is absent.
  useContext: () => null,
  useEffect: (effect: () => undefined | (() => void), deps?: unknown[]) => {
    const [at, last] = hooks.slot<unknown[] | null>(() => null);
    if (last && deps?.every((dep, i) => Object.is(dep, last[i]))) return;
    hooks.set(at, deps ?? []);
    const cleanup = effect();
    if (cleanup) hooks.cleanups.push(cleanup);
  },
  useRef: <T>(current: T) => hooks.slot(() => ({ current }))[1],
  useState: <T>(initial: T) => {
    // React calls an initializer function once.
    const [at, value] = hooks.slot(() =>
      typeof initial === 'function' ? (initial as () => T)() : initial
    );
    const set = (update: T | ((previous: T) => T)) =>
      hooks.set(
        at,
        typeof update === 'function'
          ? (update as (previous: T) => T)(hooks.get(at) as T)
          : update
      );
    return [value, set];
  },
}));

const { createSourceProvider, recorder, sending, takeSourceOpen } = vi.hoisted(
  () => ({
    createSourceProvider: vi.fn(),
    recorder: {
      adopt: vi.fn(),
      connected: vi.fn(),
      covered: vi.fn(),
      discard: vi.fn(async () => {}),
      disconnected: vi.fn(),
      dispose: vi.fn(async () => {}),
      sequence: 0,
    },
    // The draft send of never-accepted stored steps: settled by `release`.
    sending: { done: false, release: () => {} },
    takeSourceOpen: vi.fn(),
  })
);
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@/api/hooks', () => ({ useMe: () => ({ data: { id: 'u_1' } }) }));
vi.mock('./sourceOpen', () => ({ takeSourceOpen }));
vi.mock('./sourceProvider', async (load) => ({
  ...(await load<typeof import('./sourceProvider')>()),
  createSourceProvider,
}));
vi.mock('@/lib/editDrafts', async (load) => ({
  ...(await load<typeof import('@/lib/editDrafts')>()),
  draftSender: vi.fn(() => {
    const settled = new Promise<void>((resolve) => {
      sending.release = () => {
        sending.done = true;
        resolve();
      };
    });
    return {
      get done() {
        return sending.done;
      },
      settled,
      stop() {},
    };
  }),
  readDrafts: vi.fn(async () => []),
  recordDrafts: vi.fn(() => recorder),
}));

import * as Y from 'yjs';
import type { SourceCollaborationToken, SourceSession } from '@/api/types';
import { COLLABORATION_OUTDATED_REASON } from '@/features/notes/collaborationEvents';
import { type EditDraft, readDrafts, recordDrafts } from '@/lib/editDrafts';
import type { SourceProviderConfig } from './sourceProvider';
import { useSourceSession } from './useSourceSession';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

const SESSION = {
  baseSourceSHA256: 'a'.repeat(64),
  epoch: 1,
  fileId: 'f_1',
  format: 'docx',
  room: 'source:f_1:epoch:1',
  sourceURL: 'https://bucket.test/base',
} as SourceSession;
const TOKEN = {
  epoch: 1,
  room: SESSION.room,
  token: 't',
  url: 'wss://collab.test',
} as SourceCollaborationToken;

/** The frame's readiness as an Office view passes it (none for text). */
let viewReady: boolean | undefined;

/** Renders the hook again and returns what it returns now. */
const render = () => {
  hooks.begin();
  return useSourceSession('f_1', true, undefined, viewReady);
};

/** Opens the file with its base still downloading; resolves to the room's
 * provider options once the provider exists. */
async function open() {
  const base = deferred<Uint8Array<ArrayBuffer>>();
  base.promise.catch(() => {});
  takeSourceOpen.mockResolvedValue({
    base: base.promise,
    credentials: TOKEN,
    session: SESSION,
  });
  render();
  await vi.waitFor(() => {
    if (!createSourceProvider.mock.calls.length) throw new Error('No room yet');
  });
  const [options] = createSourceProvider.mock.calls[0] as [
    SourceProviderConfig,
  ];
  return { base, options };
}

beforeEach(() => {
  hooks.reset();
  sending.done = false;
  viewReady = undefined;
  createSourceProvider.mockReset();
  createSourceProvider.mockReturnValue({
    connect: vi.fn(),
    destroy: vi.fn(),
    disconnect: vi.fn(),
    hasUnsyncedChanges: false,
    isAuthenticated: true,
    sendStateless: vi.fn(),
  });
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  // Paraglide keeps the locale there once it sees a window.
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
});
afterEach(() => {
  for (const cleanup of hooks.cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('an Office edit session opening while its base downloads', () => {
  it('creates the room before the base lands and shows the document once it does', async () => {
    const { base, options } = await open();
    options.onSynced?.({ state: true });
    expect(render()).toMatchObject({ synced: true });
    expect(render().bytes).toBeUndefined();
    base.resolve(new Uint8Array([7]));
    await vi.waitFor(() => expect(render().bytes).toEqual(new Uint8Array([7])));
  });

  it('shows the base that arrives after the room refused this build', async () => {
    const { base, options } = await open();
    options.onAuthenticationFailed?.({ reason: COLLABORATION_OUTDATED_REASON });
    expect(render()).toMatchObject({ banner: 'outdated', outdated: true });
    expect(render().bytes).toBeUndefined();
    base.resolve(new Uint8Array([8]));
    await vi.waitFor(() => expect(render().bytes).toEqual(new Uint8Array([8])));
  });

  it('ends the session with the file error when the base cannot be read', async () => {
    const { base } = await open();
    base.reject(new Error('HTTP 500'));
    await vi.waitFor(() => expect(render().status).toBe('error'));
    expect(render().bytes).toBeUndefined();
  });
});

// Epo 2026-10-23: an Office join ends when its frame reports ready; one past
// its 30 s errors, and gets its status back once the frame is ready with the
// room synced (review r3 M1).
describe("an Office view whose frame is ready after its join's 30 s", () => {
  it('errors at 30 s, then reads Saved once the frame is ready', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { onLine: true });
    viewReady = false;
    const { options } = await open();
    options.onSynced?.({ state: true });
    expect(render().status).toBe('saved');
    vi.advanceTimersByTime(30_000);
    expect(render().status).toBe('error');
    viewReady = true;
    render();
    expect(render().status).toBe('saved');
  });
});

// Q319, Q326, Q327: on open an accepted session's rows apply here, a
// never-accepted one's go through the draft send while the room joins
// (view-only, saving); not settled 30 s on, the synced session takes them
// itself, edits on, and every JOIN waits for the send until it settles.
describe('an edit session opening with stored drafts', () => {
  it('applies accepted rows, sends the others while joining, and past 30 s takes them with every JOIN waiting', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { onLine: true });
    const row = {
      base: SESSION.baseSourceSHA256,
      data: Y.encodeStateAsUpdate(new Y.Doc()),
      key: 'u_1:file:f_1',
      kind: 'update',
      lineage: `${SESSION.room}@${SESSION.baseSourceSHA256}`,
      savedAt: 0,
      seq: 1,
    } as const;
    const accepted: EditDraft = {
      ...row,
      accepted: true,
      id: 'a:1',
      session: 'a',
    };
    const pending: EditDraft = {
      ...row,
      grants: ['t'],
      id: 'b:1',
      session: 'b',
    };
    vi.mocked(readDrafts).mockResolvedValueOnce([accepted, pending]);
    const { options } = await open();
    expect(recordDrafts).toHaveBeenLastCalledWith(
      expect.objectContaining({ adopted: [accepted] })
    );
    expect(render().draftsSending).toBe(true);
    options.onSynced?.({ state: true });
    expect(render().status).toBe('saving');
    expect(options.beforeJoin?.()).toBeUndefined();
    vi.advanceTimersByTime(30_000);
    expect(recorder.adopt).toHaveBeenCalledWith([pending]);
    expect(render()).toMatchObject({ draftsSending: false, status: 'saving' });
    expect(options.beforeJoin?.()).toBeInstanceOf(Promise);
    sending.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(options.beforeJoin?.()).toBeUndefined();
  });
});
