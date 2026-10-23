import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { CardFront } from '@/features/flashcards/CardView';
import { QuestionBlockView } from '@/features/questions/QuestionView';
import { m } from '@/i18n';
import { MediaAssetView, RemovedAssetsContext } from './MediaAssetView';

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <RemovedAssetsContext.Provider value={new Set(['asset_gone'])}>
      {node}
    </RemovedAssetsContext.Provider>
  );

// An image or audio clip its uploader deleted (M16) reads as removed wherever
// the material shows it: a note's image in Edit, where a missing asset would
// otherwise wait as a skeleton, a note's audio, a quiz image and a card image.
it('shows media its uploader deleted as removed', () => {
  const image = m.media_image_removed();
  expect(
    render(
      <MediaAssetView
        element={{ assetId: 'asset_gone', type: 'img' }}
        ownerId="mat_note"
      />
    )
  ).toContain(image);
  expect(
    render(
      <MediaAssetView element={{ assetId: 'asset_gone', type: 'audio' }} />
    )
  ).toContain(m.media_audio_removed());
  expect(
    render(
      <QuestionBlockView
        block={{
          height: 10,
          image: { assetId: 'asset_gone' },
          type: 'image',
          width: 10,
        }}
      />
    )
  ).toContain(image);
  expect(
    render(
      <CardFront card={{ front: 'Front', image: { assetId: 'asset_gone' } }} />
    )
  ).toContain(image);
});
