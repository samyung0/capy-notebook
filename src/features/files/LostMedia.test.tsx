import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { LostEditorAsset } from '@/api/types';
import { m } from '@/i18n';

const lost = vi.hoisted(() => ({ items: [] as LostEditorAsset[] }));
vi.mock('@/api/hooks', () => ({
  useDeleteLostMedia: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useLostMedia: () => ({ data: { pages: [{ items: lost.items }] } }),
}));
const { LostMedia } = await import('./LostMedia');

// The images and audio the viewer still pays for in notes it can no longer
// open (M16) are listed under their note, marked lost; a note whose workspace
// closed has no name to show. Nothing shows while there are none.
it('lists lost media under their note', () => {
  expect(renderToStaticMarkup(<LostMedia view="list" />)).toBe('');
  lost.items = [
    {
      assetId: 'asset_a',
      createdAt: new Date().toISOString(),
      materialTitle: 'Cell division',
      name: 'mitosis.png',
      purpose: 'image',
      sizeBytes: 2048,
    },
    {
      assetId: 'asset_b',
      createdAt: new Date().toISOString(),
      materialTitle: '',
      name: 'lecture.mp3',
      purpose: 'audio',
      sizeBytes: 4096,
    },
  ];
  const html = renderToStaticMarkup(<LostMedia view="list" />);
  expect(html).toContain(m.files_lost_media_title());
  expect(html).toContain('mitosis.png');
  expect(html).toContain('Cell division');
  expect(html).toContain('lecture.mp3');
  expect(html).toContain(m.files_note_unavailable());
});
