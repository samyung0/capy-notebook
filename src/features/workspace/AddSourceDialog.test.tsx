import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { sourceUploadPolicy } from '@/mocks/sourceUploadPolicy';

import {
  CaptionImagesToggle,
  ChapterSelect,
  createSourceInspectionGuard,
  ParseModeSelect,
} from './AddSourceDialog';

const pendingPdf = {
  analysisStatus: 'idle' as const,
  captionImages: true,
  chapterId: null,
  chapterName: null,
  contentType: 'application/pdf',
  key: 'local-paper.pdf',
  kind: 'pdf' as const,
  name: 'paper.pdf',
  origin: 'local' as const,
  parseMode: 'fast' as const,
  sizeBytes: 1024,
  sizeEstimate: false,
};

describe('add-source dialog lifecycle', () => {
  it('disables every mutable row setting while submitting', () => {
    const html = renderToStaticMarkup(
      <>
        <ChapterSelect
          chapters={[]}
          disabled
          onChange={() => undefined}
          value={null}
        />
        <ParseModeSelect
          disabled
          onChange={() => undefined}
          pending={pendingPdf}
          policy={sourceUploadPolicy}
        />
        <CaptionImagesToggle
          disabled
          onChange={() => undefined}
          pending={pendingPdf}
          policy={sourceUploadPolicy}
        />
      </>
    );

    const selectTriggers = html.match(
      /<button(?=[^>]*data-slot="select-trigger")[^>]*>/g
    );
    const captionToggle = html.match(/<(?=[^>]*data-slot="switch")[^>]+>/g);

    expect(selectTriggers).toHaveLength(2);
    expect(
      selectTriggers?.every((control) => control.includes('disabled=""'))
    ).toBe(true);
    expect(captionToggle).toHaveLength(1);
    expect(captionToggle?.[0]).toContain('disabled=""');
  });

  it('ignores an inspection result after the chooser closes', async () => {
    const guard = createSourceInspectionGuard();
    const isCurrent = guard.begin();
    let releaseInspection: (() => void) | undefined;
    let selected = false;
    const inspection = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    }).then(() => {
      if (isCurrent()) selected = true;
    });

    guard.invalidate();
    releaseInspection?.();
    await inspection;

    expect(selected).toBe(false);
  });
});
