import type { AccessCapabilities } from '@/api/types';

/** Workspace is editable when the API grants canEdit (owner or editor). */
export function isWorkspaceReadOnly(
  capabilities: AccessCapabilities | undefined | null
): boolean {
  return !capabilities?.canEdit;
}

/** Workspace Share/privacy is owner-only (canManageMembers). */
export function canShareWorkspace(
  capabilities: AccessCapabilities | undefined | null
): boolean {
  return !!capabilities?.canManageMembers;
}
