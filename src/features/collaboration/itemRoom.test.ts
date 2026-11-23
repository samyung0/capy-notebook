import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ApiError, qk } from '@/api/client';
import {
  COLLABORATION_LATE_REASON,
  COLLABORATION_NOT_FOUND_REASON,
} from '@/features/notes/collaborationEvents';
import { m } from '@/i18n';
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
  // While set, grouping the rows waits for it (the drafts worker's answer).
  gate: null as Promise<void> | null,
  held: [] as boolean[],
  onLost: undefined as (() => void) | undefined,
  onStorage: undefined as ((ok: boolean) => void) | undefined,
  recorded: 0,
  refused: 0,
  report: undefined as unknown,
  rows: [] as unknown[],
  unsaved: true,
  // The recorder's dispose wrote its document (unsaved work remained).
  written: false,
}));
// A deleted item's drawing is the real one (`deletedDocument`, `shownRows`).
const shownDeleted = vi.hoisted(() => [] as { key: string; rows: unknown }[]);
vi.mock('@/lib/editDrafts', async (load) => ({
  applyDrafts: vi.fn(),
  DRAFT_SEND_WAIT_MS: 30_000,
  deleteDrafts: vi.fn(async () => {
    drafts.rows = [];
  }),
  deletedDocument: (await load<typeof import('@/lib/editDrafts')>())
    .deletedDocument,
  deleteShownDrafts: vi.fn(async (key: string, rows: unknown) => {
    shownDeleted.push({ key, rows });
    return 0;
  }),
  draftGroups: async (
    rows: { expired?: boolean; lineage: string; refused?: boolean }[],
    room: string
  ) => {
    await drafts.gate;
    const recovery = rows.filter(
      (row) => row.expired || row.refused || row.lineage !== room
    );
    return {
      current: rows.filter(
        (row) => !(row.expired || row.refused) && row.lineage === room
      ),
      expired: !!recovery[0]?.expired,
      recovery,
      refused: !!recovery[0]?.refused,
    };
  },
  draftKey: (actor: string, kind: string, id: string) =>
    `${actor}:${kind}:${id}`,
  // The item's stored edits on this device: rows, or the recorder's last.
  draftMaterials: vi.fn(
    async () => new Set(drafts.rows.length || drafts.written ? ['q'] : [])
  ),
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
  dropExpiredGroup: vi.fn(),
  heldDraftSessions: async () => new Set<string>(),
  holdDraftDocument: () => () => undefined,
  readDrafts: vi.fn(async () => drafts.rows),
  recordDrafts: (options: {
    onLost?: () => void;
    onStorage: (ok: boolean) => void;
    report?: unknown;
  }) => {
    drafts.recorded += 1;
    drafts.onLost = options.onLost;
    drafts.onStorage = options.onStorage;
    drafts.report = options.report;
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
        await null;
        if (drafts.unsaved) drafts.written = true;
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
  shownRows: (await load<typeof import('@/lib/editDrafts')>()).shownRows,
  // Rows with a stored token and no accepted mark go through the send.
  splitOpenDrafts: (rows: { accepted?: true; grants?: string[] }[]) => ({
    apply: rows.filter((row) => row.accepted || !row.grants),
    send: rows.filter((row) => !row.accepted && row.grants),
  }),
}));
vi.mock('@/components/ui/userToast', () => ({ userToast: vi.fn() }));
const invalidateQueries = vi.hoisted(() => vi.fn());
vi.mock('@/api/queryClient', () => ({ queryClient: { invalidateQueries } }));
vi.mock('@/lib/appRelease', () => ({ markUpdateAvailable: vi.fn() }));
vi.mock('@/lib/sourceCache', async (load) => ({
  ...(await load<typeof import('@/lib/sourceCache')>()),
  dropDeviceCopies: vi.fn(async () => undefined),
}));

const { ItemRoom, openItemRoom } = await import('./itemRoom');
const { NoteSeat } = await import('./noteSeat');
const { applyDrafts } = await import('@/lib/editDrafts');
const { itemEditingStopped } = await import('./itemRoom');
const { markUpdateAvailable } = await import('@/lib/appRelease');
const { draftMaterials, draftSender, dropExpiredGroup } = await import(
  '@/lib/editDrafts'
);
const { dropDeviceCopies } = await import('@/lib/sourceCache');
const { userToast } = await import('@/components/ui/userToast');

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
  drafts.gate = null;
  drafts.recorded = 0;
  drafts.unsaved = true;
  drafts.written = false;
  shownDeleted.length = 0;
  vi.mocked(draftMaterials).mockClear();
  vi.mocked(dropDeviceCopies).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function started(onReplace = vi.fn()) {
  const room = new ItemRoom('q', {
    drafts: { actorId: 'u', kind: 'quiz' },
    onReplace,
  });
  await room.start();
  return { onReplace, room };
}

/** The page's `beforeunload` listeners: whether closing the tab asks. */
function leavePrompt() {
  const page = new EventTarget();
  vi.stubGlobal('addEventListener', page.addEventListener.bind(page));
  vi.stubGlobal('removeEventListener', page.removeEventListener.bind(page));
  return () => {
    const event = new Event('beforeunload', { cancelable: true });
    page.dispatchEvent(event);
    return event.defaultPrevented;
  };
}

// Q561 (Epo 2026-10-29, Q465's rule): no in-app guard; the tab's own close
// or reload asks only while this device's draft storage fails and the room
// has not acknowledged an edit (its receipt). Fails if the prompt arms on
// unacknowledged edits alone, as the old one did.
it("asks on the tab's close only while storage fails with an edit unacknowledged", async () => {
  const asks = leavePrompt();
  const { room } = await started();
  const [provider] = providers;
  provider.config.onSynced?.({ state: true });
  provider.config.onUnsyncedChanges?.({ number: 1 });
  expect(asks()).toBe(false);
  drafts.onStorage?.(false);
  expect(asks()).toBe(true);
  // Acknowledged and stored by the room: nothing to lose.
  provider.config.onUnsyncedChanges?.({ number: 0 });
  const { id } = JSON.parse(provider.stateless.at(-1) ?? '{}');
  provider.config.onStateless?.({
    payload: JSON.stringify({
      checkpointIds: [id],
      type: 'checkpoint-persisted',
    }),
  });
  expect(asks()).toBe(false);
  provider.config.onUnsyncedChanges?.({ number: 1 });
  expect(asks()).toBe(true);
  drafts.onStorage?.(true);
  expect(asks()).toBe(false);
  room.destroy();
});

// A room that ended (refused here), turned read-only or left the page asks
// nothing more while storage fails, nor once a late write's failure (its
// recorder's last) arrives after it ended or left.
it('stops asking once the room ends, turns read-only or is destroyed', async () => {
  const asks = leavePrompt();
  const unacknowledged = async () => {
    const { room } = await started();
    const provider = providers.at(-1)!;
    provider.config.onSynced?.({ state: true });
    provider.config.onUnsyncedChanges?.({ number: 1 });
    drafts.onStorage?.(false);
    expect(asks()).toBe(true);
    const event = (type: string) =>
      provider.config.onStateless?.({ payload: JSON.stringify({ type }) });
    return { event, room };
  };

  const ended = await unacknowledged();
  ended.event('document-rejected');
  expect(asks()).toBe(false);
  drafts.onStorage?.(false);
  expect(asks()).toBe(false);
  ended.room.destroy();

  const readOnly = await unacknowledged();
  readOnly.event('room-read-only');
  expect(asks()).toBe(false);
  readOnly.room.destroy();

  const destroyed = await unacknowledged();
  destroyed.room.destroy();
  expect(asks()).toBe(false);
  drafts.onStorage?.(false);
  expect(asks()).toBe(false);
});

// Rate-limit review r6 S-2: two copies of one embedded set in a note share
// one room, so the note's channel joins it once (the server closes a second
// channel of one room under a note); both read its state, the room stays
// while a copy holds it, and a replace reaches both copies.
it('shares one room between two copies of an embed in a note', async () => {
  const seat = new NoteSeat();
  const replaces = [vi.fn(), vi.fn()];
  const first = openItemRoom('q', {
    inside: seat,
    kind: 'quiz',
    onReplace: replaces[0],
    read: true,
  });
  const second = openItemRoom('q', {
    inside: seat,
    kind: 'quiz',
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
    kind: 'quiz',
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
    kind: 'quiz',
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

// Epo 2026-11-05: a close for one person's access change comes with no notice,
// so it joins again and the token says what they have: a demotion reads on, a
// removal stops there, and the page's read says what shows (Epo 2026-11-20,
// "the page should itself refetch and show the 404 error").
it('joins again after a close for this person, and the token decides', async () => {
  const { onReplace, room } = await started();
  const [provider] = providers;
  await provider.config.token();
  provider.config.onSynced?.({ state: true });
  const targeted = { code: 4403, reason: 'collaboration access changed' };

  provider.config.onClose?.(targeted);
  await vi.advanceTimersByTimeAsync(2000);
  expect(provider.connects).toBe(2);
  tokens.push({ access: 'read', room: 'material:q:schema:1' });
  await provider.config.token();
  expect(room.getSnapshot()).toMatchObject({ access: 'read' });
  expect(room.getSnapshot().status).not.toBe('unavailable');

  provider.config.onClose?.(targeted);
  await vi.advanceTimersByTimeAsync(2000);
  tokens.push(new ApiError(404, 'Not Found'));
  await provider.config.token().catch((thrown: Error) =>
    provider.config.onAuthenticationFailed?.({
      reason: `Failed to get token: ${thrown.message}`,
    })
  );
  expect(room.getSnapshot().status).toBe('unavailable');
  expect(onReplace).not.toHaveBeenCalled();
  expect(invalidateQueries.mock.calls).toEqual([
    [{ queryKey: qk.material('q') }],
    [{ queryKey: qk.quiz('q') }],
  ]);
  invalidateQueries.mockClear();
  room.destroy();
});

// A quiz's keys room started as its editor is demoted: its first token is
// refused as read-only, as the server refuses keys to anyone who cannot write.
// That is the room turning read-only, not lost access.
it('reads a keys room whose first token is refused as read-only, asking for no read', async () => {
  tokens.push(new ApiError(403, 'Forbidden', 'collaboration-read-only'));
  const room = new ItemRoom('q', {
    document: 'keys',
    drafts: { actorId: 'u', kind: 'quiz' },
    onReplace: vi.fn(),
  });
  await room.start();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(room.getSnapshot()).toMatchObject({ access: 'read', offline: null });
  expect(room.getSnapshot().status).not.toBe('unavailable');
  expect(providers).toHaveLength(0);
  expect(invalidateQueries).not.toHaveBeenCalled();
  room.destroy();
});

// A quiz's keys closed for the demotion (4403): their rejoin's token is
// refused as read-only, and the room reads, joining nothing more, rather than
// retrying the refusal into the offline strip.
it('reads a keys room whose rejoin is refused as read-only, joining no more', async () => {
  const room = new ItemRoom('q', {
    document: 'keys',
    drafts: { actorId: 'u', kind: 'quiz' },
    onReplace: vi.fn(),
  });
  await room.start();
  const [provider] = providers;
  await provider.config.token();
  provider.config.onSynced?.({ state: true });
  provider.config.onClose?.({
    code: 4403,
    reason: 'collaboration access changed',
  });
  await vi.advanceTimersByTimeAsync(2000);
  expect(provider.connects).toBe(2);
  tokens.push(new ApiError(403, 'Forbidden', 'collaboration-read-only'));
  await provider.config.token().catch((thrown: Error) =>
    provider.config.onAuthenticationFailed?.({
      reason: `Failed to get token: ${thrown.message}`,
    })
  );
  await vi.advanceTimersByTimeAsync(60_000);
  expect(room.getSnapshot()).toMatchObject({ access: 'read', offline: null });
  expect(provider.connects).toBe(2);
  room.destroy();
});

// Epo 2026-11-05 (Q644): a refusal with no such close may mean the item is gone,
// so the page's read says, once a fresh token said it was not deleted.
it('asks for the read when refused with no access change first', async () => {
  const { room } = await started();
  const [provider] = providers;
  await provider.config.token();
  provider.config.onSynced?.({ state: true });
  tokens.push(new ApiError(404, 'Not Found'));
  provider.config.onAuthenticationFailed?.({
    reason: COLLABORATION_NOT_FOUND_REASON,
  });
  await vi.waitFor(() => expect(room.getSnapshot().status).toBe('unavailable'));
  expect(invalidateQueries).toHaveBeenCalledWith({
    queryKey: qk.material('q'),
  });
  invalidateQueries.mockClear();
  room.destroy();
});

// Q425: a note View's read channel answered late (its version behind the
// collection window) ends, so a fresh document joins naming no version,
// instead of rejoining with the same version, late again, forever.
it('joins afresh when a read channel is answered late, never rejoining late', async () => {
  tokens.push({ access: 'read', room: 'material:n:schema:1' });
  const onReplace = vi.fn();
  const room = new ItemRoom('n', { onReplace, read: true });
  await room.start();
  const [provider] = providers;
  provider.config.onAuthenticationFailed?.({
    reason: COLLABORATION_LATE_REASON,
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(onReplace).toHaveBeenCalledTimes(1);
  expect(provider.connects).toBe(1);
  room.destroy();
});

// REVIEW1 M5: a fresh token naming another room (discarded) ends
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
// copying instead of the room; Discard drops them and opens a fresh room.
it('opens stored refused edits in recovery until Discard', async () => {
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

// Item rooms have no late merge (in-place GC): stored late edits open
// read-only for copying and are never applied raw.
it('opens stored late edits in recovery, never applying them raw', async () => {
  vi.mocked(applyDrafts).mockClear();
  drafts.rows = [{ late: true, lineage: 'material:q:schema:1' }];
  const { room } = await started();
  expect(providers).toHaveLength(0);
  expect(applyDrafts).not.toHaveBeenCalled();
  expect(room.getSnapshot().recovery?.refused).toBe(true);
  room.destroy();
});

// D14 (Epo 2026-11-04): stored edits past the 7-day expiry leave the room to
// open as usual, a toast offers them, and they go as it closes.
it('opens past expired stored edits, offered in a toast until it closes', async () => {
  const row = { expired: true, lineage: 'material:q:schema:1' };
  drafts.rows = [row];
  vi.mocked(userToast).mockClear();
  const { room } = await started();
  expect(providers).toHaveLength(1);
  expect(room.getSnapshot().recovery).toBeNull();
  const toast = vi.mocked(userToast).mock.calls.at(-1)?.[0];
  expect(toast?.button?.label).toBe(m.editor_old_edits_download());
  expect(dropExpiredGroup).not.toHaveBeenCalled();
  toast?.onClose?.();
  expect(dropExpiredGroup).toHaveBeenCalledWith([row], expect.any(Function));
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

// r6 S1: destroyed while the drafts worker groups its rows, the room starts
// no recorder (its document lock) and no draft send.
it('starts nothing when destroyed while its stored rows are grouped', async () => {
  drafts.rows = [{ grants: ['t'], lineage: 'material:q:schema:1' }];
  let answer = () => {};
  drafts.gate = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const sends = vi.mocked(draftSender).mock.calls.length;
  const room = new ItemRoom('q', { drafts: { actorId: 'u', kind: 'quiz' } });
  const starting = room.start();
  await vi.advanceTimersByTimeAsync(0);
  room.destroy();
  answer();
  await starting;
  expect(drafts.recorded).toBe(0);
  expect(vi.mocked(draftSender).mock.calls.length).toBe(sends);
  expect(providers).toHaveLength(0);
});

// r6 N1: restored rows the room cannot place go with an incident and the
// drafts-lost notice, as in notes.
it('reports restored rows the room cannot place and tells the user', async () => {
  const { room } = await started();
  expect(drafts.report).toBeTypeOf('function');
  vi.mocked(userToast).mockClear();
  drafts.onLost?.();
  expect(userToast).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'drafts-lost' })
  );
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

// REVIEW2 M1: a drain eviction (a Move, a hide) stored the room first, so the
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
  expect(invalidateQueries).not.toHaveBeenCalled();
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
  // It may be gone: the page's read says (Epo 2026-11-05).
  expect(invalidateQueries).toHaveBeenCalledWith({
    queryKey: qk.material('q'),
  });
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

// Epo 2026-11-05 ("never reconnect ... show stale ones if necessary"): a quiz
// assigned to a viewer since refuses their next join, at a token's expiry or a
// lost connection. The reader's document stays, with nothing to show for it: no
// toast, no fresh room, no retries.
it('a reader refused on its next join keeps its document, quietly', async () => {
  vi.mocked(userToast).mockClear();
  tokens.push({ access: 'read', room: 'material:q:schema:1' });
  const onReplace = vi.fn();
  const room = new ItemRoom('q', { onReplace, read: true });
  await room.start();
  const [provider] = providers;
  await provider.config.token();
  provider.config.onSynced?.({ state: true });
  room.doc.getMap('questions').set('q1', 'Name a cell part.');
  provider.config.onClose?.({
    code: 4401,
    reason: 'collaboration token expired',
  });
  tokens.push(new ApiError(404, 'Not Found'));
  await provider.config.token().catch((thrown: Error) =>
    provider.config.onAuthenticationFailed?.({
      reason: `Failed to get token: ${thrown.message}`,
    })
  );
  const connects = provider.connects;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(provider.connects).toBe(connects);
  expect(room.getSnapshot()).toMatchObject({
    offline: null,
    status: 'unavailable',
    synced: true,
  });
  expect(room.doc.getMap('questions').get('q1')).toBe('Name a cell part.');
  expect(onReplace).not.toHaveBeenCalled();
  expect(userToast).not.toHaveBeenCalled();
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
// so and closing the tab still asks.
it('says the reload loses edits this device could not store', async () => {
  const asks = leavePrompt();
  const { room } = await started();
  const [provider] = providers;
  provider.config.onSynced?.({ state: true });
  drafts.onStorage?.(false);
  provider.config.onAuthenticationFailed?.({
    reason: 'collaboration-outdated',
  });
  expect(room.getSnapshot().offline).toBe('outdated-unstored');
  expect(asks()).toBe(true);
  room.destroy();
});

// Epo 2026-10-20: an open waiting on the user's open budget keeps loading,
// even past the reconnect grace and after a socket drop showed offline.
it('loads while its open is slowed, never offline, until it syncs', async () => {
  const { room } = await started();
  const [provider] = providers;
  provider.config.onClose?.({ code: 0, reason: 'socket closed' });
  expect(room.getSnapshot().status).toBe('offline');
  provider.config.onSlowed?.(true);
  expect(room.getSnapshot()).toMatchObject({
    offline: null,
    slowed: true,
    status: 'opening',
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(room.getSnapshot().status).toBe('opening');
  provider.config.onSynced?.({ state: true });
  expect(room.getSnapshot().slowed).toBe(false);
  // A slowed open whose channel parked (closed as the user's oldest) shows
  // no slowed line (rate-limit review r6 N-4).
  provider.config.onSlowed?.(true);
  provider.config.onSlowed?.(false);
  expect(room.getSnapshot().slowed).toBe(false);
  room.destroy();
});

// Epo 2026-11-04: a rejoin changes nothing until its 30 s passed.
it('keeps its status through a drop until its 30 s passed', async () => {
  vi.stubGlobal('navigator', { onLine: true });
  const { room } = await started();
  const [provider] = providers;
  provider.config.onSynced?.({ state: true });
  const { status } = room.getSnapshot();
  expect(status).not.toBe('opening');
  provider.config.onSynced?.({ state: false });
  provider.config.onClose?.({ code: 0, reason: 'socket closed' });
  expect(room.getSnapshot().status).toBe(status);
  vi.advanceTimersByTime(29_999);
  expect(room.getSnapshot().status).toBe(status);
  provider.config.onSynced?.({ state: true });
  vi.advanceTimersByTime(60_000);
  expect(room.getSnapshot().status).toBe(status);
  provider.config.onClose?.({ code: 0, reason: 'socket closed' });
  vi.advanceTimersByTime(30_000);
  expect(room.getSnapshot().status).toBe('offline');
  room.destroy();
  vi.unstubAllGlobals();
});

// Epo 2026-10-23: an item room's join has 30 s from its token request; one
// never answered then shows the room's connection error (offline).
it('goes offline when its join has not finished 30 s after its token request', async () => {
  vi.stubGlobal('navigator', { onLine: true });
  const { room } = await started();
  vi.advanceTimersByTime(29_999);
  expect(room.getSnapshot().status).toBe('opening');
  vi.advanceTimersByTime(1);
  expect(room.getSnapshot().status).toBe('offline');
  vi.unstubAllGlobals();
});

// A canvas's room (Epo 2026-11-18): its pointers and selections go through an
// awareness the room keeps on its own document, silent until a state is set.
it('keeps an awareness on its document and hands it to its provider', async () => {
  const room = new ItemRoom('q', { awareness: true, onReplace: vi.fn() });
  await room.start();
  const [provider] = providers;
  expect(room.awareness?.doc).toBe(room.doc);
  expect(provider.config.awareness).toBe(room.awareness);
  expect(room.awareness?.getLocalState()).toBe(null);
  room.destroy();
});

// A canvas's open plane or chart writes as it closes: the page hears the room
// is going before the room's document does.
it('tells its page it is going while its document still stands', async () => {
  const stood: boolean[] = [];
  const room = new ItemRoom('q', {
    onLeave: () => stood.push(!room.doc.isDestroyed),
    onReplace: vi.fn(),
  });
  await room.start();
  room.destroy();
  expect(stood).toEqual([true]);
  expect(room.doc.isDestroyed).toBe(true);

  // A page whose callback throws still loses the room.
  const failing = new ItemRoom('q', {
    awareness: true,
    onLeave: () => {
      throw new Error('the page failed');
    },
    onReplace: vi.fn(),
  });
  await failing.start();
  failing.awareness?.setLocalState({});
  expect(() => failing.destroy()).toThrow('the page failed');
  expect(failing.doc.isDestroyed).toBe(true);
  expect(failing.awareness?.getLocalState()).toBeNull();
});

// Developer 2026-09-30 (a permanent refusal keeps the unsaved edits to copy)
// and Epo 2026-11-18 ("dont just delete stuff without user acknowledgement"):
// a canvas refused for its size keeps this tab's edits as any item does.
it("keeps a full canvas's refused edits to copy, and opens afresh", async () => {
  vi.mocked(userToast).mockClear();
  const onReplace = vi.fn();
  const room = new ItemRoom('q', {
    board: { max: 4096 },
    drafts: { actorId: 'u', kind: 'canvas' },
    onReplace,
  });
  await room.start();
  const [provider] = providers;
  provider.config.onSynced?.({ state: true });
  provider.config.onStateless?.({
    payload: JSON.stringify({
      code: 'document_size_exceeded',
      type: 'document-rejected',
    }),
  });
  // The close that follows the refusal ends nothing a second time.
  provider.config.onClose?.({ code: 4400, reason: 'document rejected' });
  await vi.advanceTimersByTimeAsync(0);
  expect(drafts.refused).toBe(1);
  expect(drafts.discarded).toBe(0);
  expect(onReplace).toHaveBeenCalledOnce();
  expect(userToast).toHaveBeenCalledOnce();
  room.destroy();
});

// Epo 2026-11-18 (2B, client-limits A): a board's size is the room's measure
// at each receipt plus what arrived since; offline, its work stops at the
// space the cap leaves.
it("keeps a board's size from its receipts and stops offline work at the space left", async () => {
  vi.stubGlobal('navigator', { onLine: false });
  const room = new ItemRoom('q', {
    board: { max: 100_000 },
    drafts: { actorId: 'u', kind: 'canvas' },
    onReplace: vi.fn(),
  });
  await room.start();
  const [provider] = providers;
  const sizes: (number | undefined)[] = [];
  room.subscribeSize(() => sizes.push(room.size()?.bytes));
  provider.config.onSynced?.({ state: true });
  provider.config.onUnsyncedChanges?.({ number: 0 });
  const { id } = JSON.parse(provider.stateless.at(-1) ?? '{}');
  provider.config.onStateless?.({
    payload: JSON.stringify({
      checkpointIds: [id],
      metrics: { contentBytes: 20_000 },
      type: 'checkpoint-persisted',
    }),
  });
  expect(room.size()).toEqual({ bytes: 20_000, max: 100_000 });
  provider.config.onClose?.({ code: 1006, reason: 'socket closed' });
  expect(room.getSnapshot().offline).toBe('offline');
  room.doc.getText('t').insert(0, 'x'.repeat(10_000));
  expect(room.size()?.bytes).toBeGreaterThan(30_000);
  expect(room.getSnapshot().offline).toBe('offline');
  // Within the margin of the cap: the board stops taking edits.
  room.doc.getText('t').insert(0, 'x'.repeat(20_000));
  expect(room.getSnapshot().offline).toBe('offline-limit');
  expect(sizes[0]).toBe(20_000);
  room.destroy();
});

// Epo 2026-09-29: a board turned read-only drops its unsaved edits and shows
// what was saved, which its document no longer holds alone: a fresh room.
it('opens a fresh room when a board turns read-only with unsaved edits', async () => {
  const onReplace = vi.fn();
  const room = new ItemRoom('q', {
    board: { max: 4096 },
    drafts: { actorId: 'u', kind: 'canvas' },
    onReplace,
  });
  await room.start();
  const [provider] = providers;
  await provider.config.token();
  provider.config.onSynced?.({ state: true });
  tokens.push({ access: 'read', room: 'material:q:schema:1' });
  await expect(provider.config.token()).rejects.toThrow(
    'collaboration room moved'
  );
  expect(room.getSnapshot().access).toBe('read');
  await vi.advanceTimersByTimeAsync(0);
  expect(drafts.discarded).toBe(1);
  expect(onReplace).toHaveBeenCalledOnce();
  room.destroy();
});

// Epo 2026-11-04 (D5, C9): a join with no answer 30 s after it began, the
// browser online, says the service is unavailable, and Retry asks again.
it('says it is unreachable 30 s into a failing open, and Retry starts again', async () => {
  vi.stubGlobal('navigator', { onLine: true });
  tokens.push(new ApiError(503, 'Service Unavailable'));
  const { room } = await started();
  expect(room.getSnapshot()).toMatchObject({
    status: 'offline',
    unreachable: false,
  });
  vi.advanceTimersByTime(30_000);
  expect(room.getSnapshot().unreachable).toBe(true);
  room.retry();
  await vi.advanceTimersByTimeAsync(0);
  expect(room.getSnapshot().unreachable).toBe(false);
  expect(providers).toHaveLength(1);
  providers[0].config.onSynced?.({ state: true });
  expect(room.getSnapshot().status).not.toBe('offline');
  room.destroy();
});

// Epo 2026-10-04: a receipt waiting 25 s of connected time, or a store the
// room says failed with edits unsaved, shows "Saving is delayed" until a
// receipt answers.
it('says saving is delayed past 25 s without a receipt, or on a failed store', async () => {
  const { room } = await started();
  const [provider] = providers;
  provider.config.onSynced?.({ state: true });
  provider.config.onUnsyncedChanges?.({ number: 0 });
  vi.advanceTimersByTime(24_999);
  expect(room.getSnapshot().delayed).toBe(false);
  vi.advanceTimersByTime(1);
  expect(room.getSnapshot().delayed).toBe(true);
  const { id } = JSON.parse(provider.stateless.at(-1) ?? '{}');
  provider.config.onStateless?.({
    payload: JSON.stringify({
      checkpointIds: [id],
      type: 'checkpoint-persisted',
    }),
  });
  expect(room.getSnapshot().delayed).toBe(false);
  drafts.unsaved = true;
  provider.config.onStateless?.({
    payload: JSON.stringify({ materialId: 'q', type: 'checkpoint-failed' }),
  });
  expect(room.getSnapshot().delayed).toBe(true);
  room.destroy();
});

it('keeps a refused update to copy when the room is not a canvas', async () => {
  const { onReplace, room } = await started();
  const [provider] = providers;
  provider.config.onSynced?.({ state: true });
  provider.config.onStateless?.({
    payload: JSON.stringify({
      code: 'document_size_exceeded',
      type: 'document-rejected',
    }),
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(drafts.refused).toBe(1);
  expect(drafts.discarded).toBe(0);
  expect(onReplace).toHaveBeenCalledOnce();
  room.destroy();
});

it('takes nothing between a close for this person and the next sync', async () => {
  const { room } = await started();
  const [provider] = providers;
  await provider.config.token();
  provider.config.onSynced?.({ state: true });
  expect(room.getSnapshot().stopped).toBe(false);
  provider.config.onClose?.({
    code: 4403,
    reason: 'collaboration access changed',
  });
  expect(room.getSnapshot().stopped).toBe(true);
  // Still theirs: the next sync takes edits again.
  provider.config.onSynced?.({ state: true });
  expect(room.getSnapshot().stopped).toBe(false);
  room.destroy();
});

/** A closed session's whole document, as its recorder leaves it. */
function stateRow(doc: Y.Doc, lineage: string, session: string) {
  return {
    data: Y.encodeStateAsUpdate(doc),
    id: `${session}:state`,
    key: 'u:material:q',
    kind: 'state',
    lineage,
    savedAt: Date.now(),
    seq: 1,
    session,
  };
}

const gone = () =>
  new ApiError(410, 'Gone', undefined, {
    code: 'item_deleted',
    kind: 'quiz',
    name: 'Cell quiz',
  });

// Q39 (review 2026-11-20): a quiz deleted before this room joined shows its
// stored edits drawn from the rows alone, read-only, and says it is deleted,
// which keeps a quiz's keys room beside it. What it draws is its newest
// group; an older lineage's rows stay out of what it shows.
it("shows a deleted item's newest stored edits for copying, and only those", async () => {
  const shown = new Y.Doc();
  shown.getMap('questions').set('q1', 'Mitosis');
  const older = new Y.Doc();
  older.getMap('questions').set('q0', 'Meiosis');
  const newest = stateRow(shown, 'material:q:schema:2', 'b');
  const old = { ...stateRow(older, 'material:q:schema:1', 'a'), savedAt: 1 };
  drafts.rows = [old, newest];
  tokens.push(gone());
  const { room } = await started();
  await vi.waitFor(() => expect(room.getSnapshot().recovery).not.toBeNull());
  const snapshot = room.getSnapshot();
  expect(snapshot).toMatchObject({
    deleted: true,
    recovery: { deleted: true, refused: true },
    status: 'saved',
  });
  expect(snapshot.recovery?.doc.getMap('questions').toJSON()).toEqual({
    q1: 'Mitosis',
  });
  expect(snapshot.recovery?.rows).toEqual([newest]);
  room.destroy();
});

// A quiz whose only unsent edits are to its keys: its content room has
// nothing to draw, so it is unavailable, but deleted, so its keys room stays
// for the keys' edits (liveQuizRooms).
it('says a deleted item with no stored edits is deleted and unavailable', async () => {
  tokens.push(gone());
  const { room } = await started();
  await vi.waitFor(() => expect(room.getSnapshot().status).toBe('unavailable'));
  expect(room.getSnapshot()).toMatchObject({ deleted: true, recovery: null });
  room.destroy();
});

// Review 2026-11-20 (3): a token's 409 says the item was restored between
// the server's checks: the first one asks again shortly, still connecting,
// and one after the service's own not found rejoins.
it('asks again after a first token answered that the item was restored since', async () => {
  tokens.push(new ApiError(409, 'Conflict'));
  const { room } = await started();
  expect(room.getSnapshot().status).not.toBe('offline');
  expect(providers).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(2000);
  expect(providers).toHaveLength(1);
  room.destroy();
});

// A granted token says the item is live too (review 2026-11-20 (4)), and
// no answer (offline, a server error) says nothing: it joins again, its copy
// kept (review 2026-11-20 (5)).
it.each([
  ['answers that it was restored since', new ApiError(409, 'Conflict')],
  ['is granted', { access: 'write', room: 'material:q:schema:1' }],
  ['fails with a server error', new ApiError(503, 'Service Unavailable')],
  ['gets no answer', new TypeError('Failed to fetch')],
])(
  "rejoins when a fresh token after the service's own not found %s",
  async (_, answer) => {
    const { room } = await started();
    const [provider] = providers;
    provider.config.onSynced?.({ state: true });
    tokens.push(answer);
    provider.config.onAuthenticationFailed?.({
      reason: COLLABORATION_NOT_FOUND_REASON,
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(provider.disconnects).toBe(1);
    expect(provider.connects).toBe(2);
    expect(room.getSnapshot().status).not.toBe('unavailable');
    expect(dropDeviceCopies).not.toHaveBeenCalled();
    room.destroy();
  }
);

// Review 2026-11-20 (3): a deleted quiz's Download reads its questions from
// the device copy, which stays while this device holds edits to the item
// (`dropDeletedCopies`, the device-copy sweep's rule).
it("keeps a deleted item's device copy while this device holds edits to it", async () => {
  const shown = new Y.Doc();
  shown.getMap('questions').set('q1', 'Mitosis');
  drafts.rows = [stateRow(shown, 'material:q:schema:1', 'a')];
  tokens.push(gone());
  const { room } = await started();
  await vi.waitFor(() => expect(room.getSnapshot().recovery).not.toBeNull());
  await vi.waitFor(() => expect(draftMaterials).toHaveBeenCalledWith('u'));
  expect(dropDeviceCopies).not.toHaveBeenCalled();
  room.destroy();
});

it("drops a deleted item's device copy when this device holds no edits to it", async () => {
  tokens.push(gone());
  const { room } = await started();
  await vi.waitFor(() =>
    expect(dropDeviceCopies).toHaveBeenCalledWith('q', undefined)
  );
  room.destroy();
});

// A discard (a trash sends one first): the edits only the recorder held are
// written as it stops, and they keep the copy too.
it("keeps the device copy for the recorder's last edits when a discard ends the room", async () => {
  const { room } = await started();
  const [provider] = providers;
  const [notice, close] = evicted('discard');
  provider.config.onStateless?.(notice);
  provider.config.onClose?.(close);
  await vi.advanceTimersByTimeAsync(0);
  expect(drafts.written).toBe(true);
  expect(draftMaterials).toHaveBeenCalledWith('u');
  expect(dropDeviceCopies).not.toHaveBeenCalled();
  room.destroy();
});

// The collaboration service's "not found" with no token answer behind it is
// also a deleted item's (review 2026-11-20): a fresh token decides, and a
// deleted one ends this room for a fresh one, its edits kept.
it("asks a fresh token after the service's own not found, and a deleted item moves to a fresh room", async () => {
  const { onReplace, room } = await started();
  const [provider] = providers;
  provider.config.onSynced?.({ state: true });
  tokens.push(gone());
  provider.config.onAuthenticationFailed?.({
    reason: COLLABORATION_NOT_FOUND_REASON,
  });
  await vi.waitFor(() => expect(onReplace).toHaveBeenCalled());
  expect(drafts.discarded).toBe(0);
  room.destroy();
});
