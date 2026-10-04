import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  applyDrafts,
  deleteDocumentDrafts,
  deleteDrafts,
  draftGroups,
  type EditDraft,
  putDrafts,
  readDrafts,
  recordDrafts,
} from './editDrafts';

const ROOM = 'material:mat_1:schema:1';
const REMOTE = Symbol('room');

/** A room and one client synced to it, as the provider leaves them. */
function syncedClient(text: string) {
  const room = new Y.Doc();
  room.getText('content').insert(0, text);
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(room), REMOTE);
  return { client, room };
}

function draft(id: string, overrides: Partial<EditDraft> = {}): EditDraft {
  return {
    data: new Uint8Array(),
    id,
    key: 'u_1:material:mat_1',
    kind: 'update',
    lineage: ROOM,
    savedAt: 0,
    seq: 1,
    session: id,
    ...overrides,
  };
}

describe('the draft store', () => {
  it('deletes exactly the rows a receipt covered, and a lost document whole', async () => {
    const key = 'u_1:material:exact';
    await putDrafts([draft('a', { key }), draft('b', { key, seq: 3 })]);
    // Another tab rewrote `b` since: its newer row stays.
    await deleteDrafts([
      { id: 'a', key, seq: 1 },
      { id: 'b', key, seq: 2 },
    ]);
    expect((await readDrafts(key)).map((row) => row.id)).toEqual(['b']);
    await deleteDocumentDrafts(key);
    expect(await readDrafts(key)).toEqual([]);
  });
});

describe('lineage', () => {
  it('merges only the current lineage and shows one other group, refused rows first', () => {
    const rows = [
      draft('old-1', { lineage: 'material:mat_1:schema:1' }),
      draft('refused', { refused: true }),
      draft('old-2', { lineage: 'material:mat_1:schema:1' }),
      draft('live', { lineage: 'material:mat_1:schema:2' }),
    ];
    const opened = draftGroups(rows, 'material:mat_1:schema:2');
    expect(opened.current.map((row) => row.id)).toEqual(['live']);
    expect(opened.recovery.map((row) => row.id)).toEqual(['old-1', 'old-2']);
    // Once that group is gone, the refused row opens in recovery too: it is
    // never current even in its own lineage.
    const later = draftGroups(
      rows.filter((row) => !opened.recovery.includes(row)),
      ROOM
    );
    expect(later.current.map((row) => row.id)).toEqual([]);
    expect(later.recovery.map((row) => row.id)).toEqual(['refused']);
  });
});

