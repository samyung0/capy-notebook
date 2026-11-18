import { expect, it } from 'vitest';
import { canvasRights } from './canvasRights';

// Provisional until Epo answers who administers a shared canvas: its maker
// alone, and sharing only as the workspace's owner or editor.
it('lets the maker rename and delete, and share as a workspace owner or editor', () => {
  const mine = { own: true, workspaceId: 'ws_1' };
  expect(canvasRights(mine, 'owner')).toEqual({ manage: true, share: true });
  expect(canvasRights(mine, 'editor')).toEqual({ manage: true, share: true });
  expect(canvasRights(mine, 'viewer')).toEqual({ manage: true, share: false });
  // One of the account's own, in no workspace, has no one to share with.
  expect(canvasRights({ own: true }, undefined)).toEqual({
    manage: true,
    share: false,
  });
  // Another member's shared canvas: drawn on, never administered.
  expect(canvasRights({ own: false, workspaceId: 'ws_1' }, 'owner')).toEqual({
    manage: false,
    share: false,
  });
});
