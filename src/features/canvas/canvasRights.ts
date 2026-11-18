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
    /** The "Shared with workspace" switch. */
    share:
      own &&
      !!canvas?.workspaceId &&
      (workspaceRole === 'owner' || workspaceRole === 'editor'),
  };
}
