import type { OfficeRenderedPage } from '@/features/files/officeProtocol';

/**
 * List-card captures of an edited file (openwiki/thumbnails.md, phase 2a), as
 * the ingest render makes them: 200 px wide WebP at quality 60, cut at 400 px
 * tall from the top.
 */
const WIDTH = 200;
const MAX_HEIGHT = 400;
const QUALITY = 0.6;

/** A capture canvas for content `width` x `height` CSS px, and the scale to draw it at. */
export function thumbnailCanvas(width: number, height: number) {
  const scale = WIDTH / width;
  const element = document.createElement('canvas');
  element.width = WIDTH;
  element.height = Math.max(
    1,
    Math.min(MAX_HEIGHT, Math.round(height * scale))
  );
  const context = element.getContext('2d');
  if (!context) throw new Error('The thumbnail could not be drawn');
  return { context, element, scale };
}

/** The canvas as WebP bytes, on white; the canvas is released. */
export async function thumbnailPage(
  element: HTMLCanvasElement,
  context: CanvasRenderingContext2D
): Promise<OfficeRenderedPage> {
  const { height, width } = element;
  // Pages are white under anything the document leaves transparent.
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalCompositeOperation = 'destination-over';
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.restore();
  const blob = await new Promise<Blob | null>((resolve) =>
    element.toBlob(resolve, 'image/webp', QUALITY)
  );
  element.width = 0;
  element.height = 0;
  if (blob?.type !== 'image/webp')
    throw new Error('This browser does not encode WebP');
  return { bytes: await blob.arrayBuffer(), height, width };
}

/** Resolves when the frame's main thread is next idle. */
export function idle() {
  return new Promise<void>((resolve) => requestIdleCallback(() => resolve()));
}
