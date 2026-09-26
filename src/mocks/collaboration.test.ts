import { getProviderClass } from '@platejs/yjs';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { qk } from '@/api/client';
import { queryClient } from '@/api/queryClient';
import {
  clearSourceDrafts,
  readSourceDrafts,
  writeSourceDraft,
} from '@/features/files/sourceDraft';
import { createSourceProvider } from '@/features/files/sourceProvider';
import { parseMaterialDocument } from '@/features/materials/document';
import { setChaosPeers } from './chaosPeers';
import {
  checkpointRoom,
  join,
  registerMockCollaborationProvider,
  rooms,
  sourceRoom,
} from './collaboration';
import * as db from './db';

vi.mock('@/api/auth', () => ({ USE_MSW: true }));
// These checks exercise source peers; their unused Plate plugins import CSS.
vi.mock('@/features/notes/plugins', () => ({ MaterialKit: [] }));

const documents: Y.Doc[] = [];
const cleanups: (() => void)[] = [];

function participant(presence = false) {
  const document = new Y.Doc();
  documents.push(document);
  return {
    awareness: presence ? new Awareness(document) : undefined,
    document,
    origin: {},
  };
}

function connect(room: ReturnType<typeof sourceRoom>, presence = false) {
  const client = participant(presence);
  const leave = join(room, client);
  cleanups.push(leave);
  return { ...client, leave };
}

beforeAll(registerMockCollaborationProvider);
afterEach(() => {
  setChaosPeers(false);
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const document of documents.splice(0)) document.destroy();
  queryClient.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('relays updates with the receiving origin and clears presence on leave', () => {
  const room = sourceRoom('test-relay', 1, 'base');
  const a = connect(room, true);
  const b = connect(room, true);
  b.awareness!.setLocalState({ name: 'Peer' });
  expect(a.awareness!.getStates().get(b.document.clientID)).toEqual({
    name: 'Peer',
  });
  const received = vi.fn();
  a.document.on('update', received);
  b.document.getText('source').insert(4, '!');
  expect(a.document.getText('source').toString()).toBe('base!');
  expect(received.mock.calls[0][1]).toBe(a.origin);
  b.leave();
  expect(a.awareness!.getStates().has(b.document.clientID)).toBe(false);
  expect(b.awareness!.getStates().has(a.document.clientID)).toBe(false);
  expect(b.awareness!.getLocalState()).toEqual({ name: 'Peer' });
  a.leave();
  expect(rooms.has(room.name)).toBe(false);
});

it('persists a note when leaving before the editor checkpoint debounce fires', () => {
  const initialValue = [
    { children: [{ text: 'Title' }], type: 'h1' },
    { children: [{ text: 'base' }], type: 'p' },
  ];
  const material = { ...db.materials[0], id: 'test-note' };
  db.materials.push(material);
  cleanups.push(() => db.materials.splice(db.materials.indexOf(material), 1));
  queryClient.setQueryData(qk.material(material.id), { ...material });
  const Provider = getProviderClass('mock')!;
  const client = participant(true);
  const provider = new Provider({
    awareness: client.awareness,
    doc: client.document,
    options: {
      initialValue,
      materialId: material.id,
      name: 'material:test-note',
    },
  });
  cleanups.push(() => provider.destroy());
  provider.connect();
  const paragraph = client.document.get('content', Y.XmlText).toDelta()[1]
    .insert as Y.XmlText;
  paragraph.insert(4, '!');
  provider.disconnect();
  expect(parseMaterialDocument(material.content)?.value[1].children).toEqual([
    { text: 'base!' },
  ]);
  expect(
    queryClient.getQueryState(qk.material(material.id))?.isInvalidated
  ).toBe(true);
  // Reconnecting the same document must preserve its identities too.
  provider.connect();
  expect(client.document.get('content', Y.XmlText).toDelta()).toHaveLength(2);
  expect(paragraph.toString()).toBe('base!');
  // A clean checkpoint/close must not make merely viewing look like an edit.
  const room = rooms.get('material:test-note')!;
  const savedVersion = room.version;
  material.updatedAt = '2026-09-01T00:00:00Z';
  checkpointRoom(room);
  provider.disconnect();
  expect(material.updatedAt).toBe('2026-09-01T00:00:00Z');
  expect(room.version).toBe(savedVersion);
});

it('restores source checkpoints without duplicating an overlapping draft', () => {
  const room = sourceRoom('test-draft', 1, 'base');
  const client = connect(room);
  client.document.getText('source').insert(4, '!');
  const draft = Y.encodeStateAsUpdate(client.document);
  client.leave();
  const reopened = sourceRoom('test-draft', 1, 'base!');
  expect(reopened.version).toBeGreaterThan(0);
  const restored = connect(reopened);
  Y.applyUpdate(restored.document, draft);
  expect(restored.document.getText('source').toString()).toBe('base!');
  client.leave();
  expect(rooms.get(room.name)).toBe(reopened);
});

it('keeps MSW source drafts out of the durable browser database', async () => {
  const open = vi.fn(() => {
    throw new Error('Unexpected IndexedDB access');
  });
  vi.stubGlobal('indexedDB', { open });
  const draft = {
    baseSourceSHA256: 'mock-base',
    epoch: 1,
    fileId: 'mock-user:mock-file',
    id: 'draft',
    state: new Uint8Array(),
    version: '1',
  };
  expect(await readSourceDrafts(draft.fileId)).toEqual([]);
  await writeSourceDraft(draft, new Uint8Array());
  await clearSourceDrafts([draft]);
  expect(open).not.toHaveBeenCalled();
});

it('acknowledges source checkpoints asynchronously and saves peer-only edits', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const room = sourceRoom('test-peer-save', 1, 'base');
  const client = participant();
  const onSynced = vi.fn();
  const onStateless = vi.fn();
  const provider = createSourceProvider({
    document: client.document,
    name: room.name,
    onStateless,
    onSynced,
    token: async () => '',
    url: 'mock://collaboration',
  });
  cleanups.push(() => provider.destroy());
  expect(onSynced).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(onSynced).toHaveBeenCalledWith({ state: true });
  provider.sendStateless(
    JSON.stringify({ id: 'first', type: 'checkpoint-request' })
  );
  expect(onStateless).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(JSON.parse(onStateless.mock.calls[0][0].payload)).toMatchObject({
    checkpointIds: ['first'],
    epoch: 1,
    type: 'checkpoint-persisted',
  });
  setChaosPeers(true);
  await vi.advanceTimersByTimeAsync(3000);
  const visible = client.document.getText('source').toString();
  expect(visible).not.toBe('base');
  expect(db.fileLinks[room.target.id].url).toBe(db.textUrl(visible));
  provider.destroy();
  await vi.advanceTimersByTimeAsync(1000);
  expect(rooms.has(room.name)).toBe(false);
});

it('replaces idle peers when their room is dropped and reopened', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const room = sourceRoom('test-idle', 1, 'base');
  const client = connect(room);
  setChaosPeers(true);
  await vi.advanceTimersByTimeAsync(6501);
  expect(room.participants.size).toBe(1);
  client.leave();
  expect(rooms.has(room.name)).toBe(false);
  const reopened = sourceRoom('test-idle', 1, 'base');
  connect(reopened);
  await vi.advanceTimersByTimeAsync(2500);
  expect(reopened.participants.size).toBe(4);
  expect(room.participants.size).toBe(0);
  setChaosPeers(false);
  expect(rooms.get(room.name)).toBe(reopened);
  expect(reopened.participants.size).toBe(1);
});
