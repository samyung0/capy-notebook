import type * as Y from 'yjs';
import { MaterialDocumentLimitError } from './limits.js';
import { MaterialDocumentValidationError } from './materialDocument.js';
import { OfficeEngineError, type SourceFormat } from './officeRuntime.js';
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

// An Office engine timeout or lost worker is retried like a gateway 5xx, up
// to this many in a row; after that, as after a refusal or trap, the state is
// taken as one the engine cannot store, and its room resets.
export const ENGINE_ATTEMPTS = 3;
export function engineFailures(error: unknown, previous: number | undefined) {
  return error instanceof OfficeEngineError && error.transient
    ? (previous ?? 0) + 1
    : 0;
}
export function engineRefused(error: unknown, failures: number) {
  return (
    error instanceof OfficeEngineError &&
    (!error.transient || failures >= ENGINE_ATTEMPTS)
  );
}

/** A source room held back by pending content: transient, never a refusal. */
export class SourcePendingError extends Error {
  constructor() {
    super('source room holds pending updates; saved once they integrate');
  }
}

/**
 * What a source save does with a room that holds pending content (an update
 * that arrived ahead of one it depends on). An Office state cannot carry it
 * (the seed rebuild check refuses it, which would reset the room), so the save
 * waits as a transient failure until the client's sync integrates it. A text
 * state is stored whole and always saved such content, so it still does.
 */
export function pendingSourceSave(
  document: Y.Doc,
  format: SourceFormat | undefined
): 'none' | 'wait' | 'save' {
  if (!(document.store.pendingStructs || document.store.pendingDs))
    return 'none';
  return format === 'text' ? 'save' : 'wait';
}
