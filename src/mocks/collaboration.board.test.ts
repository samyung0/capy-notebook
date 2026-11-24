import { beforeAll, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { BOARD_CATALOG } from '@/api/board.generated';
import type { WorkspaceRole } from '@/api/types';
import { encodeStrokePoints } from '@/features/blocksuite/strokePoints';
import type { ItemProvider } from '@/features/collaboration/itemRoom';
import type { RoomProviderConfig } from '@/features/collaboration/roomProvider';
import { COLLABORATION_NOT_FOUND_REASON } from '@/features/notes/collaborationEvents';
import { mockCanvasToken, mockMemberCanvas } from './canvas';
import {
  mockBoardPeer,
  mockBoardSocket,
  mockBoardStored,
  mockFillBoard,
  mockRevokeBoard,
  registerMockCollaborationProvider,
} from './collaboration';

/* A canvas's mock room (collaboration.ts, the board room), driven as an item
 * room drives its provider. */

// Whichever test joins first loads the board's modules for its first state
// (`tab` waits 30 s for it), which takes longer than 5 s on a loaded machine.
vi.setConfig({ testTimeout: 30_000 });

vi.mock('@/api/auth', () => ({ USE_MSW: true }));
// The note mock's unused Plate plugins import CSS.
vi.mock('@/features/notes/plugins', () => ({ MaterialKit: [] }));
// The provider the mocks register for an item room, taken as it is given.
const registered = vi.hoisted(() => ({
  make: null as ((config: RoomProviderConfig) => ItemProvider) | null,
}));
vi.mock('@/features/collaboration/itemRoom', () => ({
  registerMockItemProvider: (make: typeof registered.make) => {
    registered.make = make;
  },
}));

beforeAll(() => registerMockCollaborationProvider());

/** A shared canvas the mock user holds by `role`. */
const canvas = (role: WorkspaceRole) =>
  mockMemberCanvas({
    creatorName: 'Ben',
    role,
    title: 'Lab diagrams',
    workspaceId: 'ws_bio',
  });

/** A tab on the canvas: its document and what its provider told it. */
async function tab(id: string) {
  const document = new Y.Doc();
  const heard = {
    closed: [] as { code: number; reason: string }[],
    origins: [] as unknown[],
    refused: [] as string[],
    stateless: [] as { code?: string; type: string }[],
    synced: 0,
  };
  if (!registered.make) throw new Error('no mock item provider');
  const provider = registered.make({
    document,
    name: `material:${id}:schema:1`,
    onAuthenticationFailed: ({ reason }) => heard.refused.push(reason),
    onClose: (event) => heard.closed.push(event),
    onStateless: ({ payload }) => heard.stateless.push(JSON.parse(payload)),
    onSynced: () => {
      heard.synced += 1;
    },
    token: async (previous) => mockCanvasToken(id, previous),
    url: 'mock://collaboration',
  });
  document.on('update', (_: Uint8Array, origin: unknown) =>
    heard.origins.push(origin)
  );
  provider.connect();
  // The first join loads the board's own modules for its first state.
  await vi.waitUntil(() => heard.synced + heard.refused.length > 0, {
    timeout: 30_000,
  });
  return { document, heard, provider };
}

const stroke = {
  color: '#000000',
  index: 'a0',
  lineWidth: 4,
  points: encodeStrokePoints([
    [0, 0],
    [10, 10],
  ]),
  rotate: 0,
  seed: 1,
  type: 'brush',
  xywh: '[0,0,10,10]',
};

/** The canvas's elements in a tab's document, by id. */
function drawn(document: Y.Doc) {
  const surface = document.getMap<Y.Map<unknown>>('blocks').get('surface');
  const elements = surface?.get('prop:elements');
  const value = elements instanceof Y.Map ? elements.get('value') : null;
  if (!(value instanceof Y.Map)) throw new Error('The room holds no canvas');
  return value as Y.Map<Y.Map<unknown>>;
}

it("seeds a canvas's room with the editor's first state and relays a peer's stroke under the provider", async () => {
  const id = canvas('editor');
  const { document, heard, provider } = await tab(id);
  // The page and its canvas, written by the seed's own client alone.
  expect(document.getMap('blocks').toJSON()).toMatchObject({
    page: { 'sys:children': ['surface'], 'sys:flavour': 'affine:page' },
    surface: { 'sys:flavour': 'affine:surface' },
  });
  expect([
    ...Y.decodeStateVector(Y.encodeStateVector(document)).keys(),
  ]).toEqual([1]);
  const peer = mockBoardPeer(id);
  peer.add('peer-stroke', stroke);
  expect(drawn(document).get('peer-stroke')?.get('type')).toBe('brush');
  // Never null: BlockSuite reads a null origin as this tab's own edit.
  expect(heard.origins.at(-1)).toBe(provider);
  peer.leave();
  provider.destroy();
});

it("sends a tab's stroke to its peer and answers a checkpoint request with its receipt", async () => {
  const id = canvas('editor');
  const { document, heard, provider } = await tab(id);
  const peer = mockBoardPeer(id);
  const element = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(stroke)) element.set(key, value);
  drawn(document).set('own-stroke', element);
  expect(peer.elements()['own-stroke']).toMatchObject({ type: 'brush' });
  provider.sendStateless(
    JSON.stringify({ id: 'request-1', type: 'checkpoint-request' })
  );
  await vi.waitFor(() =>
    expect(heard.stateless).toContainEqual(
      expect.objectContaining({
        checkpointIds: ['request-1'],
        type: 'checkpoint-persisted',
      })
    )
  );
  peer.leave();
  provider.destroy();
});

