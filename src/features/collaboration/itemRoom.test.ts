import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
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
const tokens: { access: string; room: string }[] = [];
vi.mock('@/api/hooks', () => ({
  getMaterialCollaborationToken: vi.fn(async () => {
    const next = tokens.shift() ?? {
      access: 'write',
      room: 'material:q:schema:1',
    };
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

beforeEach(() => {
  vi.useFakeTimers();
  providers.length = 0;
  tokens.length = 0;
  drafts.rows = [];
  drafts.refused = 0;
  drafts.discarded = 0;
  drafts.disposed = 0;
});
afterEach(() => vi.useRealTimers());

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
