import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localUndoPayload } from './localDb';

/** This module afresh: what a page reload starts with (IndexedDB kept). */
async function reloaded() {
  vi.resetModules();
  return await import('./undoPayloads');
}

const payload = (operationId: string, documentId = 'mat_1', epoch = 1) => ({
  documentId,
  epoch,
  mac: 'f'.repeat(64),
  operationId,
  updates: { content: 'dW5kbw==' },
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('agent Undo payloads in the browser (Epo 2026-10-21)', () => {
  it('keeps a payload across a reload for a day, then drops it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T10:00:00Z'));
    (await reloaded()).keepUndoPayloads([payload('op_day')]);
    await vi.waitFor(async () =>
      expect(await localUndoPayload('op_day')).toBeDefined()
    );
    const later = await reloaded();
    vi.setSystemTime(new Date('2026-10-23T09:59:00Z'));
    expect(await later.undoPayload('op_day')).toMatchObject(payload('op_day'));
    vi.setSystemTime(new Date('2026-10-23T10:00:01Z'));
    const nextDay = await reloaded();
    expect(await nextDay.undoPayload('op_day')).toBeUndefined();
    await vi.waitFor(async () =>
      expect(await localUndoPayload('op_day')).toBeUndefined()
    );
  });

  it('keeps payloads in memory when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const store = await reloaded();
    store.keepUndoPayloads([payload('op_private')]);
    expect(await store.undoPayload('op_private')).toMatchObject(
      payload('op_private')
    );
  });

  it('keeps no payload past the size bound or of the wrong shape', async () => {
    const store = await reloaded();
    const huge = {
      ...payload('op_huge'),
      updates: { content: 'a'.repeat(store.UNDO_PAYLOAD_MAX_CHARS + 1) },
    };
    store.keepUndoPayloads([huge, { operationId: 'op_bad' }]);
    expect(await store.undoPayload('op_huge')).toBeUndefined();
    expect(await store.undoPayload('op_bad')).toBeUndefined();
  });

  // Q122 (Epo 2026-10-22): a payload cannot apply across a compaction, so
  // once a token or session shows its document in a newer lineage it goes,
  // from memory and IndexedDB, and other documents' payloads stay.
  it("drops a document's payloads once it shows a newer lineage", async () => {
    const store = await reloaded();
    store.keepUndoPayloads([
      payload('op_old', 'mat_compacted', 1),
      payload('op_other', 'mat_other', 1),
      payload('op_file', 'f_published', 2),
    ]);
    await vi.waitFor(async () =>
      expect(await localUndoPayload('op_file')).toBeDefined()
    );
    store.sawRoom('material:mat_compacted:schema:2');
    store.sawRoom('source:f_published:epoch:3');
    expect(await store.undoPayload('op_old')).toBeUndefined();
    expect(await store.undoPayload('op_file')).toBeUndefined();
    await vi.waitFor(async () => {
      expect(await localUndoPayload('op_old')).toBeUndefined();
      expect(await localUndoPayload('op_file')).toBeUndefined();
    });
    expect(await (await reloaded()).undoPayload('op_other')).toMatchObject(
      payload('op_other', 'mat_other', 1)
    );
  });
});