// As the service's note room: a request answers at once only when nothing waits
// to be stored, so typing asks for one store per pause, not one per key.
it('answers a checkpoint request once the room stored what it holds', async () => {
  const id = canvas('editor');
  const { document, heard, provider } = await tab(id);
  const receipts = () =>
    heard.stateless.filter(({ type }) => type === 'checkpoint-persisted');
  provider.sendStateless(
    JSON.stringify({ id: 'idle', type: 'checkpoint-request' })
  );
  await vi.waitFor(() => expect(receipts()).toHaveLength(1));
  drawn(document).set('own-stroke', new Y.Map());
  provider.sendStateless(
    JSON.stringify({ id: 'typed', type: 'checkpoint-request' })
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(mockBoardStored(id)).toBe(false);
  expect(receipts()).toHaveLength(1);
  await vi.waitFor(() =>
    expect(receipts().at(-1)).toMatchObject({ checkpointIds: ['typed'] })
  );
  expect(mockBoardStored(id)).toBe(true);
  provider.destroy();
});

// As the service: changes with no pause between them are stored 10 s after the
// first.
it('stores a room that keeps changing 10 s after its first change', async () => {
  const id = canvas('editor');
  const { document, provider } = await tab(id);
  vi.useFakeTimers({ toFake: ['Date', 'clearTimeout', 'setTimeout'] });
  try {
    const start = Date.now();
    let storedAt: number | null = null;
    // A change every 200 ms, under the room's pause.
    for (let i = 0; i < 60 && storedAt === null; i++) {
      drawn(document).set(`stroke-${i}`, new Y.Map());
      vi.advanceTimersByTime(200);
      if (mockBoardStored(id)) storedAt = Date.now() - start;
    }
    expect(storedAt).toBe(10_000);
  } finally {
    vi.useRealTimers();
    provider.destroy();
  }
});

it('opens a stored board again as it was left', async () => {
  const id = canvas('editor');
  const first = await tab(id);
  const peer = mockBoardPeer(id);
  peer.add('kept-stroke', stroke);
  peer.leave();
  // The last one out: the room stores and unloads.
  first.provider.destroy();
  const again = await tab(id);
  expect(drawn(again.document).get('kept-stroke')?.get('type')).toBe('brush');
  again.provider.destroy();
});

it("closes a viewer's channel that writes, and keeps the write out of the room", async () => {
  const id = canvas('viewer');
  const { document, heard, provider } = await tab(id);
  const peer = mockBoardPeer(id);
  drawn(document).set('viewer-stroke', new Y.Map());
  await vi.waitFor(() =>
    expect(heard.closed).toEqual([
      expect.objectContaining({
        reason: 'read-only connection sent a document update',
      }),
    ])
  );
  expect(peer.elements()).toEqual({});
  peer.leave();
  provider.destroy();
});

it('rejects the update that takes a board over its cap, for its writer alone', async () => {
  const id = canvas('editor');
  const { document, heard, provider } = await tab(id);
  const peer = mockBoardPeer(id);
  const big = new Y.Map<unknown>();
  big.set('text', 'x'.repeat(BOARD_CATALOG.limits.CANVAS_BOARD_MAX + 1));
  drawn(document).set('too-big', big);
  await vi.waitFor(() =>
    expect(heard.stateless).toContainEqual(
      expect.objectContaining({
        code: 'document_size_exceeded',
        type: 'document-rejected',
      })
    )
  );
  expect(heard.closed).toHaveLength(1);
  expect(peer.elements()).toEqual({});
  // The peer draws on.
  peer.add('after', stroke);
  expect(Object.keys(peer.elements())).toEqual(['after']);
  peer.leave();
  provider.destroy();
});

// As the service near its cap: an update that grows nothing (a deletion) is
// taken on a full board, and a receipt says the board's size.
it('takes a deletion on a full board, and its receipt says the size', async () => {
  const id = canvas('editor');
  const { document, heard, provider } = await tab(id);
  mockFillBoard(id);
  await vi.waitFor(() => expect(drawn(document).has('filler')).toBe(true));
  drawn(document).delete('filler');
  provider.sendStateless(
    JSON.stringify({ id: 'r1', type: 'checkpoint-request' })
  );
  await vi.waitFor(() =>
    expect(heard.stateless).toContainEqual(
      expect.objectContaining({ type: 'checkpoint-persisted' })
    )
  );
  expect(heard.stateless).not.toContainEqual(
    expect.objectContaining({ type: 'document-rejected' })
  );
  const receipt = heard.stateless.find(
    ({ type }) => type === 'checkpoint-persisted'
  ) as { metrics?: { contentBytes: number } } | undefined;
  expect(receipt?.metrics?.contentBytes).toBeLessThan(
    BOARD_CATALOG.limits.CANVAS_BOARD_MAX / 2
  );
  provider.destroy();
});

it('closes the others when a canvas is taken back, and refuses their next join', async () => {
  const id = canvas('editor');
  const { heard, provider } = await tab(id);
  mockRevokeBoard(id);
  expect(heard.closed).toEqual([
    { code: 4403, reason: 'collaboration access changed' },
  ]);
  provider.connect();
  await vi.waitFor(() =>
    expect(heard.refused).toEqual([COLLABORATION_NOT_FOUND_REASON])
  );
  provider.destroy();
});

it('relays a presence state a board lists and drops any other', async () => {
  const id = canvas('editor');
  const { provider } = await tab(id);
  const ann = mockBoardPeer(id);
  const ben = mockBoardPeer(id);
  const heard = () => ben.awareness.getStates().get(ann.awareness.clientID);
  ann.awareness.setLocalState({ b: ['shape1'], p: [120, -45] });
  expect(heard()).toEqual({ b: ['shape1'], p: [120, -45] });
  // The room keeps the state it held, as the service does.
  ann.awareness.setLocalState({ p: [0.5, 0] });
  ann.awareness.setLocalState({ p: null, selectionV2: [] });
  expect(heard()).toEqual({ b: ['shape1'], p: [120, -45] });
  ann.awareness.setLocalState({ p: null });
  expect(heard()).toEqual({ p: null });
  ann.leave();
  expect(heard()).toBeUndefined();
  ben.leave();
  provider.destroy();
});

/** A stroke of the tab's own, written as the board writes one. */
function draw(document: Y.Doc, id: string, fields: Record<string, unknown>) {
  const element = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(fields)) element.set(key, value);
  drawn(document).set(id, element);
}

