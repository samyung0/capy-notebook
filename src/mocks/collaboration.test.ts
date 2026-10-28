import { readFileSync } from 'node:fs';
import { getProviderClass } from '@platejs/yjs';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { qk } from '@/api/client';
import { queryClient } from '@/api/queryClient';
import { createSourceProvider } from '@/features/files/sourceProvider';
import {
  type MaterialValue,
  normalizeMaterialValue,
  parseMaterialDocument,
} from '@/features/materials/document';
import {
  BLOCKS_ROOT,
  blocksValue,
  canonical,
} from '@/features/notes/blocksuite/layout';
import { deleteDrafts, putDrafts, readDrafts } from '@/lib/editDrafts';
import { setChaosPeers } from './chaosPeers';
import {
  checkpointRoom,
  join,
  mockBlocksRoom,
  registerMockCollaborationProvider,
  rooms,
  savedSourceState,
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
  vi.unstubAllEnvs();
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

function testNote(id: string) {
  const material = { ...db.materials[0], id, kind: 'note' as const };
  db.materials.push(material);
  cleanups.push(() => db.materials.splice(db.materials.indexOf(material), 1));
  return material;
}

it('relays a blocks room until both participants hold the same value', () => {
  vi.stubEnv('VITE_DOCUMENT_LAYOUT', 'blocks');
  const material = testNote('test-blocks-relay');
  const room = mockBlocksRoom(material.id, [
    { children: [{ text: 'Title' }], id: 'title', type: 'h1' },
    { children: [{ text: 'base' }], id: 'body', type: 'p' },
  ]);
  const a = connect(room, true);
  const b = connect(room, true);
  const text = (document: Y.Doc) =>
    document
      .getMap<Y.Map<unknown>>(BLOCKS_ROOT)
      .get('body')
      ?.get('prop:text') as Y.Text;
  text(a.document).insert(0, '> ');
  text(b.document).insert(6, '!');
  expect(blocksValue(a.document)).toEqual(blocksValue(b.document));
  expect(blocksValue(b.document)[1]).toEqual({
    children: [{ text: '> base!' }],
    id: 'body',
    type: 'p',
  });
  a.leave();
  b.leave();
  expect(parseMaterialDocument(material.content)?.value[1].children).toEqual([
    { text: '> base!' },
  ]);
});

/** The value a note's room checkpoint writes, the room seeded with `value`. */
function persisted(id: string, value: MaterialValue) {
  testNote(id);
  const name = `material:${id}:schema:1`;
  const client = participant(true);
  const provider = new (getProviderClass('mock')!)({
    awareness: client.awareness,
    doc: client.document,
    options: { initialValue: value, materialId: id, name },
  });
  cleanups.push(() => provider.destroy());
  provider.connect();
  const room = rooms.get(name)!;
  room.dirty = true;
  checkpointRoom(room);
  provider.disconnect();
  const material = db.materials.find((row) => row.id === id);
  return {
    layout: room.layout,
    value: parseMaterialDocument(material?.content),
  };
}

it('persists a blocks room as the Plate room writes it', () => {
  const every: MaterialValue = JSON.parse(
    readFileSync(
      new URL(
        '../../server/internal/materialdoc/testdata/every-block-note.json',
        import.meta.url
      ),
      'utf8'
    )
  ).value;
  // The fixture's unsaved refs (materialId "" with `pending`) are no stored
  // note's, and the layout refuses them.
  const saved = canonical(
    normalizeMaterialValue(every.filter((block) => block.materialId !== ''))
  );
  const plate = persisted('test-plate-persist', saved);
  vi.stubEnv('VITE_DOCUMENT_LAYOUT', 'blocks');
  const blocks = persisted('test-blocks-persist', saved);
  expect([plate.layout, blocks.layout]).toEqual([undefined, 'blocks']);
  expect(blocks.value).toEqual(plate.value);
  expect(blocks.value?.value).toEqual(saved);
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
      name: 'material:test-note:schema:1',
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
  const room = rooms.get('material:test-note:schema:1')!;
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
    data: new Uint8Array(),
    id: 'draft:state',
    key: 'mock-user:file:mock-file',
    kind: 'state' as const,
    lineage: 'source:mock-file:epoch:1@mock-base',
    savedAt: 0,
    seq: 1,
    session: 'draft',
  };
  expect(await readDrafts(draft.key)).toEqual([]);
  await putDrafts([draft], new Uint8Array());
  await deleteDrafts([draft]);
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
  // Saved for the viewer's read, not published.
  const saved = new Y.Doc();
  documents.push(saved);
  Y.applyUpdate(
    saved,
    Uint8Array.from(atob(savedSourceState(room.target.id)!), (character) =>
      character.charCodeAt(0)
    )
  );
  expect(saved.getText('source').toString()).toBe(visible);
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
