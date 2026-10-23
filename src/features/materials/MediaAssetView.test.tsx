import { parseHTML } from 'linkedom';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { CardFront } from '@/features/flashcards/CardView';
import { QuestionBlockView } from '@/features/questions/QuestionView';
import { getLocale, m } from '@/i18n';

// The locale resolves before a window exists, which would make paraglide keep
// it in localStorage; then linkedom's document goes in before
// react-dom/client loads, which reads it once.
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const resolveEditorAsset = vi.hoisted(() => vi.fn());
vi.mock('@/api/editorAssets', () => ({ resolveEditorAsset }));
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MediaAssetView, RemovedAssetsContext } = await import(
  './MediaAssetView'
);

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <RemovedAssetsContext.Provider value={{ ids: new Set(['asset_gone']) }}>
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

// An image deleted while its note is open fails to resolve: the material's
// list is checked again, and the image reads as removed once it is listed.
it('checks the list again when an image fails to load', async () => {
  resolveEditorAsset.mockRejectedValue(new Error('not found'));
  const recheck = vi.fn();
  const root = createRoot(document.getElementById('root') as never);
  const show = (ids: string[]) =>
    act(async () =>
      root.render(
        <RemovedAssetsContext.Provider value={{ ids: new Set(ids), recheck }}>
          <MediaAssetView element={{ assetId: 'asset_new', type: 'img' }} />
        </RemovedAssetsContext.Provider>
      )
    );
  await show([]);
  await act(() => vi.waitFor(() => expect(recheck).toHaveBeenCalledOnce()));
  const text = () => document.getElementById('root')?.textContent;
  expect(text()).not.toContain(m.media_image_removed());
  await show(['asset_new']);
  expect(text()).toContain(m.media_image_removed());
  await act(async () => root.unmount());
});
