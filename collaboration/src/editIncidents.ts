import type { Pool } from 'pg';
import type * as Y from 'yjs';
import { readOnlyRefusal } from './accessRecheck.js';
import { SOURCE_ROOM_PATTERN } from './auth.js';
import { documentContributors } from './contributors.js';
import { MaterialDocumentLimitError } from './limits.js';
import { MaterialDocumentValidationError } from './materialDocument.js';
import { captureError } from './observability.js';
import { UnplacedStepError } from './officeRoots.js';
import { OfficeEngineError } from './officeRuntime.js';
import {
  CollaborationAuthorizationError,
  CollaborationNotFoundError,
  CollaborationReadOnlyError,
  materialIdFromRoom,
} from './persistence.js';
import { SourceRequestError, sourceRoom } from './sourceDocuments.js';
import {
  SourceBackoffError,
  SourcePendingError,
  sourceSaveRefused,
} from './storeFailure.js';

/**
 * Editing incidents where a user lost or could lose work go to the
 * `edit_incidents` table (human/observability-metering.md, 2026-10-05). These
 * are the collaboration service's kinds; the browser reports its own through
 * POST /api/edit-incidents.
 */
const KINDS = [
  'save_refused',
  'discard_unsaved',
  'epoch_reset',
  'over_limit',
  'slow_save_limit',
  'step2_unplaced',
] as const;
type IncidentKind = (typeof KINDS)[number];

/** What happened and a short token why (`reason`). */
export interface IncidentCause {
  kind: IncidentKind;
  reason: string | null;
}

export interface EditIncident extends IncidentCause {
  room: string;
  /** The bytes at risk: the room's state or the refused update. */
  sizeBytes: number | null;
  /** The writer whose work it was; null when the room names none. */
  userId: string | null;
}

/** An error as a reason token (the table allows `[a-z0-9_-]`, 64 at most).
 * Lost access reads as the browser reports it: `forbidden`, `not_found`. */
function errorReason(error: unknown): string {
  if (error instanceof SourcePendingError) return 'pending';
  if (error instanceof SourceBackoffError) return 'backoff';
  // Transient: a timeout or a lost worker.
  if (error instanceof OfficeEngineError)
    return error.transient ? 'engine_transient' : 'engine_refused';
  if (error instanceof SourceRequestError)
    return token(
      error.code ??
        ({ 403: 'forbidden', 404: 'not_found' } as Record<number, string>)[
          error.status
        ] ??
        `http_${error.status}`
    );
  if (error instanceof MaterialDocumentLimitError) return token(error.code);
  if (error instanceof MaterialDocumentValidationError)
    return 'invalid_document';
  if (error instanceof CollaborationReadOnlyError) return 'read_only';
  if (error instanceof CollaborationNotFoundError) return 'not_found';
  if (error instanceof CollaborationAuthorizationError) return 'forbidden';
  return 'error';
}

/** The writer lost write access: read-only (storage limit, frozen), revoked,
 * the file gone, or a locked account. Its unsaved state is thrown away. */
function lostWriteAccess(error: unknown) {
  return (
    readOnlyRefusal(error) ||
    error instanceof CollaborationAuthorizationError ||
    (error instanceof SourceRequestError &&
      (error.status === 403 || error.status === 404))
  );
}

function token(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .slice(0, 64) || 'error'
  );
}

/**
 * Why a source save failure discards its room: lost write access throws the
 * unsaved state away, the state byte limit is the over-limit refusal, a
 * failure that always fails is a refused save, and anything else reached the
 * slow-save limit (`slowLimit`).
 */
export function sourceDiscardCause(
  error: unknown,
  slowLimit: boolean
): IncidentCause {
  const reason = errorReason(error);
  if (lostWriteAccess(error)) return { kind: 'discard_unsaved', reason };
  if (error instanceof SourceRequestError && error.status === 413)
    return { kind: 'over_limit', reason: 'source_state_bytes' };
  if (sourceSaveRefused(error)) return { kind: 'save_refused', reason };
  if (slowLimit) return { kind: 'slow_save_limit', reason };
  return { kind: 'discard_unsaved', reason };
}

