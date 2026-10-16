import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ApiError } from '@/api/client';
import { CLIENT_PROTOCOL } from '@/features/collaboration/protocol';
import type { DraftMessage, DraftReply } from './draftStore';

// The drafts worker, run in this process: messages are copied as
// postMessage copies them, and each worker loads its own store module (a
// fresh one after vi.resetModules, like a new page).
class InProcessWorker {
  static started: InProcessWorker[] = [];
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: DraftReply }) => void) | null = null;
  store = import('./draftStore');
  terminated = false;
  // The documents this worker was asked about.
  keys = new Set<string>();
  constructor() {
    InProcessWorker.started.push(this);
  }
  postMessage(message: DraftMessage) {
    const copy = structuredClone(message);
    if ('key' in copy) this.keys.add(copy.key);
    if (copy.op === 'append') this.keys.add(copy.row.key);
    void this.store.then(({ handleDraftMessage }) =>
      handleDraftMessage(copy, (answer) => {
        if (!this.terminated)
          this.onmessage?.({ data: structuredClone(answer) });
      })
    );
  }
  terminate() {
    this.terminated = true;
  }
}
vi.stubGlobal('Worker', InProcessWorker);

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
  openRecoveryGroup,
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
    // Each document's token, as its editor asks for it; a viewer's is read.
    await sweepDrafts('u_sweep', {
      post: async (path) => {
        checked.push(path);
        if (path.includes('gone')) throw new ApiError(404, 'Not Found');
        return { access: 'read', room: ROOM, token: 't', url: 'ws://c' };
      },
    });
    expect(checked.sort()).toEqual([
      '/files/gone/collaboration-token',
      '/materials/kept/collaboration-token',
    ]);
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

  it('keeps a recovery group whose base read failed, and drops one nothing can draw', async () => {
    const key = 'u_1:file:base';
    const base = new Uint8Array([1, 2, 3]);
    const lineage = 'source:f_1:epoch:1@sha_1';
    const { client } = syncedClient('kept in recovery');
    const state = Y.encodeStateAsUpdate(client);
    await putDrafts(
      [
        draft('based', {
          base: 'sha_1',
          data: state,
          key,
          kind: 'state',
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
    expect(await openRecoveryGroup(group, report, {})).toBe('kept');
    expect(await openRecoveryGroup(group, report, {})).toBe('kept');
    get.mockRestore();
    expect(report).toHaveBeenCalledExactlyOnceWith(
      'draft_storage_failed',
      'write',
      state.length
    );
    expect(await readDrafts(key)).toHaveLength(1);
    const opened = await openRecoveryGroup(group, report, {});
    expect(opened).toMatchObject({ base });
    expect(
      typeof opened === 'object' && opened.doc.getText('content').toString()
    ).toBe('kept in recovery');
    // A base this device never stored: the group is dropped and reported.
    report.mockClear();
    const gone = draft('gone', { base: 'sha_gone', key, lineage });
    await putDrafts([gone]);
    expect(await openRecoveryGroup([gone], report, {})).toBe('dropped');
    expect(report).toHaveBeenCalledExactlyOnceWith(
      'draft_unrestorable',
      'base_missing',
      0
    );
    // Updates without the whole state they grew from (a tab closed online,
    // then the file moved on): the base is there, the document is not.
    report.mockClear();
    let typed: Uint8Array = new Uint8Array();
    client.on('update', (update: Uint8Array) => {
      typed = update;
    });
    client.getText('content').insert(0, 'typed ');
    const orphan = draft('orphan', {
      base: 'sha_1',
      data: typed,
      key,
      lineage: 'source:f_1:epoch:0@sha_1',
    });
    await putDrafts([orphan]);
    expect(await openRecoveryGroup([orphan], report, {})).toBe('dropped');
    expect(report).toHaveBeenCalledExactlyOnceWith(
      'draft_unrestorable',
      'base_missing',
      typed.length
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

  it('fails a request whose database open is blocked instead of waiting for it', async () => {
    await new Promise((resolve) => {
      indexedDB.deleteDatabase('capy-edit-drafts').onsuccess = resolve;
    });
    // A tab of an older build holds version 1 open and ignores the upgrade.
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('capy-edit-drafts', 1);
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    old.onversionchange = () => undefined;
    vi.resetModules();
    const fresh = await import('./editDrafts');
    await expect(fresh.readDrafts('u_blocked:material:m')).rejects.toThrow();
    // Every request meanwhile fails at once, behind the same open.
    await expect(fresh.readDrafts('u_blocked:material:m')).rejects.toThrow();
    // Once it lets go, the waiting open goes through and requests work.
    old.close();
    await vi.waitFor(async () =>
      expect(await fresh.readDrafts('u_blocked:material:m')).toEqual([])
    );
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

describe('the drafts worker failing', () => {
  it('tells sessions their writes were lost and starts a new worker after one that ran', async () => {
    const key = 'u_1:material:worker-error';
    const onStorage = vi.fn();
    const report = vi.fn();
    const { client } = noteRecorder(key, 'a', { onStorage, report });
    await readDrafts(key);
    const running = InProcessWorker.started.find((started) =>
      started.keys.has(key)
    )!;
    client.getText('content').insert(1, 'b');
    // An exception inside the worker after appends were posted.
    running.onerror?.(new Event('error'));
    expect(onStorage).toHaveBeenLastCalledWith(false);
    expect(report).toHaveBeenCalledWith(
      'draft_storage_failed',
      'write',
      expect.any(Number)
    );
    expect(running.terminated).toBe(true);
    // A new worker takes the next request, and the retried whole document
    // holds what the lost appends held.
    await vi.waitFor(async () => {
      const rows = await readDrafts(key);
      expect(rows.some((row) => row.kind === 'state')).toBe(true);
    });
    expect(
      InProcessWorker.started.filter((started) => started.keys.has(key))
    ).toHaveLength(2);
    expect(onStorage).toHaveBeenLastCalledWith(true);
  });

  it('fails every request at once, without starting again, when the worker never started', async () => {
    let starts = 0;
    vi.stubGlobal(
      'Worker',
      class {
        onerror: ((event: Event) => void) | null = null;
        constructor() {
          starts++;
          queueMicrotask(() => this.onerror?.(new Event('error')));
        }
        postMessage() {}
        terminate() {}
      }
    );
    try {
      vi.resetModules();
      const fresh = await import('./editDrafts');
      await expect(
        fresh.readDrafts('u_1:material:no-worker')
      ).rejects.toThrow();
      await expect(
        fresh.readDrafts('u_1:material:no-worker')
      ).rejects.toThrow();
      expect(starts).toBe(1);
    } finally {
      vi.stubGlobal('Worker', InProcessWorker);
    }
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

/** A recorder on a client synced to a room, as the note editor sets one up. */
function noteRecorder(
  key: string,
  text: string,
  options: Partial<Parameters<typeof recordDrafts>[0]> = {}
) {
  const { client, room } = syncedClient(text);
  const recorder = recordDrafts({
    doc: client,
    ignore: (origin) => origin === REMOTE,
    key,
    limitBytes: 1024 * 1024,
    lineage: ROOM,
    ...options,
  });
  return { client, recorder, room };
}

describe('recording a note session', () => {
  it('keeps offline edits across a reload and syncs them into the same room', async () => {
    const key = 'u_1:material:reload';
    const { client, recorder, room } = noteRecorder(key, 'shared ');
    // A remote update is the room's own: never recorded.
    Y.applyUpdate(client, Y.encodeStateAsUpdate(room), REMOTE);
    expect(recorder.sequence).toBe(0);
    recorder.disconnected();
    client.getText('content').insert(7, 'offline');
    expect(recorder.sequence).toBe(1);
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

  it('writes each local update as it happens, so a killed tab loses none', async () => {
    const key = 'u_1:material:killed';
    const { client, room } = noteRecorder(key, 'base ');
    const typed = 'every key counts';
    for (const [index, character] of [...typed].entries())
      client.getText('content').insert(5 + index, character);
    // No unmount, no pagehide: the tab is gone, and what it posted is all
    // there is.
    const rows = await readDrafts(key);
    expect(rows.every((row) => row.kind === 'update')).toBe(true);
    expect(rows.map((row) => row.seq).sort((a, b) => a - b)).toEqual(
      [...typed].map((_, index) => index + 1)
    );
    const reopened = new Y.Doc();
    applyDrafts(reopened, rows, 'restore');
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(room), REMOTE);
    expect(reopened.getText('content').toString()).toBe(`base ${typed}`);
  });

  it('merges a long session into a row per run, still exact after receipts', async () => {
    const key = 'u_1:material:long';
    const { client, recorder } = noteRecorder(key, 'base ');
    const text = client.getText('content');
    const type = (count: number) => {
      for (let index = 0; index < count; index++)
        text.insert(text.length, String.fromCharCode(97 + (index % 26)));
    };
    type(100);
    // What the room holds when the receipt for edit 100 comes.
    const saved = Y.encodeStateAsUpdate(client);
    type(50);
    // 64 + 64 merged, 22 still one row each.
    let rows = await readDrafts(key);
    expect(rows).toHaveLength(2 + 22);
    expect(
      rows.filter((row) => row.seq === 64 || row.seq === 128)
    ).toHaveLength(2);
    // A receipt in the middle of a run keeps the run's row (it holds newer
    // edits too); one past it deletes it.
    await recorder.covered(100);
    rows = await readDrafts(key);
    expect(rows.map((row) => row.seq).sort((a, b) => a - b)[0]).toBe(128);
    type(10);
    rows = await readDrafts(key);
    const reopened = new Y.Doc();
    applyDrafts(reopened, rows, 'restore');
    Y.applyUpdate(reopened, saved, REMOTE);
    expect(reopened.getText('content').toString()).toBe(text.toString());
    await recorder.covered(recorder.sequence);
    expect(await readDrafts(key)).toEqual([]);
  });

  it('restores online edits without a base once the room sync brings it', async () => {
    const key = 'u_1:material:online';
    const { client, room } = noteRecorder(key, 'base ');
    client.getText('content').insert(5, 'typed');
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
    const { client, recorder } = noteRecorder(key, 'a');
    recorder.disconnected();
    client.getText('content').insert(1, 'b');
    const requested = recorder.sequence;
    client.getText('content').insert(2, 'c');
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

  it('keeps two tabs apart: a receipt deletes only its own rows', async () => {
    const key = 'u_1:material:tabs';
    const { client: first, recorder: one, room } = noteRecorder(key, 'x');
    const second = new Y.Doc();
    Y.applyUpdate(second, Y.encodeStateAsUpdate(room), REMOTE);
    const two = recordDrafts({
      doc: second,
      ignore: (origin) => origin === REMOTE,
      key,
      limitBytes: 1024 * 1024,
      lineage: ROOM,
    });
    first.getText('content').insert(1, ' one');
    second.getText('content').insert(1, ' two');
    await one.covered(one.sequence);
    const left = await readDrafts(key);
    expect(new Set(left.map((row) => row.session))).toEqual(
      new Set([two.session])
    );
    // The other tab's edits still reach the room from its rows.
    const reopened = new Y.Doc();
    applyDrafts(reopened, left, 'restore');
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(room), REMOTE);
    expect(reopened.getText('content').toString()).toBe('x two');
    await two.covered(two.sequence);
    expect(await readDrafts(key)).toEqual([]);
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

  it('writes the whole document at unmount only when unsaved work outgrew it', async () => {
    const key = 'u_1:material:unmount';
    const { client, recorder } = noteRecorder(key, 'a');
    client.getText('content').insert(1, 'b');
    await recorder.covered(recorder.sequence);
    // Saved: nothing to keep.
    await recorder.dispose();
    expect(await readDrafts(key)).toEqual([]);
    const next = noteRecorder(key, 'a');
    next.client.getText('content').insert(1, 'c');
    await next.recorder.dispose();
    const rows = await readDrafts(key);
    expect(rows.map((row) => [row.kind, row.seq])).toEqual([
      ['update', 1],
      ['state', 1],
    ]);
    expect(recoveryDocument(rows)?.getText('content').toString()).toBe('ac');
  });

  it('reports the offline byte bound, stores nothing past it, and lifts it on reconnect', async () => {
    const key = 'u_1:material:limit';
    const onLimit = vi.fn();
    const report = vi.fn();
    const { client, recorder } = noteRecorder(key, '', {
      limitBytes: 64,
      onLimit,
      report,
    });
    // Online, the server enforces the real limits.
    client.getText('content').insert(0, 'x'.repeat(100));
    expect(onLimit).not.toHaveBeenCalled();
    recorder.disconnected();
    expect(onLimit).toHaveBeenLastCalledWith(true);
    // Past the bound nothing more is stored: what was held stays, with the
    // whole note the update rows need as their base.
    client.getText('content').insert(0, 'y');
    const rows = await readDrafts(key);
    expect(rows.filter((row) => row.kind === 'state')).toHaveLength(1);
    const text = new Y.Doc();
    applyDrafts(text, rows, 'restore');
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

  it('retries the whole document at most every 5 s while storage keeps failing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const key = 'u_1:material:storm';
    const onStorage = vi.fn();
    const { client } = noteRecorder(key, 'a', { onStorage });
    const put = vi
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementation(() => {
        throw new DOMException('full', 'QuotaExceededError');
      });
    const wholeTries = () =>
      put.mock.calls.filter(([row]) => (row as EditDraft).kind === 'state')
        .length;
    try {
      for (let index = 0; index < 20; index++) {
        client.getText('content').insert(1, 'x');
        await readDrafts(key);
        await vi.advanceTimersByTimeAsync(100);
      }
      await readDrafts(key);
      // Typing for 2 s: one whole document, not one per key.
      expect(wholeTries()).toBe(1);
      await vi.advanceTimersByTimeAsync(2900);
      await readDrafts(key);
      expect(wholeTries()).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      await readDrafts(key);
      expect(wholeTries()).toBe(2);
      // Storage works again: the next retry lands with everything.
      put.mockRestore();
      await vi.advanceTimersByTimeAsync(5000);
      const rows = await readDrafts(key);
      expect(onStorage).toHaveBeenLastCalledWith(true);
      const restored = new Y.Doc();
      applyDrafts(restored, rows, 'restore');
      expect(restored.getText('content').toString()).toBe(
        client.getText('content').toString()
      );
    } finally {
      put.mockRestore();
      vi.useRealTimers();
    }
  });

  it('retries nothing while storage fails if receipts covered every edit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const key = 'u_1:material:saved-failing';
    const onStorage = vi.fn();
    const report = vi.fn();
    const { client, recorder } = noteRecorder(key, 'a', { onStorage, report });
    const put = vi
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementation(() => {
        throw new DOMException('full', 'QuotaExceededError');
      });
    const wholeTries = () =>
      put.mock.calls.filter(([row]) => (row as EditDraft).kind === 'state')
        .length;
    try {
      // Three typing pauses, each saved; the receipts' deletes go through.
      for (const typed of ['b', 'c', 'd']) {
        client.getText('content').insert(1, typed);
        // The failed append is answered before the receipt comes.
        await readDrafts(key);
        await recorder.covered(recorder.sequence);
        await readDrafts(key);
        await vi.advanceTimersByTimeAsync(5000);
      }
      // Idle for 30 s with the store failing: nothing is unsaved.
      for (let second = 0; second < 30; second += 5) {
        await vi.advanceTimersByTimeAsync(5000);
        await readDrafts(key);
      }
      expect(wholeTries()).toBe(0);
      // The store still fails: one report, and it never reads as working.
      expect(onStorage).toHaveBeenCalledExactlyOnceWith(false);
      expect(report).toHaveBeenCalledExactlyOnceWith(
        'draft_storage_failed',
        'quota',
        expect.any(Number)
      );
      // Storage works again: no row of saved content is left behind.
      put.mockRestore();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await readDrafts(key)).toEqual([]);
    } finally {
      put.mockRestore();
      vi.useRealTimers();
    }
  });

  it('reports a storage failure and its recovery, and keeps editing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const key = 'u_1:material:storage';
    const onStorage = vi.fn();
    const report = vi.fn();
    const { client } = noteRecorder(key, '', { onStorage, report });
    const put = vi
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementation(() => {
        throw new DOMException('full', 'QuotaExceededError');
      });
    try {
      client.getText('content').insert(0, 'a');
      // Answered after the failed append.
      await readDrafts(key);
      expect(onStorage).toHaveBeenLastCalledWith(false);
      expect(report).toHaveBeenCalledExactlyOnceWith(
        'draft_storage_failed',
        'quota',
        expect.any(Number)
      );
      // The whole-document retry runs at once and fails too.
      await vi.advanceTimersByTimeAsync(0);
      await readDrafts(key);
      put.mockRestore();
      client.getText('content').insert(1, 'b');
      // Editing goes on; the next retry, 5 s after the last, holds the
      // whole document, so nothing the failed writes lost is missing.
      await vi.advanceTimersByTimeAsync(5000);
      const rows = await readDrafts(key);
      expect(onStorage).toHaveBeenLastCalledWith(true);
      expect(rows.map((row) => row.kind).sort()).toEqual(['state', 'update']);
      const restored = new Y.Doc();
      applyDrafts(restored, rows, 'restore');
      expect(restored.getText('content').toString()).toBe('ab');
      expect(report).toHaveBeenCalledOnce();
    } finally {
      put.mockRestore();
      vi.useRealTimers();
    }
  });

  it('holds a storage failure made offline until the room is back', async () => {
    const key = 'u_1:material:offline-storage';
    const report = vi.fn();
    const { client, recorder } = noteRecorder(key, '', { report });
    recorder.disconnected();
    const put = vi
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementation(() => {
        throw new DOMException('full', 'QuotaExceededError');
      });
    client.getText('content').insert(0, 'offline');
    await readDrafts(key);
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
    const { client, recorder } = noteRecorder(key, 'kept ');
    client.getText('content').insert(5, 'refused');
    recorder.refuse();
    // Recording stopped: later typing writes nothing.
    client.getText('content').insert(0, 'x');
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
  const SOURCE = 'source:f_1:epoch:1@sha';
  const MOVED = 'source:f_1:epoch:2@sha';

  /** An Office-like session: the base bytes beside the rows, the bound on
   * the whole state. */
  function sourceRecorder(
    key: string,
    text: string,
    options: Partial<Parameters<typeof recordDrafts>[0]> = {}
  ) {
    const doc = new Y.Doc();
    doc.getText('source').insert(0, text);
    const recorder = recordDrafts({
      base: { bytes: new Uint8Array([7]), sha: 'sha' },
      doc,
      ignore: (origin) => origin === 'restore',
      key,
      limitBytes: 1024 * 1024,
      limitsState: true,
      lineage: SOURCE,
      ...options,
    });
    return { doc, recorder };
  }
  const states = async (key: string) =>
    (await readDrafts(key))
      .filter((row) => row.kind === 'state')
      .map((row) => row.seq);

  it('appends each update and writes the whole state once per offline episode and at unmount', async () => {
    const key = 'u_1:file:episodes';
    const { doc, recorder } = sourceRecorder(key, 'one');
    const text = doc.getText('source');
    text.insert(3, ' two');
    expect(await states(key)).toEqual([]);
    recorder.disconnected();
    text.insert(7, ' three');
    text.insert(13, ' four');
    // One whole state for the episode, taken when it started.
    expect(await states(key)).toEqual([1]);
    recorder.connected();
    recorder.disconnected();
    expect(await states(key)).toEqual([3]);
    text.insert(18, ' five');
    await recorder.dispose();
    const rows = await readDrafts(key);
    expect(rows.filter((row) => row.kind === 'update')).toHaveLength(4);
    expect(await states(key)).toEqual([4]);
    expect(await readDraftBase(key, 'sha')).toEqual(new Uint8Array([7]));
    // The rows draw the document in another lineage too.
    expect(
      recoveryDocument(draftGroups(rows, MOVED).recovery)
        ?.getText('source')
        .toString()
    ).toBe('one two three four five');
  });

  it('bounds a source by what is unsaved, not by everything typed since it opened', async () => {
    const key = 'u_1:file:saved-bound';
    const onLimit = vi.fn();
    const { doc, recorder } = sourceRecorder(key, 'x'.repeat(100), {
      limitBytes: 2000,
      onLimit,
    });
    const text = doc.getText('source');
    // Twenty-five replace-alls, each saved: far more than 2000 bytes of
    // updates, none of them unsaved.
    for (let round = 0; round < 25; round++) {
      text.delete(0, text.length);
      text.insert(0, String(round).padEnd(100, 'y'));
      await recorder.covered(recorder.sequence);
    }
    recorder.disconnected();
    expect(onLimit).not.toHaveBeenCalled();
    expect(await readDrafts(key)).toEqual([]);
  });

  it('bounds offline edits by the whole state they make', async () => {
    const key = 'u_1:file:bound';
    const onLimit = vi.fn();
    const { doc, recorder } = sourceRecorder(key, 'x'.repeat(500), {
      limitBytes: 600,
      onLimit,
    });
    doc.getText('source').insert(0, 'a');
    recorder.disconnected();
    // The state (500 bytes of text and its encoding) fits; edits on top of
    // it cross the bound, though they alone are far below it.
    expect(onLimit).not.toHaveBeenCalled();
    doc.getText('source').insert(0, 'y'.repeat(120));
    expect(onLimit).toHaveBeenLastCalledWith(true);
    expect(recorder.unsavedBytes).toBeLessThan(600);
    recorder.connected();
    expect(onLimit).toHaveBeenLastCalledWith(false);
  });

  // The live path of a source whose file moved on (useSourceSession's
  // `replace`): snapshot, report, then mark the lineage's rows.
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
      ignore: (origin) => origin === 'restore',
      key,
      limitBytes: 1024 * 1024,
      limitsState: true,
      lineage: SOURCE,
    });
    // Nothing typed: the snapshot writes nothing, the adopted rows count.
    await recorder.snapshot();
    expect(recorder.unsavedBytes).toBe(draftBytes(adopted));
    await markDraftsReported(
      key,
      adopted.map((row) => row.id)
    );
    const report = vi.fn();
    reportRecoveryGroup(
      draftGroups(await readDrafts(key), MOVED).recovery,
      report
    );
    expect(report).not.toHaveBeenCalled();
  });

  it('reports a new episode over rows a kept epoch left marked', async () => {
    const key = 'u_1:file:paused';
    const marked = await oldState(key, 'marked during a pause');
    await markDraftsReported(
      key,
      marked.map((row) => row.id)
    );
    // The pause ended without a new epoch: the next open adopts the marked
    // rows as current, types, and closes before a receipt.
    const adopted = draftGroups(await readDrafts(key), SOURCE).current;
    const doc = new Y.Doc();
    applyDrafts(doc, adopted, 'restore');
    const recorder = recordDrafts({
      adopted,
      doc,
      ignore: (origin) => origin === 'restore',
      key,
      limitBytes: 1024 * 1024,
      limitsState: true,
      lineage: SOURCE,
    });
    doc.getText('source').insert(0, 'new ');
    await recorder.dispose();
    // The file then moves on: the group holds the marked row and the new
    // update and state.
    const group = draftGroups(await readDrafts(key), MOVED).recovery;
    expect(group.map((row) => !!row.reported).sort()).toEqual([
      false,
      false,
      true,
    ]);
    const report = vi.fn();
    reportRecoveryGroup(group, report);
    expect(report).toHaveBeenCalledExactlyOnceWith(
      'other_epoch_draft',
      'reopen',
      draftBytes(group)
    );
  });
});

/** Web Locks in this process: shared and exclusive modes, `ifAvailable`, and
 * requests that wait until the lock frees. */
class Locks {
  private readonly held = new Map<
    string,
    { count: number; exclusive: boolean }
  >();
  private readonly waiting: (() => void)[] = [];
  async request<T>(
    name: string,
    { ifAvailable = false, mode = 'exclusive' }: LockOptions,
    granted: (lock: Lock | null) => T
  ): Promise<Awaited<T>> {
    const free = () => {
      const lock = this.held.get(name);
      return !lock || (mode === 'shared' && !lock.exclusive);
    };
    if (!free()) {
      if (ifAvailable) return await granted(null);
      while (!free())
        await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    const lock = this.held.get(name) ?? {
      count: 0,
      exclusive: mode === 'exclusive',
    };
    lock.count++;
    this.held.set(name, lock);
    try {
      return await granted({ mode, name });
    } finally {
      if (--lock.count === 0) this.held.delete(name);
      for (const wake of this.waiting.splice(0)) wake();
    }
  }
}

/** The collaboration service's `/drafts`: each request waits for `answer`. */
const requests: { body: Uint8Array; headers: Headers; url: URL }[] = [];
const fetchDrafts = vi.fn(
  async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    requests.push({
      body: new Uint8Array(init?.body as ArrayBuffer),
      headers: new Headers(init?.headers),
      url: new URL(String(input)),
    });
    return Response.json({ type: 'checkpoint-persisted' });
  }
);
vi.stubGlobal('fetch', fetchDrafts);

function answer(status: number, refusal?: string) {
  fetchDrafts.mockImplementationOnce(async (input, init) => {
    requests.push({
      body: new Uint8Array(init?.body as ArrayBuffer),
      headers: new Headers(init?.headers),
      url: new URL(String(input)),
    });
    return Response.json({ class: refusal }, { status });
  });
}

/** A document's token endpoint, write access in `room`. */
function tokens(room: string) {
  return {
    post: vi.fn(async (_path: string) => ({
      access: 'write',
      room,
      token: 'room-token',
      url: 'wss://collab.test',
    })),
  };
}

/** Rows a closed tab left: its whole note and one update typed after it. */
async function leftRows(key: string, lineage = ROOM, base?: string) {
  const { client } = syncedClient('base');
  const state = Y.encodeStateAsUpdate(client);
  let typed: Uint8Array = new Uint8Array();
  client.once('update', (update: Uint8Array) => {
    typed = update;
  });
  client.getText('content').insert(4, ' typed');
  const session = crypto.randomUUID();
  const rows = [
    draft(`${session}:state`, {
      base,
      data: state,
      key,
      kind: 'state',
      lineage,
      session,
    }),
    draft(`${session}:2`, { base, data: typed, key, lineage, seq: 2, session }),
  ];
  await putDrafts(rows, base ? new Uint8Array([1]) : undefined);
  return rows;
}

describe('the draft sweep sending', () => {
  const locks = new Locks();
  beforeAll(() => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: locks,
    });
  });
  afterAll(() => {
    Reflect.deleteProperty(navigator, 'locks');
  });

  /** The drafts module as a later page load has it (nothing settled yet). */
  async function nextPageLoad() {
    vi.resetModules();
    return import('./editDrafts');
  }

  /** The next request waits until the returned release. */
  function held() {
    let release!: () => void;
    fetchDrafts.mockImplementationOnce(async (input, init) => {
      requests.push({
        body: new Uint8Array(init?.body as ArrayBuffer),
        headers: new Headers(init?.headers),
        url: new URL(String(input)),
      });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Response('{}');
    });
    return () => release();
  }

  it('sends the current rows with the token and deletes them after the receipt', async () => {
    const key = 'u_send:material:mat_1';
    await leftRows(key);
    const moved = draft('send-old', {
      key,
      lineage: 'material:mat_1:schema:0',
    });
    const refused = draft('send-no', { key, refused: true });
    await putDrafts([moved, refused]);
    requests.length = 0;
    const release = held();
    const sweep = sweepDrafts('u_send', tokens(ROOM));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const [sent] = requests;
    // One URL for every document: the room travels in a header.
    expect(String(sent.url)).toBe('https://collab.test/drafts');
    expect(sent.headers.get('x-capy-room')).toBe(ROOM);
    expect(sent.headers.get('authorization')).toBe('Bearer room-token');
    // One update, merged in the drafts worker, holding the closed tab's note
    // and its typing.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, sent.body);
    expect(doc.getText('content').toString()).toBe('base typed');
    // Nothing goes before the receipt.
    expect(await readDrafts(key)).toHaveLength(4);
    release();
    await sweep;
    // Another lineage and the refused row wait for the next open.
    expect((await readDrafts(key)).map((row) => row.id).sort()).toEqual([
      'send-no',
      'send-old',
    ]);
  });

  it('skips a document an editor has open, and sends it once the editor closed', async () => {
    const key = 'u_open:material:mat_1';
    await leftRows(key);
    const recorder = recordDrafts({
      doc: new Y.Doc(),
      ignore: () => false,
      key,
      limitBytes: 1024 * 1024,
      lineage: ROOM,
    });
    const api = tokens(ROOM);
    requests.length = 0;
    await sweepDrafts('u_open', api);
    expect(api.post).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    await recorder.dispose();
    await sweepDrafts('u_open', api);
    expect(requests).toHaveLength(1);
    expect(await readDrafts(key)).toEqual([]);
  });

  it('keeps the rows on no answer for the next trigger, and on a busy one for the next page load', async () => {
    const key = 'u_offline:material:mat_1';
    await leftRows(key);
    requests.length = 0;
    fetchDrafts.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await sweepDrafts('u_offline', tokens(ROOM));
    expect(await readDrafts(key)).toHaveLength(2);
    // Back online: sent again, and the service is busy.
    answer(503, 'unavailable');
    await sweepDrafts('u_offline', tokens(ROOM), { cleanup: false });
    expect(requests).toHaveLength(1);
    expect(await readDrafts(key)).toHaveLength(2);
    // Later triggers of this page load send nothing (no merge, no upload).
    await sweepDrafts('u_offline', tokens(ROOM), { cleanup: false });
    expect(requests).toHaveLength(1);
    const later = await nextPageLoad();
    await later.sweepDrafts('u_offline', tokens(ROOM));
    expect(requests).toHaveLength(2);
    expect(await readDrafts(key)).toEqual([]);
  });

  it('marks a refused group refused when it draws on its own, leaves one that does not for the editor, and sends neither again', async () => {
    const key = 'u_refused:material:mat_1';
    await leftRows(key);
    // Update rows alone need the room's note: they stay for the editor.
    const bare = 'u_refused:material:mat_2';
    const [state, typed] = await leftRows(bare);
    await deleteDrafts([state]);
    requests.length = 0;
    answer(422, 'limit');
    answer(422, 'limit');
    const api = tokens(ROOM);
    await sweepDrafts('u_refused', api);
    expect(requests).toHaveLength(2);
    expect((await readDrafts(key)).every((row) => row.refused)).toBe(true);
    expect(await readDrafts(bare)).toEqual([{ ...typed, held: true }]);
    // A later page load sends neither (and the room records no second
    // incident); the editor's next open takes both.
    const later = await nextPageLoad();
    await later.sweepDrafts('u_refused', api);
    expect(requests).toHaveLength(2);
    expect(
      later.draftGroups(await readDrafts(bare), ROOM).current
    ).toHaveLength(1);
  });

  it('leaves a group only the editor can send for its next open, without sending it again', async () => {
    const keys = ['too_large', 'unheld', 'lineage'].map(
      (_, index) => `u_waits:material:mat_${index}`
    );
    for (const key of keys) await leftRows(key);
    // A note's draft past the 4 MiB sync cap is not even uploaded.
    const big = 'u_waits:material:mat_big';
    const doc = new Y.Doc();
    let update: Uint8Array = new Uint8Array();
    doc.once('update', (bytes: Uint8Array) => {
      update = bytes;
    });
    doc.getText('content').insert(0, 'x'.repeat(4 * 1024 * 1024 + 1));
    await putDrafts([
      draft(`big-${crypto.randomUUID()}`, { data: update, key: big }),
    ]);
    requests.length = 0;
    answer(413, 'too_large');
    answer(409, 'unheld');
    answer(409, 'lineage');
    await sweepDrafts('u_waits', tokens(ROOM));
    expect(requests).toHaveLength(3);
    for (const key of [...keys, big])
      expect((await readDrafts(key)).every((row) => row.held)).toBe(true);
    const later = await nextPageLoad();
    await later.sweepDrafts('u_waits', tokens(ROOM));
    expect(requests).toHaveLength(3);
  });

  it("sends a quiz's keys with the keys token, and a file's rows one request per base", async () => {
    const quiz = 'u_items:material:q_1:keys';
    const keysRoom = 'keys:q_1:schema:1';
    await leftRows(quiz, keysRoom);
    const file = 'u_items:file:f_1';
    const fileRoom = 'source:f_1:epoch:2';
    await leftRows(file, `${fileRoom}@sha_a`, 'sha_a');
    await leftRows(file, `${fileRoom}@sha_b`, 'sha_b');
    const asked: unknown[] = [];
    const api = {
      post: vi.fn(async (path: string, body: unknown) => {
        asked.push([path, body]);
        return {
          access: 'write',
          room: path.startsWith('/files/')
            ? fileRoom
            : (body as { document?: string }).document === 'keys'
              ? keysRoom
              : 'material:q_1:schema:1',
          token: 'room-token',
          url: 'ws://collab.test',
        };
      }),
    };
    requests.length = 0;
    await sweepDrafts('u_items', api);
    // The quiz settles its keys' fate first, then the keys token sends them.
    expect(asked).toEqual([
      ['/files/f_1/collaboration-token', {}],
      ['/materials/q_1/collaboration-token', {}],
      ['/materials/q_1/collaboration-token', { document: 'keys' }],
    ]);
    expect(requests.map((sent) => sent.headers.get('x-capy-room'))).toEqual([
      fileRoom,
      fileRoom,
      keysRoom,
    ]);
    expect(
      requests
        .slice(0, 2)
        .map((sent) => sent.headers.get('x-capy-base'))
        .sort()
    ).toEqual(['sha_a', 'sha_b']);
    expect(await readDrafts(quiz)).toEqual([]);
    expect(await readDrafts(file)).toEqual([]);
  });

  it('still reports a group it left for the editor when the group enters recovery', async () => {
    const key = 'u_held:file:f_1';
    const lineage = 'source:f_1:epoch:1@sha_a';
    await leftRows(key, lineage, 'sha_a');
    requests.length = 0;
    answer(409, 'lineage');
    await sweepDrafts('u_held', tokens('source:f_1:epoch:1'));
    expect((await readDrafts(key)).every((row) => row.held)).toBe(true);
    // The file moved on: the next open shows the group as another epoch's
    // draft, and it is reported (human/frontend/office-files.md 2026-10-05).
    const group = draftGroups(
      await readDrafts(key),
      'source:f_1:epoch:2@sha_b',
      sameSourceLineage('docx')
    ).recovery;
    expect(group).toHaveLength(2);
    const report = vi.fn();
    reportRecoveryGroup(group, report);
    expect(report).toHaveBeenCalledExactlyOnceWith(
      'other_epoch_draft',
      'reopen',
      draftBytes(group)
    );
  });

  it('sends rows a kept epoch left reported once they are current again', async () => {
    const key = 'u_kept:material:mat_1';
    const rows = await leftRows(key);
    await markDraftsReported(
      key,
      rows.map((row) => row.id)
    );
    requests.length = 0;
    await sweepDrafts('u_kept', tokens(ROOM));
    expect(requests).toHaveLength(1);
    expect(await readDrafts(key)).toEqual([]);
  });

  it('deletes the drafts of a document the account lost in the load sweep alone', async () => {
    const key = 'u_lost:material:mat_1';
    await leftRows(key);
    const api = {
      post: vi.fn(async () => {
        throw new ApiError(404, 'Not Found');
      }),
    };
    await sweepDrafts('u_lost', api, { cleanup: false });
    expect(await readDrafts(key)).toHaveLength(2);
    // Settled for this page load's later triggers: no token asked again.
    await sweepDrafts('u_lost', api, { cleanup: false });
    expect(api.post).toHaveBeenCalledTimes(1);
    // The load sweep reads every document, settled or not.
    await sweepDrafts('u_lost', api, { cleanup: true });
    expect(await readDrafts(key)).toEqual([]);
  });

  it('stops when the page signs in as someone else', async () => {
    const key = 'u_switch:material:mat_1';
    await leftRows(key);
    let signedIn = true;
    const api = {
      post: vi.fn(async () => {
        signedIn = false;
        return {
          access: 'write',
          room: ROOM,
          token: 'room-token',
          url: 'wss://collab.test',
        };
      }),
    };
    requests.length = 0;
    await sweepDrafts('u_switch', api, { current: () => signedIn });
    expect(requests).toHaveLength(0);
    expect(await readDrafts(key)).toHaveLength(2);
  });

  it('sends the client protocol, and stops for the page load once refused as outdated, marking no row', async () => {
    const page = await nextPageLoad();
    const { takeUpdateLoad } = await import('./appRelease');
    const first = 'u_stale:material:mat_1';
    const second = 'u_stale:material:mat_2';
    await leftRows(first);
    await leftRows(second);
    requests.length = 0;
    answer(426, 'outdated');
    await page.sweepDrafts('u_stale', tokens(ROOM));
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get('x-capy-protocol')).toBe(
      String(CLIENT_PROTOCOL)
    );
    // Kept as they were, for the reloaded page to send.
    for (const key of [first, second]) {
      const rows = await readDrafts(key);
      expect(rows).toHaveLength(2);
      expect(rows.some((row) => row.held || row.refused)).toBe(false);
    }
    // No later trigger of this page load sends anything.
    await page.sweepDrafts('u_stale', tokens(ROOM), { cleanup: false });
    expect(requests).toHaveLength(1);
    // The next page change loads the new app.
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: { getItem: () => null, setItem: () => undefined },
    });
    expect(takeUpdateLoad()).toBe(true);
    Reflect.deleteProperty(globalThis, 'sessionStorage');
    // The reloaded page (the new build) sends them through its checks.
    const reloaded = await nextPageLoad();
    await reloaded.sweepDrafts('u_stale', tokens(ROOM));
    expect(requests).toHaveLength(3);
    expect(await readDrafts(first)).toEqual([]);
    expect(await readDrafts(second)).toEqual([]);
  });

  it('runs one sweep at a time, whichever trigger starts it', async () => {
    const first = 'u_once:material:mat_1';
    const second = 'u_once:material:mat_2';
    await leftRows(first);
    await leftRows(second);
    requests.length = 0;
    const release = held();
    const api = tokens(ROOM);
    const sweep = sweepDrafts('u_once', api);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    // Coming back online while the first sweep sends its first document:
    // nothing runs, not even for the document it has not reached.
    await sweepDrafts('u_once', api);
    expect(api.post).toHaveBeenCalledTimes(1);
    release();
    await sweep;
    expect(requests).toHaveLength(2);
    expect(await readDrafts(first)).toEqual([]);
    expect(await readDrafts(second)).toEqual([]);
  });
});
