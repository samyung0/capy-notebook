import type { AccessCapabilities, Workspace } from '@/api/types';

/** Workspace content is editable when the API grants canEdit: owner, editor
 * member, or a link/public share-role editor. */
export function isWorkspaceReadOnly(
  capabilities: AccessCapabilities | undefined | null
): boolean {
  return !capabilities?.canEdit;
}

/** Settings (name, color, tags, sharing, stats) follow persisted membership:
 * `role` is null for a share-role visitor, however permissive the link. */
export function canManageWorkspaceSettings(
  workspace: Pick<Workspace, 'role'> | undefined | null
): boolean {
  return workspace?.role === 'owner' || workspace?.role === 'editor';
}
