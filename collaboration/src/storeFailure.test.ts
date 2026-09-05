import { describe, expect, it, vi } from 'vitest';
import { MaterialDocumentLimitError } from './limits.js';
import { MaterialDocumentValidationError } from './materialDocument.js';
import { CollaborationAuthorizationError } from './persistence.js';
import { handlePermanentStoreFailure } from './storeFailure.js';

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