describe('recording a note session', () => {
  it('keeps offline edits across a reload and syncs them into the same room', async () => {
    const key = 'u_1:material:reload';
    const { client, room } = syncedClient('shared ');
    const recorder = recordDrafts({
      doc: client,
      ignore: (origin) => origin === REMOTE,
      key,
      limitBytes: 1024 * 1024,
      lineage: ROOM,
    });
    // A remote update is the room's own: never recorded.
    Y.applyUpdate(client, Y.encodeStateAsUpdate(room), REMOTE);
    expect(recorder.sequence).toBe(0);
    recorder.disconnected();
    client.getText('content').insert(7, 'offline');
    expect(recorder.sequence).toBe(1);
    await recorder.flush();
    const rows = await readDrafts(key);
    // The update, and the whole document once for the offline episode.
    expect(rows.map((row) => row.kind).sort()).toEqual(['state', 'update']);

    // The tab reloads: a fresh client applies the rows, then syncs.
    const reopened = new Y.Doc();
    const { current, recovery } = draftGroups(rows, ROOM);
    expect(recovery).toEqual([]);
    applyDrafts(reopened, current, 'restore');
    Y.applyUpdate(
      room,
      Y.encodeStateAsUpdate(reopened, Y.encodeStateVector(room))
    );
    expect(room.getText('content').toString()).toBe('shared offline');
  });

  it('restores online edits without a base once the room sync brings it', async () => {
    const key = 'u_1:material:online';
    const { client, room } = syncedClient('base ');
    const recorder = recordDrafts({
      doc: client,
      ignore: (origin) => origin === REMOTE,
      key,
      limitBytes: 1024 * 1024,
      lineage: ROOM,
    });
    client.getText('content').insert(5, 'typed');
    await recorder.flush();
    const rows = await readDrafts(key);
    expect(rows.map((row) => row.kind)).toEqual(['update']);
    const reopened = new Y.Doc();
    applyDrafts(reopened, rows, 'restore');
    expect(reopened.getText('content').toString()).toBe('');
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(room), REMOTE);
    expect(reopened.getText('content').toString()).toBe('base typed');
  });

  it('deletes rows as receipts cover them, keeping the base while newer edits need it', async () => {
    const key = 'u_1:material:receipts';
    const { client } = syncedClient('a');
    const recorder = recordDrafts({
      doc: client,
      ignore: (origin) => origin === REMOTE,
      key,
      limitBytes: 1024 * 1024,
      lineage: ROOM,
    });
    recorder.disconnected();
    client.getText('content').insert(1, 'b');
    await recorder.flush();
    const requested = recorder.sequence;
    client.getText('content').insert(2, 'c');
    await recorder.flush();
    await recorder.covered(requested);
    const left = await readDrafts(key);
    expect(left.map((row) => [row.kind, row.seq])).toEqual([
      ['update', 2],
      ['state', 1],
    ]);
    await recorder.covered(recorder.sequence);
    expect(await readDrafts(key)).toEqual([]);
    expect(recorder.unsaved).toBe(false);
  });

  it('deletes the rows it adopted from an earlier session once a receipt covers them', async () => {
    const key = 'u_1:material:adopted';
    const earlier = draft('earlier:1', { key, session: 'earlier' });
    await putDrafts([earlier]);
    const recorder = recordDrafts({
      adopted: [earlier],
      doc: new Y.Doc(),
      ignore: () => false,
      key,
      limitBytes: 1024,
      lineage: ROOM,
    });
    expect(recorder.unsaved).toBe(true);
    await recorder.covered(recorder.sequence);
    expect(await readDrafts(key)).toEqual([]);
  });

  it('reports the offline byte bound and lifts it on reconnect, dropping nothing', async () => {
    const key = 'u_1:material:limit';
    const onLimit = vi.fn();
    const { client } = syncedClient('');
    const recorder = recordDrafts({
      doc: client,
      ignore: (origin) => origin === REMOTE,
      key,
      limitBytes: 64,
      lineage: ROOM,
      onLimit,
    });
    // Online, the server enforces the real limits.
    client.getText('content').insert(0, 'x'.repeat(100));
    expect(onLimit).not.toHaveBeenCalled();
    recorder.disconnected();
    expect(onLimit).toHaveBeenLastCalledWith(true);
    client.getText('content').insert(0, 'y');
    await recorder.flush();
    const text = new Y.Doc();
    applyDrafts(text, await readDrafts(key), 'restore');
    expect(text.getText('content').toString()).toBe(`y${'x'.repeat(100)}`);
    recorder.connected();
    expect(onLimit).toHaveBeenLastCalledWith(false);
  });

  it('keeps a refused session as one whole refused document', async () => {
    const key = 'u_1:material:refused';
    const { client } = syncedClient('kept ');
    const recorder = recordDrafts({
      doc: client,
      ignore: (origin) => origin === REMOTE,
      key,
      limitBytes: 1024 * 1024,
      lineage: ROOM,
    });
    client.getText('content').insert(5, 'refused');
    await recorder.flush();
    await recorder.refuse();
    // Recording stopped: later typing writes nothing.
    client.getText('content').insert(0, 'x');
    await recorder.flush();
    const rows = await readDrafts(key);
    expect(rows.map((row) => [row.kind, row.refused])).toEqual([
      ['state', true],
    ]);
    const { current, recovery } = draftGroups(rows, ROOM);
    expect(current).toEqual([]);
    const shown = new Y.Doc();
    applyDrafts(shown, recovery, 'recovery');
    expect(shown.getText('content').toString()).toBe('kept refused');
  });
});

describe('recording a source session', () => {
  it('writes the latest whole state only', async () => {
    const key = 'u_1:file:text';
    const doc = new Y.Doc();
    const recorder = recordDrafts({
      doc,
      fullState: true,
      ignore: () => false,
      key,
      limitBytes: 1024 * 1024,
      lineage: 'source:text:epoch:1',
    });
    doc.getText('source').insert(0, 'one');
    await recorder.flush();
    doc.getText('source').insert(3, ' two');
    await recorder.flush();
    const rows = await readDrafts(key);
    expect(rows).toHaveLength(1);
    const restored = new Y.Doc();
    applyDrafts(restored, rows, 'restore');
    expect(restored.getText('source').toString()).toBe('one two');
  });
});
