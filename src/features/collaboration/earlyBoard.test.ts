import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ApiError } from '@/api/client';
import type { DraftMessage, DraftReply } from '@/lib/draftStore';
import type { RoomProviderConfig } from './roomProvider';

/* A canvas painted from its device copy takes edits before its room joins
 * (Epo 2026-11-19, Q27 b1), under its document's own client id, and the join
 * renames them in place to the id the room assigned (Q38), in the document the
 * board shows. Driven against the mock board room, which binds ids as the
 * collaboration service does (client_ids.rs), with the drafts store as it runs
 * in the browser. */

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
// The room's token, as the canvas mock answers it; `failing` throws instead,
// `offers` makes it offer that client id, and while `hold` is set it waits.
const token = vi.hoisted(() => ({
  failing: null as Error | null,
  hold: null as Promise<void> | null,
  offers: null as number | null,
}));
vi.mock('@/api/hooks', async (original) => {
  const { mockCanvasAccess, mockCanvasToken } = await import('@/mocks/canvas');
  const { ApiError } = await import('@/api/client');
  return {
    ...(await original<typeof import('@/api/hooks')>()),
    getMaterialCollaborationToken: vi.fn(
      async (id: string, asked?: { previousToken?: string }) => {
        await token.hold;
        if (token.failing) throw token.failing;
        const access = mockCanvasAccess(id);
        if (!access) throw new ApiError(404, 'Not Found');
        const claims = { clientId: token.offers, iat: 0, materialId: id };
        return {
          access,
          room: `material:${id}:schema:1`,
          token: token.offers
            ? `mock.${btoa(JSON.stringify(claims))}.sig`
            : mockCanvasToken(id, asked?.previousToken),
          url: 'mock://collaboration',
        };
      }
    ),
  };
});
// Every board provider the room makes, by its config, and what each sent as
// stateless messages; while `held` is set, their connects wait there (a JOIN
// not answered yet).
const joins = vi.hoisted(() => ({
  configs: [] as RoomProviderConfig[],
  held: null as (() => void)[] | null,
  providers: [] as { config: RoomProviderConfig; stateless: string[] }[],
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
        const sent = { config, stateless: [] as string[] };
        joins.providers.push(sent);
        const sendStateless = provider.sendStateless.bind(provider);
        provider.sendStateless = (payload) => {
          sent.stateless.push(payload);
          sendStateless(payload);
        };
        return provider;
      }),
  };
});
// The late merge as its worker runs it: the WASM, in this process. Every
// run is counted: the common path loads none. While `hold` is set, a merge
// waits for it; then, for the next `unloaded` tries, its code does not load
// (offline, nothing cached).
const merges = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  runs: 0,
  tried: 0,
  unloaded: 0,
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
      merges.tried++;
      await merges.hold;
      if (merges.unloaded > 0) {
        merges.unloaded--;
        throw new real.LateMergeUnloaded('The late merge worker failed');
      }
      merges.runs++;
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

// While `fails` is set, the requests it names fail as on a full disk.
const storage = vi.hoisted(() => ({
  failed: 0,
  fails: null as ((message: DraftMessage) => boolean) | null,
}));

