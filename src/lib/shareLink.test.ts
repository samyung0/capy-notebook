import { describe, expect, it } from 'vitest';
import { publicWorkspaces, workspaces } from '@/mocks/db';
import { DEV_SHARE_LINK_SECRET, sharePath, verifiedShareID } from './shareLink';

describe('share links', () => {
  // Same vector as server/internal/store/share_link_test.go.
  it('signs and verifies exactly like Go', async () => {
    const secret = 'test-secret-0123456789abcdef0000';
    const path = await sharePath(secret, 'ws_1a2b3c4d5e');
    expect(path).toBe('/w/ws_1a2b3c4d5e.FVCxkY8emO_wohfF');
    expect(await verifiedShareID(secret, path)).toBe('ws_1a2b3c4d5e');
    expect(await verifiedShareID(`${secret}x`, path)).toBeUndefined();
  });
  // The seeds hold literal paths; Vite's MSW middleware verifies them.
  it('keeps mock seed paths signed with the dev secret', async () => {
    for (const { id, sharePath: path } of [...workspaces, ...publicWorkspaces])
      expect(path).toBe(await sharePath(DEV_SHARE_LINK_SECRET, id));
  });
});
