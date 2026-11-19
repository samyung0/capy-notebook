import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ApiError } from '@/api/client';
import type { DraftMessage, DraftReply } from '@/lib/draftStore';
import type { RoomProviderConfig } from './roomProvider';

/* A canvas painted from its device copy takes edits before its room joins
 * (Epo 2026-11-19, Q27 b1), under its document's own client id, and the join
 * re-applies them under the id the room assigned (Q31, as a note's:
 * human/frontend/error-handling.md). Driven against the mock board room,
 * which binds ids as the collaboration service does (client_ids.rs), with the
 * drafts store and the late merge's WASM as they run in the browser. */

vi.setConfig({ testTimeout: 30_000 });

vi.mock('@/api/auth', () => ({ USE_MSW: true }));
// The note mock's Plate plugins import CSS.
vi.mock('@/features/notes/plugins', () => ({ MaterialKit: [] }));
vi.mock('@/components/ui/userToast', () => ({ userToast: vi.fn() }));
vi.mock('@/api/queryClient', () => ({
  queryClient: { invalidateQueries: vi.fn() },
}));
vi.mock('@/lib/editIncidents', async (original) => ({
  ...(await original<typeof import('@/lib/editIncidents')>()),
  editIncidentReporter: () => () => {},
}));
vi.mock('@/lib/sourceCache', async (original) => ({
  ...(await original<typeof import('@/lib/sourceCache')>()),
  dropDeviceCopies: vi.fn(async () => {}),
}));
// The room's token, as the canvas mock answers it; `failing` throws instead.
const token = vi.hoisted(() => ({ failing: null as Error | null }));
vi.mock('@/api/hooks', async (original) => {
  const { mockCanvasAccess, mockCanvasToken } = await import('@/mocks/canvas');
  const { ApiError } = await import('@/api/client');
  return {
    ...(await original<typeof import('@/api/hooks')>()),
    getMaterialCollaborationToken: vi.fn(
      async (id: string, asked?: { previousToken?: string }) => {
        if (token.failing) throw token.failing;
        const access = mockCanvasAccess(id);
        if (!access) throw new ApiError(404, 'Not Found');
        return {
          access,
          room: `material:${id}:schema:1`,
          token: mockCanvasToken(id, asked?.previousToken),
          url: 'mock://collaboration',
        };
      }
    ),
  };
});
// Every board provider the room makes, by its config; while `held` is set,
// their connects wait there (a JOIN not answered yet).
const joins = vi.hoisted(() => ({
  configs: [] as RoomProviderConfig[],
  held: null as (() => void)[] | null,
}));
vi.mock('./itemRoom', async (original) => {
  const real = await original<typeof import('./itemRoom')>();
  return {
    ...real,
    registerMockItemProvider: (
      make: Parameters<typeof real.registerMockItemProvider>[0]
    ) =>
      real.registerMockItemProvider((config) => {
        joins.configs.push(config);
        // The provider itself: the room tells its updates by it.
        const provider = make(config);
        const connect = provider.connect.bind(provider);
        provider.connect = () => {
          if (joins.held) joins.held.push(connect);
          else connect();
        };
        return provider;
      }),
  };
});
// The late merge as its worker runs it: the WASM, in this process. Each of
// `fails` fails one merge in turn: its code not loading, or the merge itself.
const merges = vi.hoisted(() => ({
  fails: [] as ('error' | 'unloaded')[],
  runs: 0,
}));
vi.mock('./lateMerge/lateMerge', async (original) => {
  const real = await original<typeof import('./lateMerge/lateMerge')>();
  const { mergeRequest } = await import('./lateMerge/lateMerge.worker');
  return {
    ...real,
    mergeLate: async (
      old: Uint8Array,
      current: () => Uint8Array,
      author?: number
    ) => {
      merges.runs++;
      const fail = merges.fails.shift();
      if (fail === 'unloaded')
        throw new real.LateMergeUnloaded('The late merge worker failed');
      if (fail === 'error') throw new Error('The late merge did not finish');
      const reply = await mergeRequest({
        author,
        current: current().slice().buffer,
        old: old.slice().buffer,
      });
      if ('error' in reply) throw new Error(reply.error);
      return { hidden: reply.hidden, merged: new Uint8Array(reply.merged) };
    },
  };
});