// The drafts worker, run in this process as editDrafts.test.ts runs it.
class InProcessWorker {
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: DraftReply }) => void) | null = null;
  store = import('@/lib/draftStore');
  postMessage(message: DraftMessage) {
    const copy = structuredClone(message);
    const { id } = copy;
    if (id !== undefined && storage.fails?.(copy)) {
      storage.failed++;
      const error = { message: 'The disk is full', name: 'QuotaExceededError' };
      void this.store.then(() => this.onmessage?.({ data: { error, id } }));
      return;
    }
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
// rows are left to it (Q420), and an early board's taken rows too (each one
// it took is in `claims`).
const locks = new Map<string, number>();
const claims: string[] = [];
const lockManager = {
  async query() {
    return { held: [...locks.keys()].map((name) => ({ name })) };
  },
  async request(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: { name: string } | null) => Promise<unknown>
  ) {
    if (options.ifAvailable && locks.has(name)) return callback(null);
    if (options.ifAvailable) claims.push(name);
    locks.set(name, (locks.get(name) ?? 0) + 1);
    try {
      return await callback({ name });
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
  mockBoardAtCap,
  mockBoardPeer,
  mockBoardSocket,
  mockBoardStoreFails,
  mockExpireBoardJoin,
  registerMockCollaborationProvider,
} = await import('@/mocks/collaboration');
const { demoteMockCanvas, mockMemberCanvas, unshareMockCanvas } = await import(
  '@/mocks/canvas'
);
const { initSync } = await import('./lateMerge/generated/late_merge.js');
const { userToast } = await import('@/components/ui/userToast');
const { dropDeviceCopies } = await import('@/lib/sourceCache');
const { readDrafts } = await import('@/lib/editDrafts');
const { getMaterialCollaborationToken } = await import('@/api/hooks');
const { tokenClientIds } = await import('./protocol');
const { onRenamed } = await import('./renameClient');

beforeAll(() => {
  registerMockCollaborationProvider();
  // Node cannot fetch the packaged wasm URL; the glue takes the bytes.
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
  token.hold = null;
  token.offers = null;
  joins.configs.length = 0;
  joins.held = null;
  joins.providers.length = 0;
  merges.runs = 0;
  merges.hold = null;
  merges.tried = 0;
  merges.unloaded = 0;
  storage.failed = 0;
  storage.fails = null;
  vi.mocked(userToast).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
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

/** A room on the canvas, not started; `seed`: the device copy it paints
 * from. */
const made = (
  id: string,
  seed?: ReturnType<typeof copyOf>,
  onReplace = vi.fn()
) =>
  new ItemRoom(id, {
    awareness: true,
    board: BOARD,
    drafts: { actorId: 'u_mock', kind: 'canvas' },
    onReplace,
    seed,
  });

/** A room on the canvas, started (`made`). */
async function open(
  id: string,
  seed?: ReturnType<typeof copyOf>,
  onReplace = vi.fn()
) {
  const room = made(id, seed, onReplace);
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

/** The stored rows once the writes a room still had in hand are through:
 * the first read's answer comes after the replies those writes wait on, so
 * the second goes after them. */
async function settledDrafts(key: string) {
  await readDrafts(key);
  return readDrafts(key);
}

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
// expired its id, so the early stroke lands only under a new one (Q38).
it('lands an early stroke drawn after a clean leave, renamed in the same document, and the board takes edits after', async () => {
  const id = canvas();
  const { copy, left } = await drewAndLeft(id);
  joins.configs.length = 0;
  const room = await offlineFrom(id, copy);
  const own = room.doc.clientID;
  draw(room.doc, 'b', 20);
  await back(room);
  // The same document, holding both strokes, the early one under the id the
  // room assigned: one provider joined, on it.
  expect(room.doc).toBe(copy.doc);
  expect(joins.configs.map((config) => config.document)).toEqual([copy.doc]);
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
  expect(elements(peer.document).get('b')?._item?.id.client).toBe(
    room.doc.clientID
  );
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
// renamed and the board stays on its document.
it("lands an early stroke drawn while the join is slow under the token's id, with no rename", async () => {
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
// through the draft send at its join, beside this session's renamed ones.
// The rename waits for that send, which would take the renamed rows too, and
// asks it to try again at once: here its first try, a while in flight, fails.
it("paints a session's strokes made under its token's id at the next open, and sends them at its join", async () => {
  const id = canvas();
  // The client ids each `/drafts` body wrote under.
  const sent: number[][] = [];
  vi.stubGlobal('fetch', async (url: URL | string, init?: RequestInit) => {
    if (!String(url).endsWith('/drafts')) throw new TypeError('No network');
    const body = new Uint8Array(init?.body as Uint8Array);
    sent.push(
      [
        ...new Set(Y.decodeUpdate(body).structs.map(({ id }) => id.client)),
      ].sort()
    );
    if (sent.length === 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return new Response(null, { status: 503 });
    }
    await admitMockBoardDrafts(id, body);
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
  const painted = writers(first.doc).sort();
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
  // The send went twice, holding the painted session's document alone.
  expect(sent).toEqual([painted, painted]);
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

// Epo 2026-11-19 (Q33): only what the room's state hides goes to copy,
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
  // Discard drops it and shows the room's document, which takes edits.
  await room.reload();
  expect(room.getSnapshot()).toMatchObject({ recovery: null, synced: true });
  expect(room.doc).toBe(copy.doc);
  draw(room.doc, 'b', 20);
  expect(Object.keys(peer.elements()).sort()).toEqual(['b', 'to']);
  await vi.waitUntil(async () =>
    (await readDrafts(`u_mock:material:${id}`)).every((row) => !row.refused)
  );
  peer.leave();
  room.destroy();
});

// Review b2 re-check N2: the same edits under two ids would go in twice, so
// the early rows are flagged copy-only before the rename. When the part the
// room's state hid could not be stored they stay, and the next open offers
// them to copy, applying none.
it('offers the early edits to copy at the next open, applying none, when the part the room hid could not be stored', async () => {
  const id = canvas();
  const { copy, peer } = await twoSquares(id);
  const later = copyOf(id, copy.doc);
  token.failing = new TypeError('Failed to fetch');
  const room = await open(id, copy);
  await vi.waitUntil(() => room.getSnapshot().early);
  elements(room.doc).get('from')?.set('xywh', '[50,50,100,100]');
  elements(room.doc).get('to')?.set('xywh', '[450,50,100,100]');
  peer.remove('from');
  storage.fails = (message) =>
    message.op === 'put' && message.rows.some((row) => row.hidden);
  await back(room);
  expect(peer.elements().to.xywh).toBe('[450,50,100,100]');
  await vi.waitUntil(() => storage.failed > 0);
  room.destroy();
  storage.fails = null;
  // Painted from its copy and online: its join would rename late rows.
  const next = await open(id, later);
  await vi.waitUntil(() => next.getSnapshot().recovery !== null);
  const { recovery } = next.getSnapshot();
  expect(recovery?.refused).toBe(true);
  expect(next.getSnapshot().early).toBe(false);
  expect(
    elements(recovery?.doc ?? new Y.Doc())
      .get('from')
      ?.get('xywh')
  ).toBe('[50,50,100,100]');
  expect(Object.keys(peer.elements())).toEqual(['to']);
  expect(peer.elements().to.xywh).toBe('[450,50,100,100]');
  await next.reload();
  next.destroy();
  peer.leave();
});

// When they cannot be flagged nothing is renamed and nothing sent: the board
// waits read-only under Retry, which, as the browser's reconnect does, tries
// again (Q295, Q398).
it('holds the early edits read-only when they cannot be flagged, and Retry and the reconnect try again', async () => {
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
  const own = room.doc.clientID;
  draw(room.doc, 'b', 20);
  storage.fails = (message) => message.op === 'mark';
  // Any connect waits here: none comes.
  joins.held = [];
  token.failing = null;
  room.retry();
  await vi.waitUntil(() => room.getSnapshot().unloaded);
  expect(room.getSnapshot()).toMatchObject({
    early: true,
    offline: null,
    sending: true,
  });
  expect(room.doc.clientID).toBe(own);
  // Its rows stay late for the next try.
  const key = `u_mock:material:${id}`;
  const rows = await readDrafts(key);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((row) => row.late && !row.refused)).toBe(true);
  const failed = storage.failed;
  room.retry();
  await vi.waitUntil(() => storage.failed > failed);
  // The failed flag is answered before a read sent after it.
  await readDrafts(key);
  expect(room.getSnapshot().unloaded).toBe(true);
  expect(joins.held).toEqual([]);
  joins.held = null;
  storage.fails = null;
  browser.dispatchEvent(new Event('online'));
  await synced(room);
  expect(room.getSnapshot()).toMatchObject({
    early: false,
    sending: false,
    unloaded: false,
  });
  expect(room.doc).toBe(copy.doc);
  expect(room.doc.clientID).not.toBe(own);
  const peer = mockBoardPeer(id);
  expect(Object.keys(peer.elements()).sort()).toEqual(['a', 'b']);
  expect(userToast).not.toHaveBeenCalled();
  peer.leave();
  room.destroy();
});

// Review b2 re-check N1: the early rows go only once a write holding their
// edits landed (or the room stored them). Here the room refuses the renamed
// edit while storage fails, so its refused row never lands.
it('keeps the early rows when the room refuses the renamed edit and its refused row could not be stored', async () => {
  const id = canvas();
  const { copy } = await drewAndLeft(id);
  const onReplace = vi.fn();
  token.failing = new TypeError('Failed to fetch');
  const room = await open(id, copy, onReplace);
  await vi.waitUntil(() => room.getSnapshot().early);
  draw(room.doc, 'b', 20);
  const key = `u_mock:material:${id}`;
  await vi.waitUntil(async () => (await readDrafts(key)).length > 0);
  const early = new Set((await readDrafts(key)).map((row) => row.session));
  mockBoardAtCap(id, true);
  storage.fails = (message) => message.op === 'put';
  token.failing = null;
  room.retry();
  await vi.waitUntil(() => onReplace.mock.calls.length > 0);
  await vi.waitUntil(() => storage.failed > 0);
  room.destroy();
  mockBoardAtCap(id, false);
  storage.fails = null;
  const rows = await settledDrafts(key);
  expect(rows.some((row) => early.has(row.session))).toBe(true);
  const next = await open(id);
  const { recovery } = next.getSnapshot();
  expect(recovery?.refused).toBe(true);
  expect(drawn(recovery?.doc ?? new Y.Doc())).toEqual(['a', 'b']);
  await next.reload();
  next.destroy();
});

// N1 again: a tab that goes before the room stored the renamed edit, while
// storage fails, keeps the early rows.
it('keeps the early rows when the tab goes before anything holding the renamed edit was stored', async () => {
  const id = canvas();
  const { copy } = await drewAndLeft(id);
  const room = await offlineFrom(id, copy);
  draw(room.doc, 'b', 20);
  const key = `u_mock:material:${id}`;
  await vi.waitUntil(async () => (await readDrafts(key)).length > 0);
  const early = new Set((await readDrafts(key)).map((row) => row.session));
  storage.fails = (message) => message.op === 'put';
  joins.held = [];
  token.failing = null;
  room.retry();
  await vi.waitUntil(() => joins.held?.length);
  // The room answers no receipt.
  mockBoardStoreFails(id, true);
  const held = joins.held ?? [];
  joins.held = null;
  for (const connect of held) connect();
  await synced(room);
  const peer = mockBoardPeer(id);
  expect(peer.elements()).toHaveProperty('b');
  peer.leave();
  await vi.waitUntil(() => storage.failed > 0);
  room.destroy();
  storage.fails = null;
  const rows = await settledDrafts(key);
  expect(rows.some((row) => early.has(row.session))).toBe(true);
});

// A rename that would not be sound (here the token offers an id the copy
// holds already) renames nothing: every early edit is kept for copying, and
// nothing says the room refused them.
it('keeps the early edits for copying when the rename would not be sound', async () => {
  const id = canvas();
  const { copy, left } = await drewAndLeft(id);
  const onReplace = vi.fn();
  token.failing = new TypeError('Failed to fetch');
  const room = await open(id, copy, onReplace);
  await vi.waitUntil(() => room.getSnapshot().early);
  draw(room.doc, 'b', 20);
  const own = room.doc.clientID;
  token.offers = left;
  // Any connect waits here: none comes.
  joins.held = [];
  token.failing = null;
  room.retry();
  await vi.waitUntil(() => onReplace.mock.calls.length > 0);
  expect(room.doc.clientID).toBe(own);
  expect(joins.held).toEqual([]);
  expect(userToast).not.toHaveBeenCalled();
  room.destroy();
  joins.held = null;
  token.offers = null;
  const next = await open(id);
  const { recovery } = next.getSnapshot();
  expect(recovery?.refused).toBe(true);
  expect(drawn(recovery?.doc ?? new Y.Doc())).toEqual(['a', 'b']);
  // The room never had them.
  await next.reload();
  next.destroy();
  const after = await open(id);
  await synced(after);
  expect(drawn(after.doc)).toEqual(['a']);
  after.destroy();
});

// The room's history holding an id the early edits are under (here an
// earlier tab's, as if they had left it) renames nothing either: nothing
// under a temporary id may have left the tab.
it("keeps the early edits for copying when an id they are under is in the room's history", async () => {
  const id = canvas();
  const { copy } = await drewAndLeft(id);
  const before = await offlineFrom(id, copy);
  draw(before.doc, 'b', 20);
  const key = `u_mock:material:${id}`;
  await vi.waitUntil(async () => (await readDrafts(key)).length > 0);
  // Its copy, as the room would have confirmed it.
  const seen = copyOf(id, before.doc);
  before.destroy();
  const onReplace = vi.fn();
  token.failing = new TypeError('Failed to fetch');
  const room = await open(id, seen, onReplace);
  await vi.waitUntil(() => room.getSnapshot().early);
  draw(room.doc, 'c', 40);
  const own = room.doc.clientID;
  joins.held = [];
  token.failing = null;
  room.retry();
  await vi.waitUntil(() => onReplace.mock.calls.length > 0);
  expect(room.doc.clientID).toBe(own);
  expect(joins.held).toEqual([]);
  room.destroy();
  joins.held = null;
  const next = await open(id);
  expect(next.getSnapshot().recovery?.refused).toBe(true);
  expect(drawn(next.getSnapshot().recovery?.doc ?? new Y.Doc())).toEqual([
    'a',
    'b',
    'c',
  ]);
  await next.reload();
  next.destroy();
});

// Review b2 finding 3: the early rows never come back beside the
// renamed edit, a room gone before its store landed included.
it('leaves no early row to show again when the room goes right after the rename', async () => {
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
  // Gone with the renamed edit's store in flight.
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

it('opens online with no early edit on the copy as it is: no rename, the copy kept, the JOIN naming its version', async () => {
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
// session's at the join, as a note's copy draft does (Q229): both temporary
// ids become the room's, this session's after the earlier one's (Q38).
it("paints an earlier session's early strokes with the copy and lands them at the join", async () => {
  const id = canvas();
  const { copy } = await drewAndLeft(id);
  const again = copyOf(id, copy.doc);
  const earlier = await offlineFrom(id, copy);
  const first = earlier.doc.clientID;
  draw(earlier.doc, 'b', 20);
  // The tab goes before the join.
  earlier.destroy();
  await vi.waitFor(async () =>
    expect(await readDrafts(`u_mock:material:${id}`)).not.toEqual([])
  );
  const room = await offlineFrom(id, again);
  expect(drawn(room.doc)).toEqual(['a', 'b']);
  const second = room.doc.clientID;
  draw(room.doc, 'c', 40);
  const end = Y.getState(room.doc.store, first);
  await back(room);
  expect(room.doc).toBe(again.doc);
  expect(writers(room.doc)).not.toContain(first);
  expect(writers(room.doc)).not.toContain(second);
  const peer = mockBoardPeer(id);
  expect(Object.keys(peer.elements()).sort()).toEqual(['a', 'b', 'c']);
  const at = (stroke: string) => elements(peer.document).get(stroke)?._item?.id;
  expect(at('b')?.client).toBe(room.doc.clientID);
  expect(at('c')?.client).toBe(room.doc.clientID);
  expect(at('c')?.clock).toBeGreaterThanOrEqual(end);
  // A chain of sessions loads no merge.
  expect(merges.runs).toBe(0);
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

/** The stored rows of the canvas. */
const rowsOf = (id: string) => readDrafts(`u_mock:material:${id}`);

/** The page's title, a text two tabs type at its start. */
const title = (doc: Y.Doc) =>
  doc.getMap<Y.Map<unknown>>('blocks').get('page')?.get('prop:title') as Y.Text;

/** Two tabs, `first` then `other`, drew on a canvas's copy early side by
 * side (both moved `a`, drew a stroke, typed in the title) and left before
 * their joins; a third copy of the board, under 9999, and `open`, which opens
 * it (`opened`: as `offlineFrom` does, or as `open` when the board cannot
 * show early). Sessions sort by their uuid, as the rows do. */
async function sideBySide(first: number, other: number) {
  const uuid = crypto.randomUUID.bind(crypto);
  let order = 0;
  const sessions = vi
    .spyOn(crypto, 'randomUUID')
    .mockImplementation(
      () => `${order}${uuid().slice(1)}` as ReturnType<typeof uuid>
    );
  const id = canvas();
  const { copy } = await drewAndLeft(id);
  const [second, third] = [copyOf(id, copy.doc), copyOf(id, copy.doc)];
  copy.doc.clientID = first;
  second.doc.clientID = other;
  third.doc.clientID = 9999;
  order = 1;
  const one = await offlineFrom(id, copy);
  elements(one.doc).get('a')?.set('xywh', '[1,1,10,10]');
  draw(one.doc, 'one', 20);
  title(one.doc).insert(0, 'One');
  order = 2;
  const two = await offlineFrom(id, second);
  elements(two.doc).get('a')?.set('xywh', '[2,2,10,10]');
  draw(two.doc, 'two', 40);
  title(two.doc).insert(0, 'Two');
  await vi.waitUntil(
    async () => new Set((await rowsOf(id)).map((row) => row.session)).size === 2
  );
  one.destroy();
  two.destroy();
  order = 3;
  /** The next open: early and offline, offline (`failing`: no wait), or
   * started with the token as it is (`starting`: no wait). */
  const opened = async (how: 'early' | 'failing' | 'starting') => {
    let room: InstanceType<typeof ItemRoom>;
    if (how === 'early') room = await offlineFrom(id, third);
    else if (how === 'failing') {
      token.failing = new TypeError('Failed to fetch');
      room = await open(id, third);
    } else {
      room = made(id, third);
      void room.start();
    }
    sessions.mockRestore();
    return room;
  };
  return { id, opened };
}

// Review M2: two tabs drew early at once and both went before their joins,
// so their edits sit side by side, placed by Yjs comparing their ids. The
// next open writes the second tab's anew under its own id (the late merge),
// a key whose value it holds after the key's value in the rest
// (`followHeads`), so every early edit comes after everything else, and the
// room settles what the board shows. Both id orders: the tab written anew
// holds the value Yjs picked (2000, 3000), or lost it (3000, 2000, review
// re-check R1), and the box keeps that value. Ones the rename alone would
// split.
for (const [first, other] of [
  [2000, 3000],
  [3000, 2000],
])
  it(`lands what two tabs drew early side by side and left before their joins, the board and the room alike (ids ${first}, ${other})`, async () => {
    const { id, opened } = await sideBySide(first, other);
    const room = await opened('early');
    expect(drawn(room.doc)).toEqual(['a', 'one', 'two']);
    const shown = elements(room.doc).get('a')?.get('xywh');
    // Yjs's pick of the two moves: the higher id's.
    expect(shown).toBe(other > first ? '[2,2,10,10]' : '[1,1,10,10]');
    const typed = title(room.doc).toString();
    expect(typed.length).toBe(6);
    token.offers = 2500;
    await back(room);
    const peer = mockBoardPeer(id);
    expect(peer.elements().a.xywh).toBe(shown);
    expect(elements(room.doc).get('a')?.get('xywh')).toBe(shown);
    expect(title(peer.document).toString()).toBe(typed);
    expect(title(room.doc).toString()).toBe(typed);
    expect(peer.document.getMap('blocks').toJSON()).toEqual(
      room.doc.getMap('blocks').toJSON()
    );
    expect(writers(room.doc)).not.toContain(first);
    expect(writers(room.doc)).not.toContain(other);
    expect(merges.runs).toBe(1);
    // Nothing is offered to copy, and every row goes once the room stored it.
    expect(room.getSnapshot().recovery).toBeNull();
    await vi.waitUntil(() => room.getSnapshot().status === 'saved');
    await vi.waitFor(async () => expect(await rowsOf(id)).toEqual([]));
    peer.leave();
    room.destroy();
  });

// Review re-check R2: offline with nothing cached the merge's code does not
// load. The board stays on the copy, read-only, under "Couldn't sync your
// edits"; Retry and the reconnect try again, and the join waits for it. Once
// it loads, the same document fills in place and joins as above.
it("keeps two tabs' early edits waiting under the strip while the merge cannot load, then fills the same board in place", async () => {
  const browser = new EventTarget();
  vi.stubGlobal('addEventListener', browser.addEventListener.bind(browser));
  vi.stubGlobal(
    'removeEventListener',
    browser.removeEventListener.bind(browser)
  );
  merges.unloaded = Number.POSITIVE_INFINITY;
  const { id, opened } = await sideBySide(2000, 3000);
  // The page, for its `visibilitychange`, from here.
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('document', page);
  const room = await opened('failing');
  await vi.waitUntil(() => room.getSnapshot().unloaded);
  const board = room.doc;
  expect(drawn(board)).toEqual(['a']);
  expect(room.getSnapshot()).toMatchObject({
    early: false,
    offline: null,
    recovery: null,
  });
  // Retry tries again; still not loaded.
  let tried = merges.tried;
  room.retry();
  await vi.waitUntil(() => merges.tried > tried);
  expect(room.getSnapshot().unloaded).toBe(true);
  // Shown again, its token answers: the merge is tried before the join,
  // which waits for it.
  const providers = joins.providers.length;
  token.failing = null;
  tried = merges.tried;
  page.dispatchEvent(new Event('visibilitychange'));
  await vi.waitUntil(() => merges.tried > tried);
  expect(joins.providers.length).toBe(providers);
  expect(room.getSnapshot().unloaded).toBe(true);
  // Back: the reconnect loads it.
  merges.unloaded = 0;
  browser.dispatchEvent(new Event('online'));
  await synced(room);
  expect(room.doc).toBe(board);
  expect(room.getSnapshot()).toMatchObject({ recovery: null, unloaded: false });
  expect(drawn(board)).toEqual(['a', 'one', 'two']);
  expect(merges.runs).toBe(1);
  const peer = mockBoardPeer(id);
  expect(peer.document.getMap('blocks').toJSON()).toEqual(
    board.getMap('blocks').toJSON()
  );
  expect(userToast).not.toHaveBeenCalled();
  peer.leave();
  room.destroy();
});

// Review re-check 2, m5: the token says read while the merge waits for its
// code. The strip goes, the board joins read-only, and a join that never
// answers says so 30 s on.
it('clears the merge strip and watches the join again when the token says read during the wait', async () => {
  merges.unloaded = Number.POSITIVE_INFINITY;
  const { id, opened } = await sideBySide(2000, 3000);
  let answer = () => {};
  token.failing = null;
  token.hold = new Promise((resolve) => {
    answer = resolve;
  });
  joins.held = [];
  const room = await opened('starting');
  await vi.waitUntil(() => room.getSnapshot().unloaded);
  demoteMockCanvas(id);
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ['setTimeout', 'clearTimeout'],
  });
  answer();
  await vi.waitUntil(() => room.getSnapshot().access === 'read');
  expect(room.getSnapshot().unloaded).toBe(false);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(room.getSnapshot().unreachable).toBe(true);
  room.destroy();
});

/** Starts the next open (`sideBySide`) with the merge's first try held
 * until the token settled, then failing to load once. */
async function settledWhileMerging(
  opened: Awaited<ReturnType<typeof sideBySide>>['opened']
) {
  merges.unloaded = 1;
  let release = () => {};
  merges.hold = new Promise((resolve) => {
    release = resolve;
  });
  const answers = vi.mocked(getMaterialCollaborationToken).mock.results;
  const asked = answers.length;
  const room = await opened('starting');
  await vi.waitUntil(() => merges.tried > 0 && answers.length > asked);
  await Promise.allSettled([answers.at(-1)?.value]);
  // The room takes the answer first.
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  return room;
}

// Review re-check 2, nit: a token that answers while the merge's first try
// runs is kept for it, so the merge, failing to load, tries again at once and
// the join goes without Retry.
it('tries the merge again at once when its token answered while the first try ran', async () => {
  const { id, opened } = await sideBySide(2000, 3000);
  token.failing = null;
  const room = await settledWhileMerging(opened);
  await vi.waitUntil(() => merges.runs > 0 || room.getSnapshot().unloaded);
  expect(room.getSnapshot().unloaded).toBe(false);
  await synced(room);
  expect(merges).toMatchObject({ runs: 1, tried: 2 });
  expect(drawn(room.doc)).toEqual(['a', 'one', 'two']);
  const peer = mockBoardPeer(id);
  expect(peer.document.getMap('blocks').toJSON()).toEqual(
    room.doc.getMap('blocks').toJSON()
  );
  peer.leave();
  room.destroy();
});

// So is a refusal, whether it comes while the merge's first try runs or
// while it waits for its code (it gives up at once), or after a merge that
// failed once loaded: with no join to offer them, the rows the board did not
// paint show for copying, the copy and both tabs' strokes, under the
// copy-only strip and a toast (re-check 3 m6).
for (const arrives of [
  'while the first try runs',
  'while the merge waits for its code',
  'after the merge failed',
])
  it(`shows the early rows it did not paint for copying when the token is refused ${arrives}`, async () => {
    const { id, opened } = await sideBySide(2000, 3000);
    let room: InstanceType<typeof ItemRoom>;
    if (arrives === 'while the first try runs') {
      token.failing = new ApiError(404, 'Not Found');
      room = await settledWhileMerging(opened);
    } else if (arrives === 'after the merge failed') {
      const failed = Promise.reject(new Error('The merge failed'));
      failed.catch(() => {});
      merges.hold = failed;
      room = await opened('failing');
      await vi.waitUntil(() => merges.tried > 0);
      token.failing = new ApiError(404, 'Not Found');
      room.retry();
    } else {
      merges.unloaded = Number.POSITIVE_INFINITY;
      let answer = () => {};
      token.hold = new Promise((resolve) => {
        answer = resolve;
      });
      room = await opened('starting');
      await vi.waitUntil(() => room.getSnapshot().unloaded);
      token.failing = new ApiError(404, 'Not Found');
      answer();
    }
    await vi.waitUntil(() => room.getSnapshot().status === 'unavailable');
    const { recovery, unloaded } = room.getSnapshot();
    expect(unloaded).toBe(false);
    expect(recovery?.refused).toBe(true);
    expect(drawn(recovery?.doc ?? new Y.Doc())).toEqual(['a', 'one', 'two']);
    // Offered once.
    expect(userToast).toHaveBeenCalledOnce();
    expect(userToast).toHaveBeenCalledWith(
      expect.objectContaining({ id: `item-refused-${id}` })
    );
    expect(merges).toMatchObject({ runs: 0, tried: 1 });
    // Stored as they were, until Discard, their sessions this tab's while
    // they show.
    const rows = await settledDrafts(`u_mock:material:${id}`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.late && !row.refused)).toBe(true);
    const held = [...new Set(rows.map((row) => row.session))].map(
      (session) => `capy-draft-session:${session}`
    );
    expect(held.every((lock) => locks.has(lock))).toBe(true);
    room.destroy();
    await vi.waitUntil(() => !held.some((lock) => locks.has(lock)));
  });

// Rows a session left under its token's id paint with the copy (Q326); a
// refusal before the join keeps them for copying though nothing was drawn
// here (re-check 3).
it('keeps the rows an early board painted for copying when the token is refused, though nothing was drawn on it', async () => {
  const id = canvas();
  const { copy } = await drewAndLeft(id);
  const second = copyOf(id, copy.doc);
  joins.held = [];
  const first = await open(id, copy);
  await vi.waitUntil(() => joins.held?.length);
  draw(first.doc, 'b', 20);
  await vi.waitUntil(async () =>
    (await readDrafts(`u_mock:material:${id}`)).some((row) => !row.late)
  );
  first.destroy();
  joins.held = null;
  const room = await offlineFrom(id, second);
  expect(drawn(room.doc)).toEqual(['a', 'b']);
  token.failing = new ApiError(404, 'Not Found');
  room.retry();
  await vi.waitUntil(() => room.getSnapshot().status === 'unavailable');
  const { recovery } = room.getSnapshot();
  expect(recovery?.refused).toBe(true);
  expect(drawn(recovery?.doc ?? new Y.Doc())).toEqual(['a', 'b']);
  room.destroy();
});

// A group left to copy (a refused board's row) keeps an early board from
// painting; a refusal at that open shows it, as the join would (re-check 3).
it('shows a group left to copy when the token is refused at the next open', async () => {
  const id = canvas();
  const { copy } = await drewAndLeft(id);
  const second = copyOf(id, copy.doc);
  const one = await offlineFrom(id, copy);
  draw(one.doc, 'b', 20);
  token.failing = new ApiError(404, 'Not Found');
  one.retry();
  await vi.waitUntil(async () =>
    (await readDrafts(`u_mock:material:${id}`)).some((row) => row.refused)
  );
  one.destroy();
  const room = await open(id, second);
  await vi.waitUntil(() => room.getSnapshot().status === 'unavailable');
  const { recovery } = room.getSnapshot();
  expect(recovery?.refused).toBe(true);
  expect(drawn(recovery?.doc ?? new Y.Doc())).toEqual(['a', 'b']);
  room.destroy();
});

// Review re-check 4, m7: a room that is not early (no copy on this device)
// refused before its first sync keeps the rows `restore` applied for copying:
// the refusal drops any copy, so no later open could show them.
it('keeps the restored rows for copying when the join is refused before the first sync', async () => {
  const id = canvas();
  const key = `u_mock:material:${id}`;
  const first = await open(id);
  await synced(first);
  // The room stored a stroke (the session accepted), then the socket dropped
  // as the next was drawn: its rows stay, for the next open to apply.
  draw(first.doc, 'a');
  await vi.waitUntil(async () => (await readDrafts(key)).length === 0);
  mockBoardSocket(id, false);
  draw(first.doc, 'b', 20);
  await vi.waitUntil(async () =>
    (await readDrafts(key)).some((row) => row.accepted)
  );
  first.destroy();
  mockBoardSocket(id, true);
  joins.held = [];
  const room = await open(id);
  await vi.waitUntil(() => joins.held?.length);
  expect(drawn(room.doc)).toEqual(['a', 'b']);
  unshareMockCanvas(id);
  const held = joins.held ?? [];
  joins.held = null;
  for (const connect of held) connect();
  await vi.waitUntil(() => room.getSnapshot().status === 'unavailable');
  const { recovery } = room.getSnapshot();
  expect(recovery?.refused).toBe(true);
  expect(drawn(recovery?.doc ?? new Y.Doc())).toEqual(['a', 'b']);
  expect(userToast).toHaveBeenCalledOnce();
  expect(userToast).toHaveBeenCalledWith(
    expect.objectContaining({ id: `item-refused-${id}` })
  );
  room.destroy();
});

// A tab that goes while its merge runs flags nothing: the rows stay late, for
// the next open to merge (review re-check, small).
it('leaves the early rows late when the tab goes while their merge runs', async () => {
  let release = () => {};
  merges.hold = new Promise((resolve) => {
    release = resolve;
  });
  const { id, opened } = await sideBySide(2000, 3000);
  const room = await opened('failing');
  await vi.waitUntil(() => merges.tried > 0);
  room.destroy();
  release();
  await vi.waitUntil(() => merges.runs > 0);
  const rows = await settledDrafts(`u_mock:material:${id}`);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((row) => row.late && !row.refused)).toBe(true);
});

// Review M3: Retry, which the strip offers 30 s in, pressed while the rename
// waits for the draft send goes through the rename: no JOIN goes before it.
it('joins only once renamed when Retry is pressed while the rename waits for the draft send', async () => {
  const id = canvas();
  let sends = 0;
  vi.stubGlobal('fetch', async (url: URL | string, init?: RequestInit) => {
    if (!String(url).endsWith('/drafts')) throw new TypeError('No network');
    sends++;
    if (sends === 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return new Response(null, { status: 503 });
    }
    await admitMockBoardDrafts(id, new Uint8Array(init?.body as Uint8Array));
    return new Response(null, { status: 200 });
  });
  const { copy } = await drewAndLeft(id);
  const second = copyOf(id, copy.doc);
  // A session whose token answered: its rows go through the draft send.
  joins.held = [];
  const first = await open(id, copy);
  await vi.waitUntil(() => joins.held?.length);
  draw(first.doc, 'b', 20);
  await vi.waitUntil(async () => (await rowsOf(id)).some((row) => !row.late));
  first.destroy();
  joins.held = null;
  const onReplace = vi.fn();
  token.failing = new TypeError('Failed to fetch');
  const room = await open(id, second, onReplace);
  await vi.waitUntil(() => room.getSnapshot().offline === 'offline');
  draw(room.doc, 'c', 40);
  const own = room.doc.clientID;
  token.failing = null;
  room.retry();
  await vi.waitUntil(() => sends === 1);
  // A JOIN asked for now waits for the rename itself, not only the send.
  const gate = joins.providers.at(-1)?.config.beforeJoin?.();
  expect(gate).toBeInstanceOf(Promise);
  let renamedFirst: boolean | null = null;
  void gate?.then(() => {
    renamedFirst = !writers(room.doc).includes(own);
  });
  // Retry asks the send again and connects nothing.
  joins.held = [];
  room.retry();
  expect(joins.held).toEqual([]);
  joins.held = null;
  await vi.waitUntil(
    () => room.getSnapshot().synced || onReplace.mock.calls.length > 0
  );
  expect(renamedFirst).toBe(true);
  expect(onReplace).not.toHaveBeenCalled();
  expect(userToast).not.toHaveBeenCalled();
  const peer = mockBoardPeer(id);
  expect(Object.keys(peer.elements()).sort()).toEqual(['a', 'b', 'c']);
  expect(elements(peer.document).get('c')?._item?.id.client).toBe(
    room.doc.clientID
  );
  peer.leave();
  room.destroy();
});

// Review m1: a tab that painted an earlier session's late rows holds that
// session's lock until it is done with them, so a second tab leaves them and
// they are renamed once.
it("leaves an earlier session's rows to the early tab that painted them", async () => {
  const id = canvas();
  const { copy } = await drewAndLeft(id);
  const [second, third] = [copyOf(id, copy.doc), copyOf(id, copy.doc)];
  const earlier = await offlineFrom(id, copy);
  draw(earlier.doc, 'b', 20);
  await vi.waitFor(async () => expect(await rowsOf(id)).not.toEqual([]));
  earlier.destroy();
  const one = await offlineFrom(id, second);
  expect(drawn(one.doc)).toEqual(['a', 'b']);
  const two = await offlineFrom(id, third);
  expect(drawn(two.doc)).toEqual(['a']);
  await back(one);
  await back(two);
  expect(drawn(two.doc)).toEqual(['a', 'b']);
  const peer = mockBoardPeer(id);
  expect(elements(peer.document).get('b')?._item?.id.client).toBe(
    one.doc.clientID
  );
  peer.leave();
  one.destroy();
  two.destroy();
});

// Review m1: the lock goes with the tab that took it, as it leaves, or at
// once when it paints nothing.
it("gives an earlier session's lock back as the early tab that took it leaves, or paints nothing", async () => {
  const id = canvas();
  const { copy } = await drewAndLeft(id);
  const [second, third] = [copyOf(id, copy.doc), copyOf(id, copy.doc)];
  const earlier = await offlineFrom(id, copy);
  draw(earlier.doc, 'b', 20);
  await vi.waitFor(async () => expect(await rowsOf(id)).not.toEqual([]));
  earlier.destroy();
  const lock = `capy-draft-session:${(await rowsOf(id))[0]?.session}`;
  await vi.waitUntil(() => !locks.has(lock));
  // Gone before it painted.
  token.failing = null;
  const gone = new ItemRoom(id, {
    awareness: true,
    board: BOARD,
    drafts: { actorId: 'u_mock', kind: 'canvas' },
    seed: second,
  });
  void gone.start();
  gone.destroy();
  await vi.waitUntil(() => claims.includes(lock));
  await vi.waitUntil(() => !locks.has(lock));
  // Painted, then gone.
  const one = await offlineFrom(id, third);
  expect(drawn(one.doc)).toEqual(['a', 'b']);
  expect(locks.has(lock)).toBe(true);
  one.destroy();
  await vi.waitUntil(() => !locks.has(lock));
});

// An early board that wrote nothing takes the token's id with no rename
// (`adopt`): what follows a rename hears it (a label editor open on it keeps
// its own Undo, roomStore.test.ts).
it("tells what follows a rename when an early board with no edits takes the token's id", async () => {
  const id = canvas();
  const { copy } = await drewAndLeft(id);
  const room = await offlineFrom(id, copy);
  const taken: number[] = [];
  onRenamed(room.doc, (renamed, to) => {
    expect(renamed.size).toBe(0);
    taken.push(to);
  });
  await back(room);
  expect(taken).toEqual([room.doc.clientID]);
  room.destroy();
});

// Review m4: the room may take the renamed edits and answer their receipt
// while it holds its own state back for the open budget (step 1 at once, step
// 2 held). The early rows stay until the room's state is in and what it hides
// is stored: here it cannot be, so they stay as its only copy.
it("keeps the early rows through a receipt that comes before the room's state, when what it hides cannot be stored", async () => {
  const id = canvas();
  const { copy, peer } = await twoSquares(id);
  token.failing = new TypeError('Failed to fetch');
  const room = await open(id, copy);
  await vi.waitUntil(() => room.getSnapshot().early);
  elements(room.doc).get('from')?.set('xywh', '[50,50,100,100]');
  peer.remove('from');
  await vi.waitUntil(async () => (await rowsOf(id)).length > 0);
  const early = new Set((await rowsOf(id)).map((row) => row.session));
  // Renamed, its JOIN waiting here.
  joins.held = [];
  token.failing = null;
  room.retry();
  await vi.waitUntil(() => joins.held?.length);
  // The room acknowledges the renamed edits and answers their receipt.
  const sent = joins.providers.at(-1);
  sent?.config.onUnsyncedChanges?.({ number: 0 });
  const asked = JSON.parse(sent?.stateless.at(-1) ?? '{}') as { id?: string };
  expect(asked.id).toBeDefined();
  sent?.config.onStateless?.({
    payload: JSON.stringify({
      checkpointIds: [asked.id],
      type: 'checkpoint-persisted',
    }),
  });
  await settledDrafts(`u_mock:material:${id}`);
  // Then its state, which hides the move of `from`.
  storage.fails = (message) =>
    message.op === 'put' && message.rows.some((row) => row.hidden);
  const held = joins.held ?? [];
  joins.held = null;
  for (const connect of held) connect();
  await synced(room);
  expect(room.getSnapshot().recovery?.merged).toBe(true);
  await vi.waitUntil(() => storage.failed > 0);
  room.destroy();
  storage.fails = null;
  const rows = await settledDrafts(`u_mock:material:${id}`);
  expect(rows.some((row) => early.has(row.session))).toBe(true);
  peer.leave();
});
