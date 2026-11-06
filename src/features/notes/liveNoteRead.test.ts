import { slateNodesToInsertDelta } from '@slate-yjs/core';
import { QueryObserver } from '@tanstack/react-query';
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
  materialTokenQuery: (id: string) => ({
    queryFn: () => opened.answer(),
    queryKey: ['material', id, 'collaboration-token'],
    staleTime: 180_000,
  }),
}));
const opened = vi.hoisted(() => ({
  answer: (): Promise<unknown> => Promise.reject(new Error('not asked')),
}));
vi.mock('@/components/ui/userToast', () => ({ userToast: vi.fn() }));

const { queryClient } = await import('@/api/queryClient');
const { readNoteLive } = await import('./liveNoteRead');
const flush = () => new Promise((done) => setTimeout(done, 0));
const OPENED = ['material', 'n', 'collaboration-token'];
const openToken = (access: 'read' | 'write') => ({
  access,
  room: 'material:n:schema:1',
  token: `opened-${access}`,
  url: 'ws://x',
});
const reset = () => {
  requests.length = 0;
  providers.length = 0;
  queryClient.clear();
};

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

it("a viewer's channel takes the token its open asked for, once", async () => {
  reset();
  let answer = (_: unknown) => {};
  opened.answer = () =>
    new Promise((done) => {
      answer = done;
    });
  // Still in flight as the reader starts.
  void queryClient.prefetchQuery({
    queryFn: opened.answer,
    queryKey: OPENED,
  });
  const leave = readNoteLive('n', [], () => {});
  await flush();
  expect(providers).toHaveLength(0);
  answer(openToken('read'));
  await flush();
  await flush();
  expect(requests).toEqual([]);
  expect(providers).toHaveLength(1);
  expect(await providers[0].token?.(undefined)).toBe('opened-read');
  // It left the cache: an editor mounted later asks afresh.
  expect(queryClient.getQueryState(OPENED)).toBeUndefined();
  // A rejoin asks for its own.
  providers[0].onClose?.({
    code: 4000,
    reason: 'read-only connection sent a document update',
  });
  await flush();
  await flush();
  expect(requests).toEqual([{ access: 'read' }]);
  leave();
});

it("an editor's View holds a write token and asks for its read channel", async () => {
  reset();
  queryClient.setQueryData(OPENED, openToken('write'));
  const leave = readNoteLive('n', [], () => {});
  await flush();
  await flush();
  expect(requests).toEqual([{ access: 'read' }]);
  // The editor's stays for the editor.
  expect(queryClient.getQueryData(OPENED)).toMatchObject({ access: 'write' });
  leave();
});

it('an editor demoted to read keeps its token, and its View asks for its own', async () => {
  reset();
  queryClient.setQueryData(OPENED, openToken('read'));
  // The demoted editor still watches the token it reconnected with.
  const editor = new QueryObserver(queryClient, {
    enabled: false,
    queryKey: OPENED,
  });
  const unwatch = editor.subscribe(() => {});
  const leave = readNoteLive('n', [], () => {});
  await flush();
  await flush();
  expect(requests).toEqual([{ access: 'read' }]);
  expect(queryClient.getQueryData(OPENED)).toMatchObject({
    token: 'opened-read',
  });
  unwatch();
  leave();
});

it("an editor's View rejoining with an old write token mints no second one", async () => {
  reset();
  const answered = vi.fn(async () => openToken('write'));
  opened.answer = answered;
  queryClient.setQueryData(OPENED, openToken('write'), {
    updatedAt: Date.now() - 10 * 60_000,
  });
  const leave = readNoteLive('n', [], () => {});
  await flush();
  await flush();
  expect(answered).not.toHaveBeenCalled();
  expect(requests).toEqual([{ access: 'read' }]);
  leave();
});