// The drafts worker, run in this process as editDrafts.test.ts runs it.
class InProcessWorker {
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: DraftReply }) => void) | null = null;
  store = import('@/lib/draftStore');
  postMessage(message: DraftMessage) {
    const copy = structuredClone(message);
    void this.store.then(({ handleDraftMessage }) =>
      handleDraftMessage(copy, (answer) =>
        this.onmessage?.({ data: structuredClone(answer) })
      )
    );
  }
  terminate() {}
}
vi.stubGlobal('Worker', InProcessWorker);

// Web Locks, as a browser holds them across its tabs: a recording session's
// rows are left to it (Q420).
const locks = new Map<string, number>();
const lockManager = {
  async query() {
    return { held: [...locks.keys()].map((name) => ({ name })) };
  },
  async request(
    name: string,
    _options: unknown,
    callback: () => Promise<unknown>
  ) {
    locks.set(name, (locks.get(name) ?? 0) + 1);
    try {
      return await callback();
    } finally {
      const left = (locks.get(name) ?? 1) - 1;
      if (left) locks.set(name, left);
      else locks.delete(name);
    }
  },
};

const { ItemRoom } = await import('./itemRoom');
const {
  admitMockBoardDrafts,
  mockBoardPeer,
  mockBoardSocket,
  mockExpireBoardJoin,
  registerMockCollaborationProvider,
} = await import('@/mocks/collaboration');
const { demoteMockCanvas, mockMemberCanvas } = await import('@/mocks/canvas');
const { initSync } = await import('./lateMerge/generated/late_merge.js');
const { userToast } = await import('@/components/ui/userToast');
const { dropDeviceCopies } = await import('@/lib/sourceCache');
const { readDrafts } = await import('@/lib/editDrafts');
const { getMaterialCollaborationToken } = await import('@/api/hooks');
const { tokenClientIds } = await import('./protocol');

beforeAll(() => {
  registerMockCollaborationProvider();
  initSync({
    module: readFileSync(
      new URL('./lateMerge/generated/late_merge_bg.wasm', import.meta.url)
    ),
  });
});
beforeEach(() => {
  vi.stubGlobal('navigator', {
    locks: lockManager,
    onLine: true,
    userAgent: 'node',
  });
  token.failing = null;
  joins.configs.length = 0;
  joins.held = null;
  merges.fails = [];
  merges.runs = 0;
  vi.mocked(userToast).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('Worker', InProcessWorker);
});

/** A canvas in the scenarios workspace (whose rooms keep drafts under the
 * mocks), held by the mock user as an editor. */
const canvas = () =>
  mockMemberCanvas({
    creatorName: 'Ben',
    role: 'editor',
    title: 'Lab diagrams',
    workspaceId: 'ws_scenarios',
  });

const BOARD = { max: 4 * 1024 * 1024 };

/** A room on the canvas, started; `seed`: the device copy it paints from. */
async function open(
  id: string,
  seed?: ReturnType<typeof copyOf>,
  onReplace = vi.fn()
) {
  const room = new ItemRoom(id, {
    awareness: true,
    board: BOARD,
    drafts: { actorId: 'u_mock' },
    onReplace,
    seed,
  });
  await room.start();
  return room;
}

/** Until the room holds the room's state. */
const synced = (room: InstanceType<typeof ItemRoom>) =>
  vi.waitUntil(() => room.getSnapshot().synced, { timeout: 30_000 });

/** The device copy of what `doc` holds, as a member's tab kept it. */
function copyOf(id: string, doc: Y.Doc, canEditContent = true) {
  const state = Y.encodeStateAsUpdate(doc);
  const seeded = new Y.Doc({ gc: true });
  Y.applyUpdate(seeded, state);
  const room = `material:${id}:schema:1`;
  return {
    doc: seeded,
    room,
    row: {
      canEditContent,
      document: 'content' as const,
      format: 2,
      kind: 'canvas' as const,
      materialId: id,
      owner: 'u_mock',
      room,
      size: state.byteLength,
      standalone: false,
      title: 'Lab diagrams',
      version: 1,
    },
    version: 1,
  };
}

/** The canvas's elements in a document, by id. */
function elements(doc: Y.Doc) {
  const surface = doc.getMap<Y.Map<unknown>>('blocks').get('surface');
  const value = (surface?.get('prop:elements') as Y.Map<unknown>)?.get('value');
  if (!(value instanceof Y.Map)) throw new Error('No canvas');
  return value as Y.Map<Y.Map<unknown>>;
}

