import { Document, Hocuspocus } from '@hocuspocus/server';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  broadcastCheckpointPersisted,
  nothingToStore,
  registerCheckpointRequest,
} from './checkpointReceipt.js';
import { attachDocumentContributorTracker } from './contributors.js';

describe('checkpoint persistence receipts', () => {
  it('broadcasts a retry receipt for only still-pending claimed IDs', () => {
    const pending = new Set(['claimed', 'queued-later']);
    const document = { broadcastStateless: vi.fn() };
    broadcastCheckpointPersisted(
      document,
      pending,
      ['claimed', 'already-settled'],
      'mat_1',
      {
        limitCode: 'document_depth_exceeded',
        metrics: { contentBytes: 123, maxDepth: 17, nodeCount: 42 },
        version: 9,
      }
    );

    expect([...pending]).toEqual(['queued-later']);
    expect(JSON.parse(document.broadcastStateless.mock.calls[0][0])).toEqual({
      checkpointIds: ['claimed'],
      limitCode: 'document_depth_exceeded',
      materialId: 'mat_1',
      metrics: { contentBytes: 123, maxDepth: 17, nodeCount: 42 },
      type: 'checkpoint-persisted',
      yjsVersion: 9,
    });
  });
});

describe('checkpoint request registration', () => {
  it('drains a full source room by saving instead of dropping the request', async () => {
    const receipts = new Map([['room', new Set(['a', 'b'])]]);
    const drain = vi.fn(async () => {
      receipts.get('room')?.clear();
    });
    expect(
      await registerCheckpointRequest(receipts, 'room', 'c', 2, drain)
    ).toBe(true);
    expect(drain).toHaveBeenCalledOnce();
    expect([...(receipts.get('room') ?? [])]).toEqual(['c']);
  });

  it('refuses a request only when the set stays full', async () => {
    const receipts = new Map([['room', new Set(['a', 'b'])]]);
    // A material room has no drain; a failed drain leaves the set full.
    expect(await registerCheckpointRequest(receipts, 'room', 'c', 2)).toBe(
      false
    );
    const failing = vi.fn(async () => {
      throw new Error('save failed');
    });
    expect(
      await registerCheckpointRequest(receipts, 'room', 'c', 2, failing)
    ).toBe(false);
    expect(await registerCheckpointRequest(receipts, 'other', 'c', 2)).toBe(
      true
    );
    expect(receipts.get('other')).toEqual(new Set(['c']));
  });
});

describe('a checkpoint request with nothing to save', () => {
  it('is answered at once only while no change waits for a store', async () => {
    const host = new Hocuspocus({ debounce: 60_000, quiet: true });
    const room = new Document('material:mat_1:schema:1');
    attachDocumentContributorTracker(room, 'instance-a');
    // Everything stored: a request arriving after the store that held its
    // edits is answered now.
    expect(nothingToStore(host, room, false)).toBe(true);
    expect(nothingToStore(host, room, true)).toBe(false);
    // A writer's update the room has not stored yet waits for that store.
    const client = new Y.Doc();
    client.getText('content').insert(0, 'new');
    Y.applyUpdate(room, Y.encodeStateAsUpdate(client), {
      connection: { context: { access: 'write', userId: 'u_a' } },
      source: 'connection',
    });
    expect(nothingToStore(host, room, false)).toBe(false);
    const fresh = new Document('material:mat_2:schema:1');
    host.debouncer.debounce(
      `onStoreDocument-${fresh.name}`,
      async () => undefined,
      60_000,
      60_000
    );
    expect(nothingToStore(host, fresh, false)).toBe(false);
    await host.debouncer.executeNow(`onStoreDocument-${fresh.name}`);
    expect(nothingToStore(host, fresh, false)).toBe(true);
    room.destroy();
    fresh.destroy();
    client.destroy();
  });
});
