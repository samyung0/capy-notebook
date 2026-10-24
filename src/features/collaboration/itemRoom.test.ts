import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ApiError } from '@/api/client';
import type { RoomProviderConfig } from './roomProvider';

// The room's provider, token and draft storage, recorded instead of real.
const providers: {
  config: RoomProviderConfig;
  connects: number;
  disconnects: number;
  stateless: string[];
}[] = [];
vi.mock('./roomProvider', () => ({
  RoomProvider: class {
    record: {
      config: RoomProviderConfig;
      connects: number;
      disconnects: number;
      stateless: string[];
    };
    constructor(config: RoomProviderConfig) {
      this.record = { config, connects: 0, disconnects: 0, stateless: [] };
      providers.push(this.record);
    }
    connect() {
      this.record.connects += 1;
    }
    disconnect() {
      this.record.disconnects += 1;
    }
    destroy() {}
    sendStateless(payload: string) {
      this.record.stateless.push(payload);
    }
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
// The draft send of never-accepted stored steps: settled by `release`.
const sending = vi.hoisted(() => ({
  done: false,
  kept: false,
  nows: 0,
  release: () => {},
}));
const drafts = vi.hoisted(() => ({
  adopted: [] as unknown[],
  discarded: 0,
  disposed: 0,
  held: [] as boolean[],
  onStorage: undefined as ((ok: boolean) => void) | undefined,
  refused: 0,
  rows: [] as unknown[],
  unsaved: true,
}));
vi.mock('@/lib/editDrafts', () => ({
  applyDrafts: vi.fn(),
  DRAFT_SEND_WAIT_MS: 30_000,
  deleteDrafts: vi.fn(async () => {
    drafts.rows = [];
  }),
  draftGroups: (
    rows: { lineage: string; refused?: boolean }[],
    room: string
  ) => {
    const recovery = rows.filter((row) => row.refused || row.lineage !== room);
    return {
      current: rows.filter((row) => !row.refused && row.lineage === room),
      recovery,
      refused: !!recovery[0]?.refused,
    };
  },
  draftKey: (actor: string, kind: string, id: string) =>
    `${actor}:${kind}:${id}`,
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
      get kept() {
        return sending.kept;
      },
      now() {
        sending.nows += 1;
      },
      settled,
      stop() {},
    };
  }),
  readDrafts: vi.fn(async () => drafts.rows),
  recordDrafts: (options: { onStorage: (ok: boolean) => void }) => {
    drafts.onStorage = options.onStorage;
    return {
      adopt(rows: unknown[]) {
        drafts.adopted.push(...rows);
      },
      connected() {},
      covered: async () => {
        drafts.unsaved = false;
      },
      discard: async () => {
        drafts.discarded += 1;
      },
      disconnected(held = false) {
        drafts.held.push(held);
      },
      dispose: async () => {
        drafts.disposed += 1;
      },
      refuse() {
        drafts.refused += 1;
      },
      sequence: 1,
      get unsaved() {
        return drafts.unsaved;
      },
    };
  },
  recoveryDocument: () => new Y.Doc(),
  // Rows with a stored token and no accepted mark go through the send.
  splitOpenDrafts: (rows: { accepted?: true; grants?: string[] }[]) => ({
    apply: rows.filter((row) => row.accepted || !row.grants),
    send: rows.filter((row) => !row.accepted && row.grants),
  }),
}));
vi.mock('@/components/ui/userToast', () => ({ userToast: vi.fn() }));
vi.mock('@/lib/appRelease', () => ({ markUpdateAvailable: vi.fn() }));
vi.mock('./unsentItems', () => ({ markUnsent: vi.fn() }));

const { ItemRoom, openItemRoom } = await import('./itemRoom');
const { NoteSeat } = await import('./noteSeat');
const { applyDrafts } = await import('@/lib/editDrafts');
const { itemEditingStopped } = await import('./itemRoom');
const { markUpdateAvailable } = await import('@/lib/appRelease');
const { markUnsent } = await import('./unsentItems');

beforeEach(() => {
  vi.useFakeTimers();
  providers.length = 0;
  tokens.length = 0;
  drafts.rows = [];
  drafts.adopted = [];
  sending.done = false;
  sending.kept = false;
  sending.nows = 0;
  drafts.held = [];
  drafts.refused = 0;
  drafts.discarded = 0;
  drafts.disposed = 0;
  drafts.unsaved = true;
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

// Rate-limit review r6 S-2: two copies of one embedded set in a note share
// one room, so the note's channel joins it once (the server closes a second
// channel of one room under a note); both read its state, the room stays
// while a copy holds it, and a replace reaches both copies.
it('shares one room between two copies of an embed in a note', async () => {
  const seat = new NoteSeat();
  const replaces = [vi.fn(), vi.fn()];
  const first = openItemRoom('q', {
    inside: seat,
    onReplace: replaces[0],
    read: true,
  });
  const second = openItemRoom('q', {
    inside: seat,
    onReplace: replaces[1],
    read: true,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(second.room).toBe(first.room);
  expect(providers).toHaveLength(1);
  const [provider] = providers;
  provider.config.onSynced?.({ state: true });
  expect(second.room.getSnapshot().synced).toBe(true);
  // Another document of the material is a room of its own.
  const keys = openItemRoom('q', {
    document: 'keys',
    inside: seat,
    onReplace: vi.fn(),
  });
  expect(keys.room).not.toBe(first.room);
  keys.close();

  const destroy = vi.spyOn(first.room, 'destroy');
  first.close();
  expect(destroy).not.toHaveBeenCalled();
  await provider.config.token();
  tokens.push({ access: 'write', room: 'material:q:schema:2' });
  await expect(provider.config.token()).rejects.toThrow('room moved');
  await vi.advanceTimersByTimeAsync(0);
  expect(replaces[0]).not.toHaveBeenCalled();
  expect(replaces[1]).toHaveBeenCalledTimes(1);
  second.close();
  expect(destroy).toHaveBeenCalledTimes(1);
  // The next copy opens a fresh room.
  const third = openItemRoom('q', {
    inside: seat,
    onReplace: vi.fn(),
    read: true,
  });
  expect(third.room).not.toBe(first.room);
  third.close();
});

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

// Saved means stored in the database (Epo 2026-10-19): edits the room
// acknowledged still show syncing until the receipt of the store that holds
// them, then saved.
it('shows syncing until a store receipt covers the edits, then saved', async () => {
  const { room } = await started();
  const [provider] = providers;
  provider.config.onSynced?.({ state: true });
  provider.config.onUnsyncedChanges?.({ number: 1 });
  expect(room.getSnapshot().status).toBe('syncing');
  provider.config.onUnsyncedChanges?.({ number: 0 });
  expect(room.getSnapshot().status).toBe('syncing');
  const { id } = JSON.parse(provider.stateless.at(-1) ?? '{}');
  provider.config.onStateless?.({
    payload: JSON.stringify({
      checkpointIds: [id],
      type: 'checkpoint-persisted',
    }),
  });
  expect(room.getSnapshot().status).toBe('saved');
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

// Q319, Q326: a never-accepted session's stored steps go through the draft
// send while the room joins; the room stays view-only (and syncing) until
// it settles, and its JOIN waits for nothing meanwhile.
it('joins while its stored steps are in the draft send, view-only until it settles', async () => {
  const row = { grants: ['t'], lineage: 'material:q:schema:1' };
  drafts.rows = [row];
  const { room } = await started();
  expect(providers[0].connects).toBe(1);
  expect(providers[0].config.beforeJoin?.()).toBeUndefined();
  expect(applyDrafts).not.toHaveBeenCalledWith(
    room.doc,
    [row],
    expect.anything()
  );
  providers[0].config.onSynced?.({ state: true });
  expect(room.getSnapshot()).toMatchObject({
    sending: true,
    status: 'syncing',
  });
  expect(itemEditingStopped(room.getSnapshot())).toBe(true);
  sending.release();
  await vi.advanceTimersByTimeAsync(0);
  expect(room.getSnapshot().sending).toBe(false);
  expect(itemEditingStopped(room.getSnapshot())).toBe(false);
  room.destroy();
});

// Q327, Q328: not settled 30 s on, the synced room takes the steps itself
// and edits on, its channel closed and every JOIN waiting for the send;
// once the send settles the JOIN goes. A send the room refused leaves the
// steps in the document, so the room refuses them live and the edits open
// for copying (the existing recovery).
it('takes its stored steps after 30 s, joins only once the send settles, and a refusal then opens recovery', async () => {
  const row = { grants: ['t'], lineage: 'material:q:schema:1' };
  drafts.rows = [row];
  // The page's offline event (this vitest has no window).
  const page = new EventTarget();
  Object.assign(globalThis, {
    addEventListener: page.addEventListener.bind(page),
    removeEventListener: page.removeEventListener.bind(page),
  });
  const { onReplace, room } = await started();
  providers[0].config.onSynced?.({ state: true });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(applyDrafts).toHaveBeenCalledWith(room.doc, [row], expect.anything());
  expect(drafts.adopted).toEqual([row]);
  expect(providers[0]).toMatchObject({ connects: 2, disconnects: 1 });
  expect(room.getSnapshot()).toMatchObject({
    sending: false,
    status: 'syncing',
  });
  expect(itemEditingStopped(room.getSnapshot())).toBe(false);
  // The hold is no editing incident (Q360).
  expect(drafts.held).toEqual([true]);
  // Its connect asks for a send at once (Q328, Q360).
  expect(providers[0].config.beforeJoin?.()).toBeInstanceOf(Promise);
  expect(sending.nows).toBe(1);
  // No channel is open: a browser that goes offline shows offline (Q360).
  page.dispatchEvent(new Event('offline'));
  expect(room.getSnapshot().status).toBe('offline');
  // Back online, syncing again while the send goes on (Q328, Q360).
  page.dispatchEvent(new Event('online'));
  expect(room.getSnapshot()).toMatchObject({
    offline: null,
    status: 'syncing',
  });
  Reflect.deleteProperty(globalThis, 'addEventListener');
  Reflect.deleteProperty(globalThis, 'removeEventListener');
  sending.release();
  await vi.advanceTimersByTimeAsync(0);
  expect(providers[0].config.beforeJoin?.()).toBeUndefined();
  providers[0].config.onStateless?.({
    payload: JSON.stringify({ code: 'unassigned', type: 'document-rejected' }),
  });
  expect(drafts.refused).toBe(1);
  await vi.advanceTimersByTimeAsync(0);
  expect(onReplace).toHaveBeenCalledTimes(1);
  room.destroy();
});

// Q360: a first sync after the 30 s still takes the held steps.
it('takes its stored steps at a first sync that comes after 30 s', async () => {
  const row = { grants: ['t'], lineage: 'material:q:schema:1' };
  drafts.rows = [row];
  const { room } = await started();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(applyDrafts).not.toHaveBeenCalledWith(
    room.doc,
    [row],
    expect.anything()
  );
  providers[0].config.onSynced?.({ state: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(applyDrafts).toHaveBeenCalledWith(room.doc, [row], expect.anything());
  expect(room.getSnapshot()).toMatchObject({
    sending: false,
    status: 'syncing',
  });
  room.destroy();
});

// Q360: a send that settles before the 30 s with a group the room did not
// take: a fresh room opens it copy-only, the steps never applied here.
it('opens a fresh room when its send settles with a group kept', async () => {
  const row = { grants: ['t'], lineage: 'material:q:schema:1' };
  drafts.rows = [row];
  const { onReplace, room } = await started();
  providers[0].config.onSynced?.({ state: true });
  sending.kept = true;
  sending.release();
  await vi.advanceTimersByTimeAsync(0);
  expect(onReplace).toHaveBeenCalledTimes(1);
  expect(applyDrafts).not.toHaveBeenCalledWith(
    room.doc,
    [row],
    expect.anything()
  );
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

// The version gate (Epo 2026-10-16): a room that refuses this build stops
// for the page load. A writer turns read-only under the outdated strip and
// keeps its unsent edits stored for the reloaded page; a reader keeps what
// it painted and shows no strip.
it('stops when refused as outdated, a writer keeping its edits stored', async () => {
  const { onReplace, room } = await started();
  const [provider] = providers;
  provider.config.onSynced?.({ state: true });
  provider.config.onAuthenticationFailed?.({
    reason: 'collaboration-outdated',
  });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(provider.connects).toBe(1);
  expect(onReplace).not.toHaveBeenCalled();
  expect(room.getSnapshot().offline).toBe('outdated');
  expect(drafts).toMatchObject({ discarded: 0, refused: 0 });
  // The next page change loads the new app.
  expect(markUpdateAvailable).toHaveBeenCalledOnce();
  room.destroy();
  expect(drafts.disposed).toBe(1);

  const reader = new ItemRoom('q', { read: true });
  await reader.start();
  providers[1].config.onAuthenticationFailed?.({
    reason: 'collaboration-outdated',
  });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(providers[1].connects).toBe(1);
  expect(reader.getSnapshot().offline).toBeNull();
  reader.destroy();
});

// Edits this device could not store are lost on the reload: the strip says
// so and leaving still asks.
it('says the reload loses edits this device could not store', async () => {
  const { room } = await started();
  const [provider] = providers;
  provider.config.onSynced?.({ state: true });
  drafts.onStorage?.(false);
  provider.config.onAuthenticationFailed?.({
    reason: 'collaboration-outdated',
  });
  expect(room.getSnapshot().offline).toBe('outdated-unstored');
  expect(markUnsent).toHaveBeenLastCalledWith(room, true);
  room.destroy();
});

// Epo 2026-10-20: an open waiting on the user's open budget keeps loading,
// even past the reconnect grace and after a socket drop showed offline.
it('loads while its open is slowed, never offline, until it syncs', async () => {
  const { room } = await started();
  const [provider] = providers;
  provider.config.onSynced?.({ state: true });
  provider.config.onClose?.({ code: 0, reason: 'socket closed' });
  expect(room.getSnapshot().status).toBe('offline');
  provider.config.onSlowed?.(true);
  expect(room.getSnapshot()).toMatchObject({
    offline: null,
    slowed: true,
    status: 'connecting',
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(room.getSnapshot().status).toBe('connecting');
  provider.config.onSynced?.({ state: true });
  expect(room.getSnapshot().slowed).toBe(false);
  // A slowed open whose channel parked (closed as the user's oldest) shows
  // no slowed line (rate-limit review r6 N-4).
  provider.config.onSlowed?.(true);
  provider.config.onSlowed?.(false);
  expect(room.getSnapshot().slowed).toBe(false);
  room.destroy();
});

// Epo 2026-10-23: an item room's join has 30 s from its token request; one
// never answered then shows the room's connection error (offline).
it('goes offline when its join has not finished 30 s after its token request', async () => {
  vi.stubGlobal('navigator', { onLine: true });
  const { room } = await started();
  vi.advanceTimersByTime(29_999);
  expect(room.getSnapshot().status).toBe('connecting');
  vi.advanceTimersByTime(1);
  expect(room.getSnapshot().status).toBe('offline');
  vi.unstubAllGlobals();
});
