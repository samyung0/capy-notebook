import type { CanvasListItem } from '@/api/canvas';
import type { WorkspaceRole } from '@/api/types';

/** What the caller may do to a canvas beyond drawing on it. PROVISIONAL
 * (canvas collaboration, open question 3, with Epo): the person who made it
 * alone renames, deletes and shares it, and sharing needs a workspace's canvas
 * whose maker is that workspace's owner or editor. The server enforces the
 * same; this decides what the picker offers. */
export function canvasRights(
  canvas: Pick<CanvasListItem, 'own' | 'workspaceId'> | undefined,
  workspaceRole: WorkspaceRole | undefined
) {
  const own = canvas?.own === true;
  return {
    /** Rename and Delete. */
    manage: own,
    /** The "Shared with members" switch. */
    share:
      own &&
      !!canvas?.workspaceId &&
      (workspaceRole === 'owner' || workspaceRole === 'editor'),
  };
}

/** Whether the caller's role on a canvas lets them edit it: its maker
 * (`owner`) or a workspace editor or owner on a shared one, whatever their
 * channel now (a frozen account, a full payer). None in the Trash. */
export const editsCanvas = (role: WorkspaceRole | undefined) =>
  role === 'owner' || role === 'editor';

/** Whether this tab sends its presence on a canvas and sees the others'
 * (Epo 2026-11-18): an owner or editor does, a narrowed one included, as the
 * room relays any channel but a viewer's (`on_awareness`,
 * collaboration-rs/crates/server/src/room.rs); a viewer, as a note's reader,
 * does not. Unknown until the canvas is read. */
export const sendsPresence = editsCanvas;
