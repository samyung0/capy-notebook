import { describe, expect, it } from 'vitest';
import { canManageWorkspaceSettings, isWorkspaceReadOnly } from './access';

const viewer = { canEdit: false, canManageMembers: false, canView: true };
const editor = { canEdit: true, canManageMembers: false, canView: true };

describe('workspace access helpers', () => {
  it('marks viewers read-only and editors editable', () => {
    expect(isWorkspaceReadOnly(viewer)).toBe(true);
    expect(isWorkspaceReadOnly(editor)).toBe(false);
  });

  it('keeps settings with owner and editor members only', () => {
    expect(canManageWorkspaceSettings({ role: 'owner' })).toBe(true);
    expect(canManageWorkspaceSettings({ role: 'editor' })).toBe(true);
    expect(canManageWorkspaceSettings({ role: 'viewer' })).toBe(false);
    expect(canManageWorkspaceSettings({ role: undefined })).toBe(false);
  });
});
