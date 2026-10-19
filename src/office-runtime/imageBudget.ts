import type { OfficeFormat } from '@/features/files/officeProtocol';

/**
 * An inserted image the room has no state left for: the edit session's
 * growth budget (what the server lets the room grow by, Epo 2026-10-17) less
 * what the document grew since it opened. The server cap stays the backstop.
 */
export class ImageBudgetError extends Error {}

/**
 * What an image's own bytes leave out: a DOCX data URL's prefix and the
 * picture's Yjs items, and unsaved growth already in the room at open (the
 * budget is as of the durable state), so the notice, not the room's refusal,
 * meets an image fitted to the edge.
 */
const SLACK_BYTES = 4096;

/**
 * The largest image file the document still has room for. A DOCX picture is
 * a base64 data URL in the document (4 bytes per 3), a PPTX picture its own
 * bytes.
 */
export function imageRoom(
  format: OfficeFormat,
  budgetBytes: number,
  grownBytes: number
) {
  const left = Math.max(0, budgetBytes - grownBytes - SLACK_BYTES);
  return format === 'docx' ? Math.floor(left / 4) * 3 : left;
}
