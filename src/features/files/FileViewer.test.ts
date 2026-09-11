import { describe, expect, it } from 'vitest';

import { hasOfficeCitationPreview } from './FileViewer';

describe('hasOfficeCitationPreview', () => {
  it.each(['store-only.xlsx', 'store-only.pptx', 'store-only.docx'])(
    'keeps %s on its native viewer when no exact citation preview exists',
    (name) => {
      expect(hasOfficeCitationPreview({ name }, 1)).toBe(false);
      expect(
        hasOfficeCitationPreview({ name }, undefined, [
          {
            bbox: [0, 0, 100, 100],
            page: 1,
            space: 'page-1000-topleft',
          },
        ])
      ).toBe(false);
    }
  );

  it('opens the preview only when the row advertises a parser-derived PDF', () => {
    expect(
      hasOfficeCitationPreview(
        { name: 'indexed.xlsx', previewUrl: '/api/files/f1/preview' },
        2
      )
    ).toBe(true);
  });
});
