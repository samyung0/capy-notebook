import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const captureError = vi.hoisted(() => vi.fn());
vi.mock('./observability.js', async (load) => ({
  ...(await load<typeof import('./observability.js')>()),
  captureError,
}));

import { attachDocumentContributorTracker } from './contributors.js';
import {
  broadcastDiscardCause,
  materialDiscardCause,
  recordEditIncidents,
  refusedUpdateCause,
  roomIncidents,
  sourceDiscardCause,
} from './editIncidents.js';
import { MaterialDocumentLimitError } from './limits.js';
import { MaterialDocumentValidationError } from './materialDocument.js';
import { UnplacedStepError } from './officeRoots.js';
import { OfficeEngineError } from './officeRuntime.js';
import {
  CollaborationAuthorizationError,
  CollaborationNotFoundError,
  CollaborationReadOnlyError,
} from './persistence.js';
import { SourceRequestError } from './sourceDocuments.js';
import { SourcePendingError } from './storeFailure.js';

const limit = () =>
  new MaterialDocumentLimitError('document_size_exceeded', {
    contentBytes: 2_097_153,
    maxDepth: 1,
    nodeCount: 2,
  });

describe('source save discards', () => {
  it('names lost access, the byte limit, refusals and the slow-save limit', () => {
    expect(
      sourceDiscardCause(
        new SourceRequestError(403, 'full', 'storage_quota_exceeded'),
        false
      )
    ).toEqual({ kind: 'discard_unsaved', reason: 'storage_quota_exceeded' });
    expect(
      sourceDiscardCause(new SourceRequestError(413, 'too big'), false)
    ).toEqual({ kind: 'over_limit', reason: 'source_state_bytes' });
    expect(
      sourceDiscardCause(new OfficeEngineError('stale_target'), false)
    ).toEqual({ kind: 'save_refused', reason: 'engine_refused' });
    expect(
      sourceDiscardCause(
        new SourceRequestError(409, 'moved on', 'epoch_changed'),
        false
      )
    ).toEqual({ kind: 'save_refused', reason: 'epoch_changed' });
    // Lost access reads as the browser reports it.
    expect(
      sourceDiscardCause(new SourceRequestError(404, 'gone'), false)
    ).toEqual({ kind: 'discard_unsaved', reason: 'not_found' });
    expect(
      sourceDiscardCause(new SourceRequestError(403, 'revoked'), false)
    ).toEqual({ kind: 'discard_unsaved', reason: 'forbidden' });
    // Anything slow counts only once the limit is reached.
    expect(
      sourceDiscardCause(new OfficeEngineError('timed out', true), true)
    ).toEqual({ kind: 'slow_save_limit', reason: 'engine_transient' });
    expect(sourceDiscardCause(new SourcePendingError(), true)).toEqual({
      kind: 'slow_save_limit',
      reason: 'pending',
    });
  });
});

describe('material store discards', () => {
  it('splits limits, invalid documents and access', () => {
    expect(materialDiscardCause(limit())).toEqual({
      kind: 'over_limit',
      reason: 'document_size_exceeded',
    });
    expect(
      materialDiscardCause(new MaterialDocumentValidationError('roots'))
    ).toEqual({ kind: 'save_refused', reason: 'invalid_document' });
    expect(
      materialDiscardCause(new CollaborationReadOnlyError('full'))
    ).toEqual({ kind: 'discard_unsaved', reason: 'read_only' });
  });
});

describe('broadcast discards', () => {
  it('reads the rejection or the outbox event type', () => {
    expect(
      broadcastDiscardCause(
        JSON.stringify({
          code: 'node_count_exceeded',
          type: 'document-rejected',
        })
      )
    ).toEqual({ kind: 'over_limit', reason: 'node_count_exceeded' });
    expect(
      broadcastDiscardCause(
        JSON.stringify({ code: 'invalid_document', type: 'document-rejected' })
      )
    ).toEqual({ kind: 'save_refused', reason: 'invalid_document' });
    expect(
      broadcastDiscardCause(JSON.stringify({ type: 'access-changed' }))
    ).toEqual({ kind: 'discard_unsaved', reason: 'access-changed' });
    // Another instance's refused source save carries its own incident.
    expect(
      broadcastDiscardCause(
        JSON.stringify({
          incident: { kind: 'slow_save_limit', reason: 'engine_transient' },
          type: 'authorization-revoked',
        })
      )
    ).toEqual({ kind: 'slow_save_limit', reason: 'engine_transient' });
    expect(
      broadcastDiscardCause(
        JSON.stringify({
          incident: { kind: 'anything', reason: 'x' },
          type: 'authorization-revoked',
        })
      )
    ).toEqual({ kind: 'discard_unsaved', reason: 'authorization-revoked' });
    expect(broadcastDiscardCause(true)).toEqual({
      kind: 'discard_unsaved',
      reason: 'discard',
    });
  });
});

