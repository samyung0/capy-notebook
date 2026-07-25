import { describe, expect, it } from 'vitest';

import type { EditorAsset } from '@/api/editorAssets';

import {
  acceptsPurpose,
  editorAssetPurpose,
  mediaNodeFromAsset,
} from './media';

describe('editor media persistence', () => {
  it('classifies media without relying only on file extensions', () => {
    expect(editorAssetPurpose({ name: 'photo.bin', type: 'image/png' })).toBe(
      'image'
    );
    expect(editorAssetPurpose({ name: 'paper.PDF', type: '' })).toBe('pdf');
    expect(editorAssetPurpose({ name: 'notes.txt', type: 'text/plain' })).toBe(
      'file'
    );
  });

  it('persists stable metadata without signed or blob URLs', () => {
    const asset: EditorAsset = {
      assetId: 'asset-1',
      contentType: 'video/mp4',
      createdAt: '2026-07-17T00:00:00.000Z',
      name: 'lecture.mp4',
      purpose: 'video',
      sizeBytes: 42,
      status: 'ready',
      workspaceId: 'workspace-1',
    };

    const node = mediaNodeFromAsset(asset);
    expect(node).toMatchObject({ assetId: 'asset-1', type: 'video' });
    expect(node).not.toHaveProperty('url');
    expect(node).not.toHaveProperty('src');
  });

  it('enforces placeholder purpose while allowing generic files', () => {
    const file = { name: 'audio.mp3', type: 'audio/mpeg' };
    expect(acceptsPurpose(file, 'audio')).toBe(true);
    expect(acceptsPurpose(file, 'image')).toBe(false);
    expect(acceptsPurpose(file, 'file')).toBe(true);
  });
});