/** A pen stroke `id`, drawn as the board writes one (a local edit). */
function draw(doc: Y.Doc, id: string, x = 0) {
  const stroke = new Y.Map<unknown>();
  for (const [key, value] of Object.entries({
    color: '#000000',
    id,
    index: 'a0',
    lineWidth: 4,
    points: [
      [0, 0],
      [10, 10],
    ],
    rotate: 0,
    seed: 1,
    type: 'brush',
    xywh: `[${x},0,10,10]`,
  }))
    stroke.set(key, value);
  elements(doc).set(id, stroke);
}

const drawn = (doc: Y.Doc) => [...elements(doc).keys()].sort();

/** The client ids `doc` wrote structs under. */
const writers = (doc: Y.Doc) => [
  ...Y.decodeStateVector(Y.encodeStateVector(doc)).keys(),
];

/** A canvas a first tab drew `a` on and left; its device copy. */
async function drewAndLeft(id: string, clean = true) {
  const first = await open(id);
  await synced(first);
  draw(first.doc, 'a');
  // Stored by the room: the tab's rows went.
  await vi.waitUntil(
    async () => (await readDrafts(`u_mock:material:${id}`)).length === 0
  );
  const copy = copyOf(id, first.doc);
  const left = first.doc.clientID;
  // An unclean end: the socket drops first, so no Leave is sent.
  if (!clean) mockBoardSocket(id, false);
  first.destroy();
  if (!clean) mockBoardSocket(id, true);
  return { copy, left };
}

/** An early board: painted from `copy` while its token cannot be had. */
async function offlineFrom(id: string, copy: ReturnType<typeof copyOf>) {
  token.failing = new TypeError('Failed to fetch');
  const room = await open(id, copy);
  await vi.waitUntil(() => {
    const { early, offline } = room.getSnapshot();
    return early && offline === 'offline';
  });
  return room;
}

/** The connection is back: the room joins. */
async function back(room: InstanceType<typeof ItemRoom>) {
  token.failing = null;
  room.retry();
  await synced(room);
}

// The case b1 broke (review b1 finding 1): the first tab's clean Leave
// expired its id, so only a re-author lands the early stroke.
it('lands an early stroke drawn after a clean leave, re-authored, and the board takes edits after', async () => {
  const id = canvas();
  const { copy, left } = await drewAndLeft(id);
  const room = await offlineFrom(id, copy);
  const own = room.doc.clientID;
  draw(room.doc, 'b', 20);
  await back(room);
  // The board moved onto the room's document, holding both strokes, the
  // early one under the id the room assigned.
  expect(room.doc).not.toBe(copy.doc);
  expect(drawn(room.doc)).toEqual(['a', 'b']);
  expect(writers(room.doc)).not.toContain(own);
  expect(room.doc.clientID).not.toBe(left);
  expect(room.getSnapshot()).toMatchObject({
    access: 'write',
    early: false,
    sending: false,
  });
  const peer = mockBoardPeer(id);
  expect(Object.keys(peer.elements()).sort()).toEqual(['a', 'b']);
  draw(room.doc, 'c', 40);
  expect(Object.keys(peer.elements()).sort()).toEqual(['a', 'b', 'c']);
  // Stored by the room, the early rows and the session's go.
  await vi.waitUntil(() => room.getSnapshot().status === 'saved');
  await vi.waitFor(async () =>
    expect(await readDrafts(`u_mock:material:${id}`)).toEqual([])
  );
  peer.leave();
  room.destroy();
});

// Review b1 finding 10: the removals-only gate holds from the first edit, not
// from an idle measure.
it('sizes an early board from its copy at once, and each early edit adds to it', async () => {
  const id = canvas();
  const { copy } = await drewAndLeft(id);
  const room = await offlineFrom(id, copy);
  expect(room.size()).toEqual({ bytes: copy.row.size, max: BOARD.max });
  draw(room.doc, 'b', 20);
  expect(room.size()?.bytes).toBeGreaterThan(copy.row.size);
  room.destroy();
});

it('lands an early stroke drawn after an unclean leave, whose id the room kept', async () => {
  const id = canvas();
  const { copy } = await drewAndLeft(id, false);
  const room = await offlineFrom(id, copy);
  draw(room.doc, 'b', 20);
  await back(room);
  expect(drawn(room.doc)).toEqual(['a', 'b']);
  const peer = mockBoardPeer(id);
  expect(Object.keys(peer.elements()).sort()).toEqual(['a', 'b']);
  peer.leave();
  room.destroy();
});

