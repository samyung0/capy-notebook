import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { MaterialDocumentLimitError } from './limits.js';
import { MaterialDocumentValidationError } from './materialDocument.js';
import { OfficeEngineError } from './officeRuntime.js';
import { CollaborationAuthorizationError } from './persistence.js';
import {
  ENGINE_ATTEMPTS,
  engineFailures,
  engineRefused,
  handlePermanentStoreFailure,
  pendingSourceSave,
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

describe('Office engine store failures', () => {
  it('retries timeouts and lost workers until ENGINE_ATTEMPTS in a row', () => {
    const timeout = new OfficeEngineError('Office stateOf timed out', true);
    let failures = 0;
    for (let attempt = 1; attempt < ENGINE_ATTEMPTS; attempt++) {
      failures = engineFailures(timeout, failures);
      expect(engineRefused(timeout, failures)).toBe(false);
    }
    failures = engineFailures(timeout, failures);
    expect(engineRefused(timeout, failures)).toBe(true);
    // Any other failure breaks the run.
    expect(engineFailures(new Error('gateway 503'), failures)).toBe(0);
  });

  it('refuses a refusal or trap at once', () => {
    const refusal = new OfficeEngineError('stale_target: changed');
    expect(engineRefused(refusal, engineFailures(refusal, undefined))).toBe(
      true
    );
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
