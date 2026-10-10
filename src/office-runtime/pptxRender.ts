import {
  paintSlide,
  type SlideDisplayList,
  sizeCanvasForSlide,
} from '@betteroffice/pptx/viewer';
import type { OfficeRenderedPage } from '@/features/files/officeProtocol';
import { PptxImageCache } from './pptxImageCache';
import { canvasPage } from './runtimeMenus';
import { thumbnailCanvas, thumbnailPage } from './thumbnail';

/** What rendering needs from a deck: the editor's or the viewer's handle. */
interface SlideSource {
  layoutSlide(slideIndex: number): SlideDisplayList;
  mediaBytes(assetId: string): Uint8Array;
}

/** Decodes each picture once, for one render; `clear` drops them. */
function slideImages(source: SlideSource) {
  const images = new PptxImageCache();
  const resolveImage = (assetId: string) => {
    const cached = images.get(assetId);
    if (cached) return cached;
    const image = createImageBitmap(
      new Blob([source.mediaBytes(assetId).slice()])
    ).catch(() => null);
    images.set(assetId, image);
    return image;
  };
  return { clear: () => images.clear(), resolveImage };
}

/**
 * Slides as PNG pages for Capy's Print and PNG export, painted at twice
 * their size; a page measures the slide in CSS px.
 */
export async function renderSlides(
  source: SlideSource,
  indices: readonly number[]
): Promise<OfficeRenderedPage[]> {
  const images = slideImages(source);
  try {
    const pages: OfficeRenderedPage[] = [];
    for (const index of indices) {
      const frame = source.layoutSlide(index);
      const canvas = document.createElement('canvas');
      sizeCanvasForSlide(canvas, frame, 2);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('The slide could not be rendered');
      await paintSlide(context, frame, 2, 1, {
        resolveImage: images.resolveImage,
      });
      pages.push(await canvasPage(canvas, frame.width, frame.height));
    }
    return pages;
  } finally {
    images.clear();
  }
}

/** Slide 1 as a list-card capture (`thumbnail.ts`). */
export async function slideThumbnail(
  source: SlideSource
): Promise<OfficeRenderedPage> {
  const images = slideImages(source);
  try {
    const frame = source.layoutSlide(0);
    const { context, element, scale } = thumbnailCanvas(
      frame.width,
      frame.height
    );
    await paintSlide(context, frame, 1, scale, {
      resolveImage: images.resolveImage,
    });
    return await thumbnailPage(element, context);
  } finally {
    images.clear();
  }
}
