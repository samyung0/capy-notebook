import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ApiError } from '@/api/client';
import type { RoomProviderConfig } from './roomProvider';

// The room's provider, token and draft storage, recorded instead of real.
const providers: { config: RoomProviderConfig; connects: number }[] = [];
vi.mock('./roomProvider', () => ({
  RoomProvider: class {
    record: { config: RoomProviderConfig; connects: number };
    constructor(config: RoomProviderConfig) {
      this.record = { config, connects: 0 };
      providers.push(this.record);
    }
    connect() {
      this.record.connects += 1;
    }
    disconnect() {}
    destroy() {}
    sendStateless() {}
  },
}));
// The next token requests' answers: a token, or an error thrown.
const tokens: ({ access: string; room: string } | Error)[] = [];
vi.mock('@/api/hooks', () => ({
  getMaterialCollaborationToken: vi.fn(async () => {
    const next = tokens.shift() ?? {
      access: 'write',
      room: 'material:q:schema:1',
    };
    if (next instanceof Error) throw next;
    return { ...next, token: 't', url: 'ws://x' };
  }),
}));
const drafts = vi.hoisted(() => ({
  discarded: 0,
  disposed: 0,
  refused: 0,
  rows: [] as unknown[],
}));
vi.mock('@/lib/editDrafts', () => ({
  applyDrafts: vi.fn(),
  deleteDrafts: vi.fn(async () => {
    drafts.rows = [];
  }),
  draftGroups: (
    rows: { lineage: string; refused?: boolean }[],
    room: string
  ) => ({
    current: rows.filter((row) => !row.refused && row.lineage === room),
    recovery: rows.filter((row) => row.refused || row.lineage !== room),
  }),
  draftKey: (actor: string, kind: string, id: string) =>
    `${actor}:${kind}:${id}`,
  readDrafts: vi.fn(async () => drafts.rows),
  recordDrafts: () => ({
    connected() {},
    covered: async () => undefined,
    discard: async () => {
      drafts.discarded += 1;
    },
    disconnected() {},
    dispose: async () => {
      drafts.disposed += 1;
    },
    refuse() {
      drafts.refused += 1;
    },
    sequence: 1,
    unsaved: true,
  }),
  recoveryDocument: () => new Y.Doc(),
}));
vi.mock('@/components/ui/userToast', () => ({ userToast: vi.fn() }));

const { ItemRoom } = await import('./itemRoom');
const { applyDrafts } = await import('@/lib/editDrafts');