// The token answered and the JOIN has not (a slow join, or the 30 s
// unreachable state with the API up): the board writes under the id the
// token offers, which the JOIN binds as any session's (Q236), so nothing is
// re-applied and the board stays on its document.
it("lands an early stroke drawn while the join is slow under the token's id, with no re-apply", async () => {
  const id = canvas();
  const { copy } = await drewAndLeft(id);
  joins.configs.length = 0;
  joins.held = [];
  const room = await open(id, copy);
  // The token answered: its id is the document's, the JOIN not sent.
  await vi.waitUntil(() => joins.held?.length);
  const offered = room.doc.clientID;
  draw(room.doc, 'b', 20);
  const held = joins.held ?? [];
  joins.held = null;
  for (const connect of held) connect();
  await synced(room);
  expect(room.doc).toBe(copy.doc);
  expect(room.doc.clientID).toBe(offered);
  expect(joins.configs).toHaveLength(1);
  const peer = mockBoardPeer(id);
  expect(Object.keys(peer.elements()).sort()).toEqual(['a', 'b']);
  expect(elements(peer.document).get('b')?._item?.id.client).toBe(offered);
  peer.leave();
  room.destroy();
});

// Review b2 finding 6: a JOIN refused for its token's claims (it expired
// while the join waited) joins again presenting that token, which regrants
// its id, so the strokes drawn under it land (Q236).
it("keeps the token's id through a JOIN refused for an expired token, and the early stroke lands under it", async () => {
  const id = canvas();
  const { copy } = await drewAndLeft(id);
  joins.held = [];
  const room = await open(id, copy);
  await vi.waitUntil(() => joins.held?.length);
  const offered = room.doc.clientID;
  draw(room.doc, 'b', 20);
  mockExpireBoardJoin(id);
  const held = joins.held ?? [];
  joins.held = null;
  for (const connect of held) connect();
  await synced(room);
  expect(room.doc).toBe(copy.doc);
  expect(room.doc.clientID).toBe(offered);
  const presented = vi
    .mocked(getMaterialCollaborationToken)
    .mock.calls.flatMap(([, asked]) => asked?.previousToken ?? []);
  expect(presented.map((token) => tokenClientIds(token).clientId)).toContain(
    offered
  );
  const peer = mockBoardPeer(id);
  expect(Object.keys(peer.elements()).sort()).toEqual(['a', 'b']);
  expect(elements(peer.document).get('b')?._item?.id.client).toBe(offered);
  peer.leave();
  room.destroy();
});

// Review b2 finding 5: rows a session wrote under the id its token offered
// (reloaded in the 30 s unreachable state, the API up) are that session's,
// as Q326's are: they paint at the next open, which takes edits, and go
// through the draft send at its join, beside this session's re-applied ones.
it("paints a session's strokes made under its token's id at the next open, and sends them at its join", async () => {
  const id = canvas();
  vi.stubGlobal('fetch', async (url: URL | string, init?: RequestInit) => {
    if (!String(url).endsWith('/drafts')) throw new TypeError('No network');
    admitMockBoardDrafts(id, new Uint8Array(init?.body as Uint8Array));
    return new Response(null, { status: 200 });
  });
  const { copy } = await drewAndLeft(id);
  const second = copyOf(id, copy.doc);
  joins.held = [];
  const first = await open(id, copy);
  await vi.waitUntil(() => joins.held?.length);
  const offered = first.doc.clientID;
  draw(first.doc, 'b', 20);
  await vi.waitUntil(async () =>
    (await readDrafts(`u_mock:material:${id}`)).some((row) => !row.late)
  );
  // Reloaded: its JOIN never went.
  first.destroy();
  joins.held = null;
  const room = await offlineFrom(id, second);
  expect(drawn(room.doc)).toEqual(['a', 'b']);
  draw(room.doc, 'c', 40);
  await back(room);
  expect(drawn(room.doc)).toEqual(['a', 'b', 'c']);
  const peer = mockBoardPeer(id);
  expect(Object.keys(peer.elements()).sort()).toEqual(['a', 'b', 'c']);
  const author = (stroke: string) =>
    elements(peer.document).get(stroke)?._item?.id.client;
  expect(author('b')).toBe(offered);
  expect(author('c')).toBe(room.doc.clientID);
  await vi.waitUntil(() => room.getSnapshot().status === 'saved');
  await vi.waitUntil(
    async () => (await readDrafts(`u_mock:material:${id}`)).length === 0
  );
  peer.leave();
  room.destroy();
});

