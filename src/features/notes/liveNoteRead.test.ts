import { slateNodesToInsertDelta } from '@slate-yjs/core';
import { expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { RoomProviderConfig } from '@/features/collaboration/roomProvider';
import type { MaterialValue } from '@/features/materials/document';

// A note's View following its room: on a read channel whoever reads, and
// joined afresh when the server closes that channel for writing.
const providers: RoomProviderConfig[] = [];
vi.mock('@/features/collaboration/roomProvider', () => ({
  RoomProvider: class {
    constructor(config: RoomProviderConfig) {
      providers.push(config);
    }
    connect() {}
    disconnect() {}
    destroy() {}
    sendStateless() {}
  },
}));
const requests = vi.hoisted(() => [] as unknown[]);
vi.mock('@/api/hooks', () => ({
  getMaterialCollaborationToken: vi.fn(async (_id: string, body: unknown) => {
    requests.push(body);
    return {
      access: 'read',
      room: 'material:n:schema:1',
      token: 't',
      url: 'ws://x',
    };
  }),
}));
vi.mock('@/components/ui/userToast', () => ({ userToast: vi.fn() }));

const { readNoteLive } = await import('./liveNoteRead');
const flush = () => new Promise((done) => setTimeout(done, 0));

it('asks for a read channel and rejoins when the server closes it for writing', async () => {
  const room = new Y.Doc();
  room
    .get('content', Y.XmlText)
    .applyDelta(
      slateNodesToInsertDelta([
        { children: [{ text: 'one' }], id: 'a', type: 'p' },
      ] as never)
    );
  const values: MaterialValue[] = [];
  const leave = readNoteLive('n', [], (value) => values.push(value));
  await flush();
  // An owner's or editor's View too reads only (REVIEW5 N2).
  expect(requests).toEqual([{ access: 'read', document: undefined }]);
  const first = providers[0];
  Y.applyUpdate(first.document, Y.encodeStateAsUpdate(room), 'server');
  first.onSynced?.({ state: true });
  expect(values).toHaveLength(1);
  // What the room sends a read channel whose sync carried changes it no
  // longer holds (it lost its last window): a fresh room joins (REVIEW5 S1).
  first.onClose?.({
    code: 4000,
    reason: 'read-only connection sent a document update',
  });
  await flush();
  await flush();
  expect(providers).toHaveLength(2);
  expect(requests).toHaveLength(2);
  const second = providers[1];
  expect(second.document).not.toBe(first.document);
  Y.applyUpdate(second.document, Y.encodeStateAsUpdate(room), 'server');
  second.onSynced?.({ state: true });
  // The View carries on from what it showed: the unchanged block keeps its
  // object.
  expect(values).toHaveLength(2);
  expect(values[1][0]).toBe(values[0][0]);
  leave();
});