beforeEach(() => {
  vi.useFakeTimers();
  providers.length = 0;
  tokens.length = 0;
  drafts.rows = [];
  drafts.refused = 0;
  drafts.discarded = 0;
  drafts.disposed = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function started(onReplace = vi.fn()) {
  const room = new ItemRoom('q', { drafts: { actorId: 'u' }, onReplace });
  await room.start();
  return { onReplace, room };
}

// REVIEW1 M1: a refused update never rejoins with what was refused: the
// edits are kept as a refused draft and a fresh room replaces this one.
it('ends once on a refused update and never rejoins', async () => {
  const { onReplace, room } = await started();
  const [provider] = providers;
  provider.config.onSynced?.({ state: true });
  provider.config.onClose?.({
    code: 0,
    reason: 'a quiz cannot hold a struct outside its shape',
  });
  provider.config.onClose?.({ code: 0, reason: 'again' });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(drafts.refused).toBe(1);
  expect(onReplace).toHaveBeenCalledTimes(1);
  expect(provider.connects).toBe(1);
  room.destroy();
});

it('rejoins after a close the server gives everyone', async () => {
  const { onReplace, room } = await started();
  const [provider] = providers;
  provider.config.onClose?.({
    code: 4401,
    reason: 'collaboration token expired',
  });
  await vi.advanceTimersByTimeAsync(2000);
  expect(provider.connects).toBe(2);
  expect(onReplace).not.toHaveBeenCalled();
  room.destroy();
});

// REVIEW1 M5: a fresh token naming another room (compacted, discarded) ends
// this room; a fresh one joins the new lineage.
it('follows a room that moved to a new lineage', async () => {
  const { onReplace, room } = await started();
  const [provider] = providers;
  await provider.config.token();
  tokens.push({ access: 'write', room: 'material:q:schema:2' });
  await expect(provider.config.token()).rejects.toThrow('room moved');
  await vi.advanceTimersByTimeAsync(0);
  expect(onReplace).toHaveBeenCalledTimes(1);
  room.destroy();
});

// Epo 2026-10-04: refused (or other-lineage) stored edits open read-only for
// copying instead of the room; Reload drops them and opens a fresh room.
it('opens stored refused edits in recovery until Reload', async () => {
  drafts.rows = [{ lineage: 'material:q:schema:1', refused: true }];
  const { onReplace, room } = await started();
  expect(providers).toHaveLength(0);
  expect(room.getSnapshot().recovery?.refused).toBe(true);
  await room.reload();
  await vi.advanceTimersByTimeAsync(0);
  expect(drafts.rows).toEqual([]);
  expect(onReplace).toHaveBeenCalledTimes(1);
  room.destroy();
});

it('takes the readers lists from quiz-items messages', async () => {
  const room = new ItemRoom('q');
  await room.start();
  const [provider] = providers;
  provider.config.onStateless?.({
    payload: JSON.stringify({
      full: true,
      parts: { p: { items: ['b', 'a'], kind: 'ordering' } },
      type: 'quiz-items',
    }),
  });
  expect(room.lists.get('p')).toEqual({ items: ['b', 'a'], kind: 'ordering' });
  expect(room.getSnapshot().listsVersion).toBe(1);
  room.destroy();
});

it('discards unsaved edits when the room turns read-only', async () => {
  const { room } = await started();
  providers[0].config.onStateless?.({
    payload: JSON.stringify({
      room: 'material:q:schema:1',
      type: 'room-read-only',
    }),
  });
  expect(room.getSnapshot().access).toBe('read');
  expect(drafts.discarded).toBe(1);
  room.destroy();
});

const evicted = (mode: 'drain' | 'discard') =>
  [
    {
      payload: JSON.stringify({
        evictionId: 'cev_1',
        materialId: 'q',
        mode,
        room: 'material:q:schema:1',
        type: 'access-changed',
      }),
    },
    { code: 0, reason: 'collaboration room evicted' },
  ] as const;

// REVIEW2 M1: a drain eviction (access widened) stored the room first, so the
// room rejoins with its document, edits in flight included, and nothing goes
// to copy-only recovery.
it('rejoins after a drain eviction, keeping its edits', async () => {
  const { onReplace, room } = await started();
  const [provider] = providers;
  provider.config.onSynced?.({ state: true });
  const [notice, close] = evicted('drain');
  provider.config.onStateless?.(notice);
  provider.config.onClose?.(close);
  await vi.advanceTimersByTimeAsync(2000);
  expect(provider.connects).toBe(2);
  expect(onReplace).not.toHaveBeenCalled();
  expect(drafts.refused).toBe(0);
  room.destroy();
});

// A discard threw the room's unsaved state away (its lineage moves): this
// room ends, its unsent edits stay stored, and a fresh room opens them for
// copying when the room moved.
it('ends after a discard eviction, keeping its edits stored', async () => {
  const { onReplace, room } = await started();
  const [provider] = providers;
  const [notice, close] = evicted('discard');
  provider.config.onStateless?.(notice);
  provider.config.onClose?.(close);
  await vi.advanceTimersByTimeAsync(2000);
  expect(onReplace).toHaveBeenCalledTimes(1);
  expect(provider.connects).toBe(1);
  expect(drafts.disposed).toBe(1);
  expect(drafts.refused).toBe(0);
  room.destroy();
});

// REVIEW5 B1: a first open that fails for want of the network (or the
// server) shows offline instead of unavailable, and joins once the browser
// is back online, its stored edits restored into the room; a 404 still ends
// it for good.
it('opens offline, then joins with its stored edits once back online', async () => {
  const page = new EventTarget();
  vi.stubGlobal('addEventListener', page.addEventListener.bind(page));
  vi.stubGlobal('removeEventListener', page.removeEventListener.bind(page));
  const row = { lineage: 'material:q:schema:1' };
  drafts.rows = [row];
  tokens.push(new TypeError('Failed to fetch'));
  const { room } = await started();
  expect(room.getSnapshot().status).toBe('offline');
  expect(providers).toHaveLength(0);
  page.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(0);
  expect(providers).toHaveLength(1);
  expect(providers[0].connects).toBe(1);
  expect(applyDrafts).toHaveBeenCalledWith(room.doc, [row], expect.anything());
  expect(room.getSnapshot().recovery).toBeNull();
  // Back online once is one join: no loop.
  page.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(0);
  expect(providers).toHaveLength(1);
  room.destroy();

  tokens.push(new ApiError(404, 'Not Found'));
  const gone = await started();
  expect(gone.room.getSnapshot().status).toBe('unavailable');
  gone.room.destroy();
  vi.unstubAllGlobals();
});

// REVIEW3 N2: a token request the API refuses (403, 404) ends the room as
// unavailable with no retry; one that fails (a 5xx, the network) retries
// with a note room's growing delay, not every 1.5 s forever.
it('stops on a refused token and backs off on a failing one', async () => {
  // No jitter: the delays are 500 ms, then 1 s, 2 s...
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const { room } = await started();
  const [provider] = providers;
  await provider.config.token();
  provider.config.onSynced?.({ state: true });
  // What the provider does when a join's token request throws.
  const join = async (error: Error) => {
    tokens.push(error);
    await provider.config.token().catch((thrown: Error) =>
      provider.config.onAuthenticationFailed?.({
        reason: `Failed to get token: ${thrown.message}`,
      })
    );
  };
  await join(new ApiError(503, 'Service Unavailable'));
  await vi.advanceTimersByTimeAsync(499);
  expect(provider.connects).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(provider.connects).toBe(2);
  await join(new TypeError('Failed to fetch'));
  await vi.advanceTimersByTimeAsync(999);
  expect(provider.connects).toBe(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(provider.connects).toBe(3);
  await join(new ApiError(403, 'Forbidden'));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(provider.connects).toBe(3);
  expect(room.getSnapshot().status).toBe('unavailable');
  room.destroy();
});