/** Why a material store refused for good discards its room: a limit, an
 * invalid document, or lost write access. */
export function materialDiscardCause(error: unknown): IncidentCause {
  const reason = errorReason(error);
  if (error instanceof MaterialDocumentLimitError)
    return { kind: 'over_limit', reason };
  if (error instanceof MaterialDocumentValidationError)
    return { kind: 'save_refused', reason };
  return { kind: 'discard_unsaved', reason };
}

/**
 * A discard named only by its broadcast (an outbox event, or another
 * instance's discard reaching this one): the `incident` the discarding
 * instance put in it, a rejection's code, else the event `type`.
 */
export function broadcastDiscardCause(
  notification: boolean | string
): IncidentCause {
  let event: {
    code?: unknown;
    incident?: { kind?: unknown; reason?: unknown };
    type?: unknown;
  } = {};
  if (typeof notification === 'string')
    try {
      event = JSON.parse(notification);
    } catch {
      // Not ours to read: the cause stays generic.
    }
  const { kind, reason } = event.incident ?? {};
  if (KINDS.includes(kind as IncidentKind))
    return {
      kind: kind as IncidentKind,
      reason: typeof reason === 'string' ? token(reason) : null,
    };
  if (event.type === 'document-rejected' && typeof event.code === 'string')
    return event.code === 'invalid_document'
      ? { kind: 'save_refused', reason: 'invalid_document' }
      : { kind: 'over_limit', reason: token(event.code) };
  return {
    kind: 'discard_unsaved',
    reason: typeof event.type === 'string' ? token(event.type) : 'discard',
  };
}

/**
 * Why one writer's update was refused for good, with its unsaved edits: the
 * document limits, a sync step 2 the room could not place twice, or the
 * writer losing write access. Null for a refusal the client recovers from by
 * reconnecting.
 */
export function refusedUpdateCause(error: unknown): IncidentCause | null {
  if (error instanceof MaterialDocumentLimitError)
    return { kind: 'over_limit', reason: errorReason(error) };
  if (error instanceof UnplacedStepError)
    return { kind: 'step2_unplaced', reason: null };
  if (lostWriteAccess(error))
    return { kind: 'discard_unsaved', reason: errorReason(error) };
  return null;
}

/** One incident per writer with unsaved work in the room (its pending
 * contributor markers), or one naming nobody when it holds none. */
export function roomIncidents(
  room: string,
  cause: IncidentCause,
  document: Y.Doc | undefined,
  sizeBytes: number | null
): EditIncident[] {
  const users = new Set(
    document ? documentContributors(document).map((c) => c.userId) : []
  );
  return (users.size ? [...users] : [null]).map((userId) => ({
    ...cause,
    room,
    sizeBytes,
    userId,
  }));
}

/** The note or source file a room edits. */
function roomFile(room: string) {
  return SOURCE_ROOM_PATTERN.test(room)
    ? { id: sourceRoom(room).fileId, kind: 'source_file' }
    : { id: materialIdFromRoom(room), kind: 'material' };
}

/**
 * Writes incidents in one statement. It never throws and is not retried: a
 * failed write is reported, and editing never waits on it.
 */
export async function recordEditIncidents(
  pool: Pick<Pool, 'query'>,
  incidents: readonly EditIncident[]
) {
  if (!incidents.length) return;
  try {
    const files = incidents.map((incident) => roomFile(incident.room));
    await pool.query(
      `INSERT INTO edit_incidents
         (user_id, file_id, file_kind, kind, reason, size_bytes)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[],
         $5::text[], $6::bigint[])`,
      [
        incidents.map((incident) => incident.userId),
        files.map((file) => file.id),
        files.map((file) => file.kind),
        incidents.map((incident) => incident.kind),
        incidents.map((incident) => incident.reason),
        incidents.map((incident) =>
          incident.sizeBytes === null ? null : Math.round(incident.sizeBytes)
        ),
      ]
    );
  } catch (error) {
    captureError(error, {
      kind: incidents[0].kind,
      room: incidents[0].room,
      stage: 'edit_incident_write',
    });
  }
}
