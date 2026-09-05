import { describe, expect, it, vi } from 'vitest';
import { broadcastCheckpointPersisted } from './checkpointReceipt.js';

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
