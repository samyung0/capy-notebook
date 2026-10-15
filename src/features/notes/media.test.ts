import { describe, expect, it } from 'vitest';

import type { EditorAsset } from '@/api/editorAssets';

import {
  acceptsPurpose,
  editorAssetPurpose,
  isVideoFile,
  mediaNodeFromAsset,
} from './media';

describe('editor media persistence', () => {
  it('takes images and audio only (Epo 2026-10-15)', () => {
    expect(editorAssetPurpose({ type: 'image/png' })).toBe('image');
    expect(editorAssetPurpose({ type: 'audio/mpeg' })).toBe('audio');
    expect(editorAssetPurpose({ type: 'application/pdf' })).toBeUndefined();
    expect(editorAssetPurpose({ type: 'text/plain' })).toBeUndefined();
  });

  it('persists stable metadata without signed or blob URLs', () => {
    const asset: EditorAsset = {
      assetId: 'asset-1',
      contentType: 'image/png',
      createdAt: '2026-07-17T00:00:00.000Z',
      name: 'lecture.png',
      purpose: 'image',
      sizeBytes: 42,
      status: 'ready',
      workspaceId: 'workspace-1',
    };

    const node = mediaNodeFromAsset(asset);
    expect(node).toMatchObject({ assetId: 'asset-1', type: 'img' });
    expect(node).not.toHaveProperty('url');
    expect(node).not.toHaveProperty('src');
  });

  it('enforces the placeholder purpose', () => {
    const file = { name: 'audio.mp3', type: 'audio/mpeg' };
    expect(acceptsPurpose(file, 'audio')).toBe(true);
    expect(acceptsPurpose(file, 'image')).toBe(false);
    const pdf = { name: 'paper.pdf', type: 'application/pdf' };
    expect(acceptsPurpose(pdf, 'image')).toBe(false);
    expect(acceptsPurpose(pdf, 'audio')).toBe(false);
  });

  it('rejects video files from every upload purpose', () => {
    expect(isVideoFile({ name: 'clip.mp4', type: '' })).toBe(true);
    expect(
      acceptsPurpose({ name: 'clip.mp4', type: 'video/mp4' }, 'image')
    ).toBe(false);
  });
});