describe('refused updates', () => {
  it('records limits, the unplaced close and lost write access only', () => {
    expect(refusedUpdateCause(limit())).toEqual({
      kind: 'over_limit',
      reason: 'document_size_exceeded',
    });
    expect(refusedUpdateCause(new UnplacedStepError('twice'))).toEqual({
      kind: 'step2_unplaced',
      reason: null,
    });
    expect(
      refusedUpdateCause(new CollaborationAuthorizationError('revoked'))
    ).toEqual({ kind: 'discard_unsaved', reason: 'forbidden' });
    expect(
      refusedUpdateCause(new CollaborationNotFoundError('trashed'))
    ).toEqual({ kind: 'discard_unsaved', reason: 'not_found' });
    expect(
      refusedUpdateCause(
        new SourceRequestError(403, 'frozen', 'account_over_quota')
      )
    ).toEqual({ kind: 'discard_unsaved', reason: 'account_over_quota' });
    // A client reconnects and resends after these.
    expect(refusedUpdateCause(new SourceRequestError(503, 'busy'))).toBeNull();
    expect(refusedUpdateCause(new Error('token expired'))).toBeNull();
  });
});

describe('room incidents', () => {
  it('names each writer with unsaved work once, or nobody', () => {
    const document = new Y.Doc();
    attachDocumentContributorTracker(document, 'instance');
    const write = (userId: string) =>
      document.transact(() => document.getText('content').insert(0, 'x'), {
        context: { access: 'write', userId },
        source: 'local',
      });
    write('u_a');
    write('u_b');
    write('u_a');
    const cause = { kind: 'save_refused', reason: 'engine_refused' } as const;
    const incidents = roomIncidents(
      'material:m_1:schema:1',
      cause,
      document,
      9
    );
    expect(incidents.map((incident) => incident.userId).sort()).toEqual([
      'u_a',
      'u_b',
    ]);
    expect(incidents[0]).toMatchObject({ ...cause, sizeBytes: 9 });
    expect(
      roomIncidents('material:m_1:schema:1', cause, undefined, null)
    ).toEqual([
      {
        ...cause,
        room: 'material:m_1:schema:1',
        sizeBytes: null,
        userId: null,
      },
    ]);
    document.destroy();
  });
});

describe('recording', () => {
  it('writes one statement with the file each room edits', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 2, rows: [] });
    await recordEditIncidents({ query } as never, [
      {
        kind: 'epoch_reset',
        reason: 'save_refused',
        room: 'source:f_1:epoch:3',
        sizeBytes: null,
        userId: null,
      },
      {
        kind: 'over_limit',
        reason: 'document_size_exceeded',
        room: 'material:m_1:schema:2',
        sizeBytes: 12.6,
        userId: 'u_a',
      },
    ]);
    expect(query).toHaveBeenCalledOnce();
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO edit_incidents');
    expect(values).toEqual([
      [null, 'u_a'],
      ['f_1', 'm_1'],
      ['source_file', 'material'],
      ['epoch_reset', 'over_limit'],
      ['save_refused', 'document_size_exceeded'],
      [null, 13],
    ]);
  });

  it('reports a failed write to Sentry and never throws', async () => {
    const failure = new Error('database down');
    const query = vi.fn().mockRejectedValue(failure);
    await expect(
      recordEditIncidents({ query } as never, [
        {
          kind: 'step2_unplaced',
          reason: null,
          room: 'source:f_1:epoch:1',
          sizeBytes: 5,
          userId: 'u_a',
        },
      ])
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledOnce();
    expect(captureError).toHaveBeenCalledExactlyOnceWith(failure, {
      kind: 'step2_unplaced',
      room: 'source:f_1:epoch:1',
      stage: 'edit_incident_write',
    });
  });
});
