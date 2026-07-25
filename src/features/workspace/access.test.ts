import { describe, expect, it } from 'vitest';
import { canShareWorkspace, isWorkspaceReadOnly } from './access';

describe('workspace access helpers', () => {
  it('marks share viewers as read-only', () => {
    expect(
      isWorkspaceReadOnly({
        canComment: false,
        canEdit: false,
        canManageMembers: false,
        canView: true,
      })
    ).toBe(true);
  });

  it('keeps editors editable', () => {
    expect(
      isWorkspaceReadOnly({
        canComment: true,
        canEdit: true,
        canManageMembers: false,
        canView: true,
      })
    ).toBe(false);
  });

  it('allows share only for owners', () => {
    expect(
      canShareWorkspace({
        canComment: true,
        canEdit: true,
        canManageMembers: true,
        canView: true,
      })
    ).toBe(true);
    expect(
      canShareWorkspace({
        canComment: true,
        canEdit: true,
        canManageMembers: false,
        canView: true,
      })
    ).toBe(false);
  });
});