// Review b1 finding 2: each tab writes under an id of its own.
it('lands what two tabs of one person drew early on one canvas, each under its own id', async () => {
  const id = canvas();
  const { copy } = await drewAndLeft(id);
  const second = copyOf(id, copy.doc);
  const one = await offlineFrom(id, copy);
  draw(one.doc, 'one', 20);
  await vi.waitFor(async () =>
    expect(await readDrafts(`u_mock:material:${id}`)).not.toEqual([])
  );
  // The first tab's stored strokes stay its own.
  const two = await offlineFrom(id, second);
  expect(drawn(two.doc)).toEqual(['a']);
  draw(two.doc, 'two', 40);
  await back(one);
  await back(two);
  expect(one.doc.clientID).not.toBe(two.doc.clientID);
  const peer = mockBoardPeer(id);
  expect(Object.keys(peer.elements()).sort()).toEqual(['a', 'one', 'two']);
  expect(drawn(one.doc)).toEqual(['a', 'one', 'two']);
  expect(drawn(two.doc)).toEqual(['a', 'one', 'two']);
  // Each stroke under its own tab's assigned id.
  const author = (stroke: string) =>
    elements(peer.document).get(stroke)?._item?.id.client;
  expect(author('one')).toBe(one.doc.clientID);
  expect(author('two')).toBe(two.doc.clientID);
  peer.leave();
  one.destroy();
  two.destroy();
});

/** A canvas the peer drew two squares on, `from` and `to`, and its copy. */
async function twoSquares(id: string) {
  const first = await open(id);
  await synced(first);
  const peer = mockBoardPeer(id);
  peer.add('from', { index: 'a0', type: 'shape', xywh: '[0,0,100,100]' });
  peer.add('to', { index: 'a1', type: 'shape', xywh: '[400,0,100,100]' });
  const copy = copyOf(id, first.doc);
  first.destroy();
  return { copy, peer };
}

// Epo 2026-11-19 (Q33): only what the re-apply cannot show goes to copy,
// decided per element; the rest lands and the board takes edits on it.
it('lands a move beside one of a shape a peer deleted, which alone is offered to copy, and Reload shows the board', async () => {
  const id = canvas();
  const { copy, peer } = await twoSquares(id);
  const onReplace = vi.fn();
  token.failing = new TypeError('Failed to fetch');
  const room = await open(id, copy, onReplace);
  await vi.waitUntil(() => room.getSnapshot().early);
  elements(room.doc).get('from')?.set('xywh', '[50,50,100,100]');
  elements(room.doc).get('to')?.set('xywh', '[450,50,100,100]');
  peer.remove('from');
  await back(room);
  // The move of `to` landed, on both.
  expect(peer.elements().to.xywh).toBe('[450,50,100,100]');
  expect(drawn(room.doc)).toEqual(['to']);
  // The move of `from`, alone, waits beside it for copying, stored.
  const { recovery } = room.getSnapshot();
  expect(recovery).toMatchObject({ merged: true, refused: false });
  expect(drawn(recovery?.doc ?? new Y.Doc())).toEqual(['from']);
  expect(
    elements(recovery?.doc ?? new Y.Doc())
      .get('from')
      ?.get('xywh')
  ).toBe('[50,50,100,100]');
  await vi.waitUntil(() => room.getSnapshot().recovery?.rows.length === 1);
  expect(onReplace).not.toHaveBeenCalled();
  expect(userToast).not.toHaveBeenCalled();
  // Reload drops it and shows the room's document, which takes edits.
  await room.reload();
  expect(room.getSnapshot()).toMatchObject({ recovery: null, synced: true });
  draw(room.doc, 'b', 20);
  expect(Object.keys(peer.elements()).sort()).toEqual(['b', 'to']);
  await vi.waitUntil(async () =>
    (await readDrafts(`u_mock:material:${id}`)).every((row) => !row.refused)
  );
  peer.leave();
  room.destroy();
});

