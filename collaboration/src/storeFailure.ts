import type * as Y from 'yjs';
import { MaterialDocumentLimitError } from './limits.js';
import { MaterialDocumentValidationError } from './materialDocument.js';
import { OfficeEngineError, type SourceFormat } from './officeRuntime.js';
import { CollaborationAuthorizationError } from './persistence.js';
import { SourceRequestError } from './sourceDocuments.js';

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

/**
 * A source save failure that will always fail, so its room resets and the
 * browsers go to recovery at once: the engine refusing the state (a trap, a
 * rebuild check), the byte limit (413), invalid input (422), an editing epoch
 * that ended, or lost access or a missing file (403/404). Anything slow
 * instead (an engine timeout or a dead worker, a checkpoint that moved again
 * after the reload and merge, a network error or a 5xx, or a 401: see
 * serviceSecretRejected) keeps the room editable and is retried with backoff.
 */
export function sourceSaveRefused(error: unknown) {
  return (
    (error instanceof OfficeEngineError && !error.transient) ||
    (error instanceof SourceRequestError &&
      ([403, 404, 413, 422].includes(error.status) ||
        // The room's editing epoch ended (a handoff): its saves never land.
        error.code === 'epoch_changed'))
  );
}

/** How long a room's saves may keep failing, without one success, before it
 * goes to the refused-save recovery path. */
export const SLOW_SAVE_LIMIT_MS = 5 * 60_000;

/**
 * When each source room's saves started failing without a success. Every
 * failed save counts, whatever the cause (a slow failure, pending content, a
 * save held back by the backoff); a successful save clears the room.
 */
export class SlowSaveClock {
  private readonly since = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Records a failed save: true once the room has gone SLOW_SAVE_LIMIT_MS
   * without one success. */
  failed(room: string) {
    const since = this.since.get(room) ?? this.now();
    this.since.set(room, since);
    return this.now() - since >= SLOW_SAVE_LIMIT_MS;
  }

  clear(room: string) {
    this.since.delete(room);
  }
}

/** A source save skipped while its room waits out a failed save's backoff. */
export class SourceBackoffError extends Error {
  constructor() {
    super('source room is waiting out a failed save; saved on its next retry');
  }
}

/** A source room held back by pending content. Never refused by itself
 * (sourceSaveRefused is false), but it is a failed save like any other: no
 * successful save for SLOW_SAVE_LIMIT_MS sends the room to recovery whatever
 * the cause (SlowSaveClock). */
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

/**
 * A save refused because the writers lost access or the file is gone
 * (403/404, not an account lock): the browser drops its drafts and shows the
 * no-access or missing panel. Any other refusal for good keeps them for
 * recovery.
 */
export function lostSourceAccess(error: unknown) {
  return (
    error instanceof SourceRequestError &&
    [403, 404].includes(error.status) &&
    !ACCOUNT_LOCK_CODES.has(error.code ?? '')
  );
}

/** The `lostAccess` field of a refused save's `source-checkpoint-failed`:
 * which loss it was, so the browser can report the drafts it then deletes
 * (edit_incidents). */
export function lostAccessField(error: unknown) {
  if (!lostSourceAccess(error)) return {};
  return {
    lostAccess:
      (error as SourceRequestError).status === 404 ? 'not_found' : 'forbidden',
  };
}

/**
 * The gateway refused the collaboration service's own secret (a 401 from an
 * internal source route; user tokens are verified at connect and never reach
 * a save). That is our infrastructure, not the user's access: the save is a
 * slow failure (the room stays editable, the drafts stay, the clients hear
 * "Saving is delayed") and is logged loudly.
 */
export function serviceSecretRejected(error: unknown) {
  return error instanceof SourceRequestError && error.status === 401;
}

/** A 403 about the account itself, not the file: the browser keeps its
 * drafts (the refusal still goes to recovery). */
const ACCOUNT_LOCK_CODES = new Set([
  'account_deleted',
  'account_deletion_pending',
  'account_locked',
  'account_suspended',
]);
