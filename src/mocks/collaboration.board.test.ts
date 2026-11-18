import { beforeAll, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { WorkspaceRole } from '@/api/types';
import type { ItemProvider } from '@/features/collaboration/itemRoom';
import type { RoomProviderConfig } from '@/features/collaboration/roomProvider';
import { COLLABORATION_NOT_FOUND_REASON } from '@/features/notes/collaborationEvents';
import { mockMemberCanvas } from './canvas';
import {
  mockBoardPeer,
  mockRevokeBoard,
  registerMockCollaborationProvider,
} from './collaboration';

/* A canvas's mock room (collaboration.ts, the board room), driven as an item
 * room drives its provider. */

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
    token: async () => 'mock-collaboration-token',
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
  points: [
    [0, 0],
    [10, 10],
  ],
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
  big.set('text', 'x'.repeat(2 * 1024 * 1024 + 1));
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
