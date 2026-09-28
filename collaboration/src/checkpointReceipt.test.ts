import { describe, expect, it, vi } from 'vitest';
import {
  broadcastCheckpointPersisted,
  registerCheckpointRequest,
} from './checkpointReceipt.js';

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
