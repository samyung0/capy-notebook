import { describe, expect, it } from 'vitest';

import { officeCitationPreviewUrl } from './FileViewer';

describe('officeCitationPreviewUrl', () => {
  it.each(['store-only.xlsx', 'store-only.pptx', 'store-only.docx'])(
    'keeps %s on its native viewer when no exact citation preview exists',
    (name) => {
      expect(officeCitationPreviewUrl({ name }, 1)).toBeUndefined();
      expect(
        officeCitationPreviewUrl({ name }, undefined, [
          {
            bbox: [0, 0, 100, 100],
            page: 1,
            space: 'page-1000-topleft',
          },
        ])
      ).toBeUndefined();
    }
  );

  it('uses only the exact parser-derived preview URL for Office citations', () => {
    expect(
      officeCitationPreviewUrl(
        { name: 'indexed.xlsx', previewUrl: '/api/files/f_1/preview' },
        2
      )
    ).toBe('/api/files/f_1/preview');
  });
});
