import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { MaterialDocumentLimitError } from './limits.js';
import { MaterialDocumentValidationError } from './materialDocument.js';
import { OfficeEngineError } from './officeRuntime.js';
import { CollaborationAuthorizationError } from './persistence.js';
import { SourceRequestError } from './sourceDocuments.js';
import {
  handlePermanentStoreFailure,
  lostAccessField,
  lostSourceAccess,
  pendingSourceSave,
  SLOW_SAVE_LIMIT_MS,
  SlowSaveClock,
  SourcePendingError,
  serviceSecretRejected,
  sourceSaveRefused,
} from './storeFailure.js';

function actions() {
  return {
    clearFailedStore: vi.fn(),
    rejectAuthorization: vi.fn(),
    rejectInvalidDocument: vi.fn(),
    rejectLimit: vi.fn(),
  };
}

describe('permanent store failures', () => {
  it('clears and rejects a limit failure with its payload data', () => {
    const callbacks = actions();
    const error = new MaterialDocumentLimitError('document_size_exceeded', {
      contentBytes: 2_097_153,
      maxDepth: 1,
      nodeCount: 2,
    });

    expect(handlePermanentStoreFailure(error, callbacks)).toBe(true);
    expect(callbacks.clearFailedStore).toHaveBeenCalledOnce();
    expect(callbacks.rejectLimit).toHaveBeenCalledWith(error);
    expect(callbacks.rejectAuthorization).not.toHaveBeenCalled();
    expect(callbacks.rejectInvalidDocument).not.toHaveBeenCalled();
  });

  it.each([
    {
      error: new MaterialDocumentValidationError('bad root'),
      rejection: 'rejectInvalidDocument' as const,
    },
    {
      error: new CollaborationAuthorizationError('access revoked'),
      rejection: 'rejectAuthorization' as const,
    },
  ])('clears and rejects $rejection failures', ({ error, rejection }) => {
    const callbacks = actions();

    expect(handlePermanentStoreFailure(error, callbacks)).toBe(true);
    expect(callbacks.clearFailedStore).toHaveBeenCalledOnce();
    expect(callbacks[rejection]).toHaveBeenCalledOnce();
    expect(callbacks.rejectLimit).not.toHaveBeenCalled();
  });

  it('leaves transient failures queued', () => {
    const callbacks = actions();

    expect(
      handlePermanentStoreFailure(new Error('database unavailable'), callbacks)
    ).toBe(false);
    for (const callback of Object.values(callbacks)) {
      expect(callback).not.toHaveBeenCalled();
    }
  });
});

describe('source save failures', () => {
  it('refuses only failures that will always fail', () => {
    for (const refused of [
      new OfficeEngineError('stale_target: changed'),
      new SourceRequestError(413, 'Source checkpoint exceeds byte limit'),
      new SourceRequestError(422, 'invalid checkpoint'),
      new SourceRequestError(403, 'forbidden'),
      new SourceRequestError(404, 'gone'),
      new SourceRequestError(409, 'Source epoch changed', 'epoch_changed'),
    ])
      expect(sourceSaveRefused(refused)).toBe(true);
    // Slow failures keep the room editable and are retried.
    for (const slow of [
      new OfficeEngineError('Office stateOf timed out', true),
      new SourceRequestError(409, 'checkpoint moved'),
      new SourceRequestError(503, 'unavailable'),
      new TypeError('fetch failed'),
    ])
      expect(sourceSaveRefused(slow)).toBe(false);
  });

  it('keeps a rejected service secret editable: slow, not lost access', () => {
    const secret = new SourceRequestError(
      401,
      'invalid collaboration service secret'
    );
    expect(serviceSecretRejected(secret)).toBe(true);
    // Retried with backoff under the slow-save cap, drafts kept.
    expect(sourceSaveRefused(secret)).toBe(false);
    expect(lostSourceAccess(secret)).toBe(false);
    expect(
      serviceSecretRejected(new SourceRequestError(403, 'forbidden'))
    ).toBe(false);
  });

  it('counts a lost file or access as lost, not an account lock', () => {
    expect(lostSourceAccess(new SourceRequestError(403, 'forbidden'))).toBe(
      true
    );
    expect(lostSourceAccess(new SourceRequestError(404, 'gone'))).toBe(true);
    // The account itself is suspended: the browser keeps its drafts.
    const locked = new SourceRequestError(
      403,
      'account unavailable',
      'account_suspended'
    );
    expect(lostSourceAccess(locked)).toBe(false);
    // The browser learns which loss, to report the drafts it deletes.
    expect(lostAccessField(new SourceRequestError(404, 'gone'))).toEqual({
      lostAccess: 'not_found',
    });
    expect(lostAccessField(new SourceRequestError(403, 'revoked'))).toEqual({
      lostAccess: 'forbidden',
    });
    expect(lostAccessField(locked)).toEqual({});
  });
});

describe('the slow-save cap', () => {
  // Pending content is never refused by itself, but no successful save for
  // SLOW_SAVE_LIMIT_MS sends the room to recovery whatever the cause.
  it('counts pending content like any failed save until a save succeeds', () => {
    expect(sourceSaveRefused(new SourcePendingError())).toBe(false);
    let now = 0;
    const clock = new SlowSaveClock(() => now);
    const room = 'source:f:epoch:1';
    expect(clock.failed(room)).toBe(false);
    now = SLOW_SAVE_LIMIT_MS - 1;
    expect(clock.failed(room)).toBe(false);
    now = SLOW_SAVE_LIMIT_MS;
    expect(clock.failed(room)).toBe(true);
    // A successful save starts the count over.
    clock.clear(room);
    now += 1000;
    expect(clock.failed(room)).toBe(false);
  });
});

describe('a source save over pending content', () => {
  // A room holding an update that arrived ahead of one it depends on.
  function pendingRoom() {
    const author = new Y.Doc();
    author.getText('source').insert(0, 'a');
    const first = Y.encodeStateAsUpdate(author);
    const vector = Y.encodeStateVector(author);
    author.getText('source').insert(1, 'b');
    const room = new Y.Doc();
    Y.applyUpdate(room, Y.encodeStateAsUpdate(author, vector));
    return { first, room };
  }

  it('waits in an Office room and saves a text room whole', () => {
    const { first, room } = pendingRoom();
    expect(room.store.pendingStructs).not.toBeNull();
    expect(pendingSourceSave(room, 'docx')).toBe('wait');
    expect(pendingSourceSave(room, undefined)).toBe('wait');
    expect(pendingSourceSave(room, 'text')).toBe('save');
    // The update it waited for integrates it; the room saves normally.
    Y.applyUpdate(room, first);
    expect(pendingSourceSave(room, 'docx')).toBe('none');
  });
});