it('keeps what a tab and its peer drew while the tab was cut off, once it is back', async () => {
  const id = canvas('editor');
  const { document, heard, provider } = await tab(id);
  const peer = mockBoardPeer(id);
  mockBoardSocket(id, false);
  expect(heard.closed).toEqual([{ code: 1006, reason: 'socket closed' }]);
  draw(document, 'own-stroke', stroke);
  peer.add('peer-stroke', stroke);
  // Neither has the other's yet.
  expect(Object.keys(peer.elements())).toEqual(['peer-stroke']);
  expect([...drawn(document).keys()]).toEqual(['own-stroke']);
  mockBoardSocket(id, true);
  await vi.waitUntil(() => heard.synced === 2);
  expect(Object.keys(peer.elements()).sort()).toEqual([
    'own-stroke',
    'peer-stroke',
  ]);
  expect([...drawn(document).keys()].sort()).toEqual([
    'own-stroke',
    'peer-stroke',
  ]);
  peer.leave();
  provider.destroy();
});

it('admits what a join brings as any update: nothing past the cap', async () => {
  const id = canvas('editor');
  const { document, heard, provider } = await tab(id);
  const peer = mockBoardPeer(id);
  mockBoardSocket(id, false);
  draw(document, 'too-big', {
    text: 'x'.repeat(BOARD_CATALOG.limits.CANVAS_BOARD_MAX + 1),
  });
  mockBoardSocket(id, true);
  await vi.waitFor(() =>
    expect(heard.stateless).toContainEqual(
      expect.objectContaining({
        code: 'document_size_exceeded',
        type: 'document-rejected',
      })
    )
  );
  expect(peer.elements()).toEqual({});
  peer.leave();
  provider.destroy();
});

