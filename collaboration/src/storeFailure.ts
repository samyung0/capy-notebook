import { MaterialDocumentLimitError } from './limits.js';
import { MaterialDocumentValidationError } from './materialDocument.js';
import { CollaborationAuthorizationError } from './persistence.js';

interface PermanentStoreFailureActions {
  clearFailedStore: () => void;
  rejectAuthorization: () => void;
  rejectInvalidDocument: () => void;
  rejectLimit: (error: MaterialDocumentLimitError) => void;
}

/**
 * Applies the common terminal response for snapshots that can never be saved.
 * Transient failures stay queued for a later retry.
 */
export function handlePermanentStoreFailure(
  error: unknown,
  actions: PermanentStoreFailureActions
): boolean {
  if (error instanceof MaterialDocumentLimitError) {
    actions.clearFailedStore();
    actions.rejectLimit(error);
    return true;
  }
  if (error instanceof MaterialDocumentValidationError) {
    actions.clearFailedStore();
    actions.rejectInvalidDocument();
    return true;
  }
  if (error instanceof CollaborationAuthorizationError) {
    actions.clearFailedStore();
    actions.rejectAuthorization();
    return true;
  }
  return false;
}
