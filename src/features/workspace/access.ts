import type { AccessCapabilities, Workspace } from '@/api/types';

/** The workspace can be organized and added to when the API grants canEdit:
 * owner, editor member, or a link/public share-role editor. Edit mode,
 * comments and annotations follow canEditContent, which an owner at its
 * storage limit also turns off. */
export function isWorkspaceReadOnly(
  capabilities: AccessCapabilities | undefined | null
): boolean {
  return !capabilities?.canEdit;
}

/** Settings (name, tags, sharing, stats) follow persisted membership:
 * `role` is null for a share-role visitor, however permissive the link. */
export function canManageWorkspaceSettings(
  workspace: Pick<Workspace, 'role'> | undefined | null
): boolean {
  return workspace?.role === 'owner' || workspace?.role === 'editor';
}