/** A tab joining with `document`, its tokens from `token`; what it heard. */
async function joinWith(
  id: string,
  document: Y.Doc,
  token: (previous?: string) => string
) {
  const heard = {
    closed: [] as string[],
    refused: [] as string[],
    rejected: [] as unknown[],
    synced: 0,
  };
  if (!registered.make) throw new Error('no mock item provider');
  const provider = registered.make({
    document,
    name: `material:${id}:schema:1`,
    onAuthenticationFailed: ({ reason }) => heard.refused.push(reason),
    onClose: ({ reason }) => heard.closed.push(reason),
    onStateless: ({ payload }) => {
      const event = JSON.parse(payload) as { type: string };
      if (event.type === 'document-rejected') heard.rejected.push(event);
    },
    onSynced: () => {
      heard.synced += 1;
    },
    token: async (previous) => token(previous),
    url: 'mock://collaboration',
  });
  provider.connect();
  await vi.waitUntil(() => heard.synced + heard.refused.length > 0, {
    timeout: 30_000,
  });
  return { heard, provider };
}

// As the service binds ids (client_ids.rs `holds`; rooms.rs
// `a_clean_leave_expires_the_sessions_row`, Q236): a clean Leave expires the
// id its token offered, so a document that wrote under it is refused at its
// next JOIN even when offered it again; a channel that only dropped keeps it.
it('expires an id at a clean Leave and keeps it through a dropped socket', async () => {
  const id = canvas('editor');
  for (const clean of [true, false]) {
    let last = '';
    const minted = (previous?: string) => {
      last = mockCanvasToken(id, previous);
      return last;
    };
    const document = new Y.Doc();
    const first = await joinWith(id, document, minted);
    draw(document, `stroke-${clean}`, stroke);
    if (!clean) mockBoardSocket(id, false);
    first.provider.destroy();
    if (!clean) mockBoardSocket(id, true);
    // The same document again, its last token presented: Go offers the id
    // again (`regrantedClientIDs`).
    const offered = last;
    const again = await joinWith(id, document, () =>
      mockCanvasToken(id, offered)
    );
    if (clean)
      expect(again.heard.refused).toEqual(['collaboration-unassigned-id']);
    else expect(again.heard.synced).toBe(1);
    again.provider.destroy();
  }
});

// An id a live channel holds is not bound to a second one, and structs under
// an id the person holds no claim to are refused with `unassigned` (Q213,
// `client_ids::foreign`).
it('refuses a second channel on a live id and an update under an unassigned one', async () => {
  const id = canvas('editor');
  const first = mockCanvasToken(id, undefined);
  const one = await joinWith(id, new Y.Doc(), () => first);
  const two = await joinWith(id, new Y.Doc(), () => first);
  expect(two.heard.refused).toEqual(['collaboration-client-id']);
  two.provider.destroy();
  const document = new Y.Doc();
  const writer = await joinWith(id, document, (previous) =>
    mockCanvasToken(id, previous)
  );
  // Written under an id no token offered (made before the tab had one).
  document.clientID = 7777;
  draw(document, 'foreign', stroke);
  await vi.waitFor(() =>
    expect(writer.heard.rejected).toEqual([
      expect.objectContaining({ code: 'unassigned' }),
    ])
  );
  expect(writer.heard.closed).toEqual([
    'update under a client id the writer was not assigned',
  ]);
  const peer = mockBoardPeer(id);
  expect(peer.elements()).toEqual({});
  peer.leave();
  writer.provider.destroy();
  one.provider.destroy();
});