// Review b2 finding 1: code that did not load keeps everything as it is and
// is tried again on Retry and on the browser's reconnect (Q295, Q398).
it('keeps the early edits when the merge code does not load, and Retry and the reconnect try again', async () => {
  // The browser's window, for its `online` event.
  const browser = new EventTarget();
  vi.stubGlobal('addEventListener', browser.addEventListener.bind(browser));
  vi.stubGlobal(
    'removeEventListener',
    browser.removeEventListener.bind(browser)
  );
  const id = canvas();
  const { copy } = await drewAndLeft(id);
  const room = await offlineFrom(id, copy);
  draw(room.doc, 'b', 20);
  merges.fails = ['unloaded', 'unloaded'];
  token.failing = null;
  room.retry();
  await vi.waitUntil(() => room.getSnapshot().unloaded);
  // Read-only on its own edits, which stay late for the next try.
  expect(room.getSnapshot()).toMatchObject({ early: true, sending: true });
  expect(drawn(room.doc)).toEqual(['a', 'b']);
  const rows = await readDrafts(`u_mock:material:${id}`);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((row) => row.late && !row.refused)).toBe(true);
  room.retry();
  await vi.waitUntil(() => merges.runs === 2 && room.getSnapshot().unloaded);
  browser.dispatchEvent(new Event('online'));
  await synced(room);
  expect(room.getSnapshot()).toMatchObject({ early: false, unloaded: false });
  const peer = mockBoardPeer(id);
  expect(Object.keys(peer.elements()).sort()).toEqual(['a', 'b']);
  expect(userToast).not.toHaveBeenCalled();
  peer.leave();
  room.destroy();
});

// A merge that ran and failed (Q281) keeps the edits for copying; nothing
// says the room refused them.
it('keeps the early edits for copying when the merge itself fails', async () => {
  const id = canvas();
  const { copy } = await drewAndLeft(id);
  const onReplace = vi.fn();
  token.failing = new TypeError('Failed to fetch');
  const room = await open(id, copy, onReplace);
  await vi.waitUntil(() => room.getSnapshot().early);
  draw(room.doc, 'b', 20);
  merges.fails = ['error'];
  token.failing = null;
  room.retry();
  await vi.waitUntil(() => onReplace.mock.calls.length > 0);
  expect(userToast).not.toHaveBeenCalled();
  room.destroy();
  const next = await open(id);
  const { recovery } = next.getSnapshot();
  expect(recovery?.refused).toBe(true);
  expect(drawn(recovery?.doc ?? new Y.Doc())).toEqual(['a', 'b']);
  await next.reload();
  next.destroy();
});

// Review b2 finding 3: the early rows never come back beside the
// re-authored edit, a room gone before its store landed included.
it('leaves no early row to show again when the room goes right after the re-apply', async () => {
  const id = canvas();
  const { copy } = await drewAndLeft(id);
  const room = await offlineFrom(id, copy);
  draw(room.doc, 'b', 20);
  await vi.waitUntil(
    async () => (await readDrafts(`u_mock:material:${id}`)).length > 0
  );
  const early = new Set(
    (await readDrafts(`u_mock:material:${id}`)).map((row) => row.session)
  );
  token.failing = null;
  room.retry();
  await synced(room);
  // Gone with the re-applied edit's store in flight.
  room.destroy();
  await vi.waitUntil(async () => {
    const rows = await readDrafts(`u_mock:material:${id}`);
    return rows.every((row) => !early.has(row.session));
  });
  const next = await open(id);
  await synced(next);
  expect(next.getSnapshot().recovery).toBeNull();
  expect(drawn(next.doc)).toEqual(['a', 'b']);
  next.destroy();
});

// Epo 2026-11-19 (Q33, "Yes, one side wins"): a field both sides changed, one
// of them before the join, takes Yjs's own pick, with no review step.
it('lands a move of a shape a peer moved meanwhile: one of the two places stands on both, with no recovery', async () => {
  const id = canvas();
  const first = await open(id);
  await synced(first);
  const peer = mockBoardPeer(id);
  peer.add('square', { index: 'a0', type: 'shape', xywh: '[0,0,100,100]' });
  const copy = copyOf(id, first.doc);
  first.destroy();
  const onReplace = vi.fn();
  token.failing = new TypeError('Failed to fetch');
  const room = await open(id, copy, onReplace);
  await vi.waitUntil(() => room.getSnapshot().early);
  elements(room.doc).get('square')?.set('xywh', '[50,50,100,100]');
  peer.change('square', { xywh: '[200,0,100,100]' });
  await back(room);
  const place = elements(room.doc).get('square')?.get('xywh');
  expect(['[50,50,100,100]', '[200,0,100,100]']).toContain(place);
  expect(peer.elements().square.xywh).toBe(place);
  expect(onReplace).not.toHaveBeenCalled();
  expect(room.getSnapshot()).toMatchObject({
    early: false,
    recovery: null,
    sending: false,
  });
  draw(room.doc, 'b', 20);
  expect(Object.keys(peer.elements()).sort()).toEqual(['b', 'square']);
  peer.leave();
  room.destroy();
});

