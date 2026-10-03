import {
  paintSlide,
  type SlideDisplayList,
  sizeCanvasForSlide,
} from '@betteroffice/pptx/viewer';
import type { OfficeRenderedPage } from '@/features/files/officeProtocol';
import { PptxImageCache } from './pptxImageCache';
import { canvasPage } from './runtimeMenus';

/** What rendering needs from a deck: the editor's or the viewer's handle. */
interface SlideSource {
  layoutSlide(slideIndex: number): SlideDisplayList;
  mediaBytes(assetId: string): Uint8Array;
}

/**
 * Slides as PNG pages for Capy's Print and PNG export, painted at twice
 * their size; a page measures the slide in CSS px.
 */
export async function renderSlides(
  source: SlideSource,
  indices: readonly number[]
): Promise<OfficeRenderedPage[]> {
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
  try {
    const pages: OfficeRenderedPage[] = [];
    for (const index of indices) {
      const frame = source.layoutSlide(index);
      const canvas = document.createElement('canvas');
      sizeCanvasForSlide(canvas, frame, 2);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('The slide could not be rendered');
      await paintSlide(context, frame, 2, 1, { resolveImage });
      pages.push(await canvasPage(canvas, frame.width, frame.height));
    }
    return pages;
  } finally {
    images.clear();
  }
}
