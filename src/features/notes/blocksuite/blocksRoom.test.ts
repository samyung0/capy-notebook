import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { MaterialValue } from '@/features/materials/document';
import { registerMockCollaborationProvider } from '@/mocks/collaboration';
import * as db from '@/mocks/db';
import { BlocksRoom } from './blocksRoom';
import { blocksValue, canonical } from './layout';

vi.mock('@/api/auth', () => ({ USE_MSW: true }));
vi.mock('@/features/notes/plugins', () => ({ MaterialKit: [] }));
vi.mock('@/api/hooks', async (original) => ({
  ...(await original<typeof import('@/api/hooks')>()),
  getMaterialCollaborationToken: async (materialId: string) => ({
    access: 'write',
    expiresAt: 0,
    room: `material:${materialId}`,
    token: 'mock-collaboration-token',
    url: 'mock://collaboration',
  }),
}));

const VALUE: MaterialValue = [
  { children: [{ text: 'Title' }], id: 'title', type: 'h1' },
  { children: [{ text: 'base' }], id: 'body', type: 'p' },
];

beforeAll(registerMockCollaborationProvider);
afterEach(() => vi.unstubAllEnvs());

it('is ready once the room synced, holding the seed and nothing of its own', async () => {
  vi.stubEnv('VITE_DOCUMENT_LAYOUT', 'blocks');
  const material = {
    ...db.materials[0],
    id: 'test-blocks-binding',
    kind: 'note' as const,
  };
  db.materials.push(material);
  const room = new BlocksRoom(material.id, VALUE);
  const ready = new Promise<void>((resolve) =>
    room.subscribe(() => {
      if (room.getSnapshot().status === 'ready') resolve();
    })
  );
  expect(room.getSnapshot()).toEqual({ status: 'connecting' });
  await room.start();
  await ready;
  expect(room.getSnapshot()).toEqual({ readonly: false, status: 'ready' });
  expect(blocksValue(room.doc)).toEqual(canonical(VALUE));
  // Every struct is the seed's: the tab wrote nothing while joining.
  expect([
    ...Y.decodeStateVector(Y.encodeStateVector(room.doc)).keys(),
  ]).not.toContain(room.doc.clientID);
  room.destroy();
  db.materials.splice(db.materials.indexOf(material), 1);
});
