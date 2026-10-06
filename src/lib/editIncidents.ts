import { api } from '@/api/client';
import { ReportEditIncidentBody } from '@/api/gen/validators';
import type { ReportEditIncidentReq } from '@/api/types';

/**
 * Editing incidents only the browser sees, where a user lost or could lose
 * work (human/observability-metering.md, 2026-10-05): stored in the
 * `edit_incidents` table beside the collaboration service's room incidents.
 * Sent once and never retried; an offline episode is reported after the
 * reconnect, and a failed report is only logged.
 */
export function reportEditIncident(incident: ReportEditIncidentReq) {
  const body = ReportEditIncidentBody.safeParse(incident);
  if (!body.success) {
    console.warn('Edit incident not reported:', body.error);
    return;
  }
  void api
    .post('/edit-incidents', body.data)
    .catch((error) => console.warn('Edit incident report failed:', error));
}

export type EditIncidentKind = ReportEditIncidentReq['kind'];
export type EditIncidentReporter = (
  kind: EditIncidentKind,
  reason?: string,
  sizeBytes?: number
) => void;

/** Reports incidents of one note or source file. */
export function editIncidentReporter(
  fileKind: ReportEditIncidentReq['fileKind'],
  fileId: string
): EditIncidentReporter {
  return (kind, reason, sizeBytes) =>
    reportEditIncident({ fileId, fileKind, kind, reason, sizeBytes });
}

const reported = new Set<string>();
/** Reports an incident at most once per page load for `id` (a recovery
 * group shown again on a later open is the same incident). */
export function reportOnce(id: string, report: () => void) {
  if (reported.has(id)) return;
  reported.add(id);
  report();
}

/** A failed draft write as a reason: the browser's storage quota, storage
 * that does not exist here (some private modes), or the write itself. */
export function storageFailureReason(error: unknown) {
  if (error instanceof DOMException && error.name === 'QuotaExceededError')
    return 'quota';
  if (typeof indexedDB === 'undefined') return 'unavailable';
  return 'write';
}
