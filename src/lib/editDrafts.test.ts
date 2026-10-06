import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

// The sweep reports what it drops (edit_incidents) through the API client.
const post = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/api/client', async (load) => ({
  ...(await load<typeof import('@/api/client')>()),
  api: { post },
}));

import {
  applyDrafts,
  deleteDocumentDrafts,
  deleteDrafts,
  draftBytes,
  draftGroups,
  dropLostDrafts,
  type EditDraft,
  markDraftsReported,
  openRecoveryBase,
  putDrafts,
  readDraftBase,
  readDrafts,
  recordDrafts,
  recoveryDocument,
  reportRecoveryGroup,
  sameSourceLineage,
  sweepDrafts,
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

  it('keeps a source base once, until its last row goes', async () => {
    const key = 'u_1:file:base';
    const bytes = new Uint8Array([1, 2, 3]);
    await putDrafts(
      [draft('a', { base: 'sha', key }), draft('b', { base: 'sha', key })],
      bytes
    );
    await deleteDrafts([{ id: 'a', key, seq: 1 }]);
    expect(await readDraftBase(key, 'sha')).toEqual(bytes);
    await deleteDrafts([{ id: 'b', key, seq: 1 }]);
    expect(await readDraftBase(key, 'sha')).toBeUndefined();
  });

  it('sweeps the documents an account no longer has', async () => {
    await putDrafts([
      draft('kept', { key: 'u_sweep:material:kept' }),
      draft('gone', { data: new Uint8Array(5), key: 'u_sweep:file:gone' }),
      draft('other', { key: 'u_other:file:gone' }),
    ]);
    const checked: string[] = [];
    post.mockClear();
    await sweepDrafts('u_sweep', async (kind, id) => {
      checked.push(`${kind}:${id}`);
      return id === 'gone' ? 'not_found' : null;
    });
    expect(checked.sort()).toEqual(['file:gone', 'material:kept']);
    expect(await readDrafts('u_sweep:file:gone')).toEqual([]);
    // Rows deleted after a 404 are a discard the browser alone sees.
    expect(post).toHaveBeenCalledExactlyOnceWith('/edit-incidents', {
      fileId: 'gone',
      fileKind: 'source_file',
      kind: 'discard_unsaved',
      reason: 'not_found',
      sizeBytes: 5,
    });
    expect(await readDrafts('u_sweep:material:kept')).toHaveLength(1);
    // Another account's rows are never checked.
    expect(await readDrafts('u_other:file:gone')).toHaveLength(1);
  });

  it('keeps a recovery group whose base read failed, and drops one whose base is gone', async () => {
    const key = 'u_1:file:base';
    const base = new Uint8Array([1, 2, 3]);
    const lineage = 'source:f_1:epoch:1@sha_1';
    await putDrafts(
      [
        draft('based', {
          base: 'sha_1',
          data: new Uint8Array(2),
          key,
          lineage,
        }),
      ],
      base
    );
    const group = await readDrafts(key);
    const report = vi.fn();
    // The read fails (a storage hiccup) while a delete would succeed: the
    // group stays for the next open, and the failure is reported once.
    const get = vi
      .spyOn(IDBObjectStore.prototype, 'get')
      .mockImplementation(() => {
        throw new DOMException('busy', 'UnknownError');
      });
    expect(await openRecoveryBase(group, report)).toBe('kept');
    expect(await openRecoveryBase(group, report)).toBe('kept');
    get.mockRestore();
    expect(report).toHaveBeenCalledExactlyOnceWith(
      'draft_storage_failed',
      'write',
      2
    );
    expect(await readDrafts(key)).toHaveLength(1);
    expect(await openRecoveryBase(group, report)).toEqual(base);
    // A base this device never stored: the group is dropped and reported.
    report.mockClear();
    const gone = draft('gone', { base: 'sha_gone', key, lineage });
    await putDrafts([gone]);
    expect(await openRecoveryBase([gone], report)).toBe('dropped');
    expect(report).toHaveBeenCalledExactlyOnceWith(
      'draft_unrestorable',
      'base_missing',
      0
    );
    expect((await readDrafts(key)).map((row) => row.id)).toEqual(['based']);
  });

  it('counts only the lost rows another report does not have', async () => {
    const key = 'u_1:file:counted';
    await putDrafts([
      draft('same', { data: new Uint8Array(4), key, lineage: 'room:1' }),
      draft('other', { data: new Uint8Array(6), key, lineage: 'room:0' }),
    ]);
    const report = vi.fn();
    await dropLostDrafts(
      key,
      'forbidden',
      report,
      (row) => row.lineage !== 'room:1'
    );
    expect(report).toHaveBeenCalledExactlyOnceWith(
      'discard_unsaved',
      'forbidden',
      6
    );
    expect(await readDrafts(key)).toEqual([]);
  });

  it('reports lost drafts with their bytes, and nothing when there were none', async () => {
    const key = 'u_1:file:lost';
    await putDrafts([
      draft('lost_a', { data: new Uint8Array(3), key }),
      draft('lost_b', { data: new Uint8Array(4), key }),
    ]);
    const report = vi.fn();
    await dropLostDrafts(key, 'forbidden', report);
    expect(report).toHaveBeenCalledExactlyOnceWith(
      'discard_unsaved',
      'forbidden',
      7
    );
    expect(await readDrafts(key)).toEqual([]);
    await dropLostDrafts(key, 'forbidden', report);
    expect(report).toHaveBeenCalledOnce();
  });

  it('reports a group of another lineage once, whatever reopens it', async () => {
    const key = 'u_1:material:moved';
    const lineage = 'material:mat_1:schema:0';
    await putDrafts([
      draft('moved_1', { data: new Uint8Array(2), key, lineage }),
      draft('moved_2', { data: new Uint8Array(3), key, lineage }),
    ]);
    const report = vi.fn();
    const group = () =>
      readDrafts(key).then((rows) => draftGroups(rows, ROOM).recovery);
    reportRecoveryGroup(await group(), report);
    expect(report).toHaveBeenCalledExactlyOnceWith(
      'other_epoch_draft',
      'reopen',
      5
    );
    // The mark is stored with the rows: a later page load (a fresh group
    // under another first id) reports nothing.
    const reopened = await group();
    expect(reopened.every((row) => row.reported)).toBe(true);
    reportRecoveryGroup(
      reopened.map((row) => ({ ...row, id: `${row.id}:next-load` })),
      report
    );
    expect(report).toHaveBeenCalledOnce();
    // A refused group was recorded by the service.
    reportRecoveryGroup(
      [draft('refused', { key, lineage: ROOM, refused: true })],
      report
    );
    expect(report).toHaveBeenCalledOnce();
  });

  it('upgrades a version 1 database, keeping its drafts', async () => {
    await new Promise((resolve) => {
      indexedDB.deleteDatabase('capy-edit-drafts').onsuccess = resolve;
    });
    // As an earlier build created it: no `meta` store.
    await new Promise<void>((resolve, reject) => {
      const opening = indexedDB.open('capy-edit-drafts', 1);
      opening.onupgradeneeded = () => {
        const drafts = opening.result.createObjectStore('drafts', {
          keyPath: 'id',
        });
        drafts.createIndex('key', 'key');
        drafts.createIndex('base', ['key', 'base']);
        opening.result.createObjectStore('bases');
        drafts.put(draft('kept', { key: 'u_v1:material:m' }));
      };
      opening.onsuccess = () => {
        opening.result.close();
        resolve();
      };
      opening.onerror = () => reject(opening.error);
    });
    vi.resetModules();
    const fresh = await import('./editDrafts');
    expect(
      (await fresh.readDrafts('u_v1:material:m')).map((row) => row.id)
    ).toEqual(['kept']);
  });

  it('copies the old source drafts over once for good and deletes their database', async () => {
    const state = new Uint8Array([7]);
    const base = new Uint8Array([9]);
    // As an old tab writes it (and may recreate it after the copy).
    const writeOld = (id: string) =>
      new Promise<void>((resolve, reject) => {
        const opening = indexedDB.open('capy-source-drafts', 3);
        opening.onupgradeneeded = () => {
          const database = opening.result;
          database.createObjectStore('sessionDrafts', { keyPath: 'id' });
          database.createObjectStore('bases');
        };
        opening.onsuccess = () => {
          const database = opening.result;
          const transaction = database.transaction(
            ['sessionDrafts', 'bases'],
            'readwrite'
          );
          transaction.objectStore('sessionDrafts').put({
            baseSourceSHA256: 'sha',
            epoch: 4,
            fileId: 'u_old:f_old',
            id,
            refused: true,
            state,
            version: 'v',
          });
          transaction.objectStore('bases').put(base, ['u_old:f_old', 'sha']);
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      });
    const reload = async () => {
      vi.resetModules();
      return import('./editDrafts');
    };
    // A browser that never ran the new store (no marker yet).
    await new Promise((resolve) => {
      indexedDB.deleteDatabase('capy-edit-drafts').onsuccess = resolve;
    });
    await writeOld('old-session');
    let fresh = await reload();
    const [row] = await fresh.readDrafts('u_old:file:f_old');
    expect(row).toMatchObject({
      base: 'sha',
      data: state,
      kind: 'state',
      lineage: 'source:f_old:epoch:4@sha',
      refused: true,
    });
    expect(await fresh.readDraftBase('u_old:file:f_old', 'sha')).toEqual(base);
    await expect
      .poll(async () =>
        (await indexedDB.databases()).map((entry) => entry.name)
      )
      .not.toContain('capy-source-drafts');
    // An old tab recreates it later: never copied again.
    await writeOld('later-session');
    fresh = await reload();
    expect(
      (await fresh.readDrafts('u_old:file:f_old')).map((entry) => entry.session)
    ).toEqual(['old-session']);
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

  it('keeps same-epoch text drafts current across published base hashes', () => {
    const text = sameSourceLineage('text');
    const rows = [
      draft('old-hash', { lineage: 'source:t:epoch:2@old' }),
      draft('older-epoch', { lineage: 'source:t:epoch:1@old' }),
    ];
    const opened = draftGroups(rows, 'source:t:epoch:2@new', text);
    expect(opened.current.map((row) => row.id)).toEqual(['old-hash']);
    expect(opened.recovery.map((row) => row.id)).toEqual(['older-epoch']);
    // Office compares the base too.
    expect(
      draftGroups(
        rows,
        'source:t:epoch:2@new',
        sameSourceLineage('docx')
      ).recovery.map((row) => row.id)
    ).toEqual(['old-hash']);
  });

  it('cannot draw update rows whose base was never stored', () => {
    const { client } = syncedClient('base');
    let update: Uint8Array = new Uint8Array();
    client.on('update', (next: Uint8Array) => {
      update = next;
    });
    client.getText('content').insert(4, ' typed');
    expect(recoveryDocument([draft('typed', { data: update })])).toBeNull();
    const whole = recoveryDocument([
      draft('state', { data: Y.encodeStateAsUpdate(client), kind: 'state' }),
    ]);
    expect(whole?.getText('content').toString()).toBe('base typed');
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

  it('reports the offline byte bound, stores nothing past it, and lifts it on reconnect', async () => {
    const key = 'u_1:material:limit';
    const onLimit = vi.fn();
    const report = vi.fn();
    const { client } = syncedClient('');
    const recorder = recordDrafts({
      doc: client,
      ignore: (origin) => origin === REMOTE,
      key,
      limitBytes: 64,
      lineage: ROOM,
      onLimit,
      report,
    });
    // Online, the server enforces the real limits.
    client.getText('content').insert(0, 'x'.repeat(100));
    expect(onLimit).not.toHaveBeenCalled();
    recorder.disconnected();
    expect(onLimit).toHaveBeenLastCalledWith(true);
    await recorder.flush();
    // Past the bound nothing more is stored: what was held stays.
    client.getText('content').insert(0, 'y');
    await recorder.flush();
    const text = new Y.Doc();
    applyDrafts(text, await readDrafts(key), 'restore');
    expect(text.getText('content').toString()).toBe('x'.repeat(100));
    expect(report).not.toHaveBeenCalled();
    recorder.connected();
    expect(onLimit).toHaveBeenLastCalledWith(false);
    // The episode is reported once it is over, with what the device held.
    expect(report).toHaveBeenCalledExactlyOnceWith(
      'offline_episode',
      'unreachable',
      recorder.unsavedBytes
    );
    expect(recorder.unsavedBytes).toBeGreaterThan(100);
    recorder.connected();
    expect(report).toHaveBeenCalledOnce();
  });

  it('reports a storage failure and its recovery, and keeps editing', async () => {
    const key = 'u_1:material:storage';
    const onStorage = vi.fn();
    const report = vi.fn();
    const { client } = syncedClient('');
    const recorder = recordDrafts({
      doc: client,
      ignore: (origin) => origin === REMOTE,
      key,
      limitBytes: 1024 * 1024,
      lineage: ROOM,
      onStorage,
      report,
    });
    const put = vi
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementation(() => {
        throw new DOMException('full', 'QuotaExceededError');
      });
    client.getText('content').insert(0, 'a');
    await recorder.flush();
    expect(onStorage).toHaveBeenLastCalledWith(false);
    expect(report).toHaveBeenCalledExactlyOnceWith(
      'draft_storage_failed',
      'quota',
      expect.any(Number)
    );
    put.mockRestore();
    client.getText('content').insert(1, 'b');
    await recorder.flush();
    expect(onStorage).toHaveBeenLastCalledWith(true);
    // The write after the failure held the whole document, so nothing the
    // failed one lost is missing.
    const rows = await readDrafts(key);
    expect(rows.map((row) => row.kind).sort()).toEqual(['state', 'update']);
    const restored = new Y.Doc();
    applyDrafts(restored, rows, 'restore');
    expect(restored.getText('content').toString()).toBe('ab');
  });

  it('holds a storage failure made offline until the room is back', async () => {
    const key = 'u_1:material:offline-storage';
    const report = vi.fn();
    const { client } = syncedClient('');
    const recorder = recordDrafts({
      doc: client,
      ignore: (origin) => origin === REMOTE,
      key,
      limitBytes: 1024 * 1024,
      lineage: ROOM,
      report,
    });
    recorder.disconnected();
    const put = vi
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementation(() => {
        throw new DOMException('full', 'QuotaExceededError');
      });
    client.getText('content').insert(0, 'offline');
    await recorder.flush();
    put.mockRestore();
    // Sent offline, the report would only fail.
    expect(report).not.toHaveBeenCalled();
    recorder.connected();
    expect(report.mock.calls.map(([kind, reason]) => [kind, reason])).toEqual([
      ['draft_storage_failed', 'quota'],
      ['offline_episode', 'unreachable'],
    ]);
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

  // The live path of a source whose file moved on (useSourceSession's
  // `replace`): flush, report, then mark the lineage's rows.
  const SOURCE = 'source:f_1:epoch:1@sha';
  const MOVED = 'source:f_1:epoch:2@sha';
  async function oldState(key: string, text: string) {
    const doc = new Y.Doc();
    doc.getText('source').insert(0, text);
    const data = Y.encodeStateAsUpdate(doc);
    await putDrafts([
      draft(`${key}:old:state`, { data, key, kind: 'state', lineage: SOURCE }),
    ]);
    return readDrafts(key);
  }

  it('marks an adopted-only session reported and counts its bytes', async () => {
    const key = 'u_1:file:adopted';
    const adopted = await oldState(key, 'kept from the last visit');
    const doc = new Y.Doc();
    applyDrafts(doc, adopted, 'restore');
    const recorder = recordDrafts({
      adopted,
      doc,
      fullState: true,
      ignore: (origin) => origin === 'restore',
      key,
      limitBytes: 1024 * 1024,
      lineage: SOURCE,
    });
    // Nothing typed: the flush writes nothing, the adopted rows still count.
    void recorder.flush();
    expect(recorder.unsavedBytes).toBe(draftBytes(adopted));
    await markDraftsReported(key, (row) => row.lineage === SOURCE);
    const report = vi.fn();
    reportRecoveryGroup(
      draftGroups(await readDrafts(key), MOVED).recovery,
      report
    );
    expect(report).not.toHaveBeenCalled();
  });

  it('reports a new episode over rows a kept epoch left marked', async () => {
    const key = 'u_1:file:paused';
    await oldState(key, 'marked during a pause');
    await markDraftsReported(key, () => true);
    // The pause ended without a new epoch: the next open adopts the marked
    // rows as current, types, and closes before a receipt.
    const adopted = draftGroups(await readDrafts(key), SOURCE).current;
    const doc = new Y.Doc();
    applyDrafts(doc, adopted, 'restore');
    const recorder = recordDrafts({
      adopted,
      doc,
      fullState: true,
      ignore: (origin) => origin === 'restore',
      key,
      limitBytes: 1024 * 1024,
      lineage: SOURCE,
    });
    doc.getText('source').insert(0, 'new ');
    await recorder.dispose();
    // The file then moves on: the group holds a marked and a new row.
    const group = draftGroups(await readDrafts(key), MOVED).recovery;
    expect(group.map((row) => !!row.reported).sort()).toEqual([false, true]);
    const report = vi.fn();
    reportRecoveryGroup(group, report);
    expect(report).toHaveBeenCalledExactlyOnceWith(
      'other_epoch_draft',
      'reopen',
      draftBytes(group)
    );
  });
});