// Review b1 finding 3: a canvas gone or no longer theirs keeps the strokes
// drawn on its copy on the screen, for copying.
it('keeps early strokes visible for copying when the token is refused', async () => {
  const id = canvas();
  const { copy } = await drewAndLeft(id);
  const room = await offlineFrom(id, copy);
  draw(room.doc, 'b', 20);
  token.failing = new ApiError(404, 'Not Found');
  room.retry();
  await vi.waitUntil(() => room.getSnapshot().status === 'unavailable');
  const { recovery } = room.getSnapshot();
  expect(recovery?.refused).toBe(true);
  expect(drawn(recovery?.doc ?? new Y.Doc())).toEqual(['a', 'b']);
  expect(userToast).toHaveBeenCalled();
  room.destroy();
});

it('opens online with no early edit on the copy as it is: no re-author, the copy kept, the JOIN naming its version', async () => {
  const id = canvas();
  const { copy } = await drewAndLeft(id);
  vi.mocked(dropDeviceCopies).mockClear();
  joins.configs.length = 0;
  const room = await open(id, copy);
  await synced(room);
  expect(room.doc).toBe(copy.doc);
  expect(joins.configs).toHaveLength(1);
  expect(joins.configs[0].document).toBe(copy.doc);
  expect(joins.configs[0].storedFrom).toBe(1);
  expect(dropDeviceCopies).not.toHaveBeenCalled();
  // Drawn as it joined: under the token's id, as any edit.
  draw(room.doc, 'b', 20);
  const peer = mockBoardPeer(id);
  expect(Object.keys(peer.elements()).sort()).toEqual(['a', 'b']);
  peer.leave();
  room.destroy();
});

// A reload before the join (review b1 finding 5): the earlier session's
// strokes are the person's own, so they paint with the copy and go with this
// session's at the join, as a note's copy draft does (Q229).
it("paints an earlier session's early strokes with the copy and lands them at the join", async () => {
  const id = canvas();
  const { copy } = await drewAndLeft(id);
  const again = copyOf(id, copy.doc);
  const earlier = await offlineFrom(id, copy);
  draw(earlier.doc, 'b', 20);
  // The tab goes before the join.
  earlier.destroy();
  await vi.waitFor(async () =>
    expect(await readDrafts(`u_mock:material:${id}`)).not.toEqual([])
  );
  const room = await offlineFrom(id, again);
  expect(drawn(room.doc)).toEqual(['a', 'b']);
  draw(room.doc, 'c', 40);
  await back(room);
  const peer = mockBoardPeer(id);
  expect(Object.keys(peer.elements()).sort()).toEqual(['a', 'b', 'c']);
  await vi.waitFor(async () =>
    expect(await readDrafts(`u_mock:material:${id}`)).toEqual([])
  );
  peer.leave();
  room.destroy();
});

// A demotion while away discards unsaved edits as any read-only turn does
// (Epo 2026-09-29), and a viewer's copy takes none.
it("discards an early stroke when the join says read, and a viewer's copy opens with no early edits", async () => {
  const id = canvas();
  const { copy } = await drewAndLeft(id);
  const viewed = copyOf(id, copy.doc, false);
  const onReplace = vi.fn();
  token.failing = new TypeError('Failed to fetch');
  const room = await open(id, copy, onReplace);
  await vi.waitUntil(() => room.getSnapshot().early);
  draw(room.doc, 'b', 20);
  demoteMockCanvas(id);
  token.failing = null;
  room.retry();
  await vi.waitUntil(() => onReplace.mock.calls.length > 0);
  expect(room.getSnapshot().access).toBe('read');
  await vi.waitFor(async () =>
    expect(await readDrafts(`u_mock:material:${id}`)).toEqual([])
  );
  room.destroy();

  token.failing = new TypeError('Failed to fetch');
  const viewer = await open(id, viewed);
  await vi.waitUntil(() => viewer.getSnapshot().status === 'offline');
  expect(viewer.getSnapshot()).toMatchObject({ early: false, offline: null });
  viewer.destroy();
});
