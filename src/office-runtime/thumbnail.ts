import type { DisplayList } from '@betteroffice/xlsx/viewer';
import type { OfficeRenderedPage } from '@/features/files/officeProtocol';

/**
 * List-card captures of an edited file (openwiki/thumbnails.md, phase 2a), as
 * the ingest render makes them: 200 px wide WebP at quality 60, cut at 400 px
 * tall from the top. Shared by the runtime and the thumbnail worker.
 */
const WIDTH = 200;
const MAX_HEIGHT = 400;
const QUALITY = 0.6;

/**
 * A capture canvas for content `width` x `height` CSS px, and the scale to
 * draw it at. The fork's painters take its 2D context as they take a page
 * canvas's, as `slideToPng` does.
 */
export function thumbnailCanvas(width: number, height: number) {
  const scale = WIDTH / width;
  const canvas = new OffscreenCanvas(
    WIDTH,
    Math.max(1, Math.min(MAX_HEIGHT, Math.round(height * scale)))
  );
  const context = canvas.getContext(
    '2d'
  ) as unknown as CanvasRenderingContext2D | null;
  if (!context) throw new Error('The thumbnail could not be drawn');
  return { canvas, context, scale };
}

/** The capture on white as WebP; the canvas is released. */
export async function encodeThumbnail(
  canvas: OffscreenCanvas,
  context: CanvasRenderingContext2D
): Promise<OfficeRenderedPage> {
  const { height, width } = canvas;
  // Pages are white under anything the document leaves transparent.
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalCompositeOperation = 'destination-over';
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.restore();
  const blob = await canvas.convertToBlob({
    quality: QUALITY,
    type: 'image/webp',
  });
  canvas.width = 0;
  canvas.height = 0;
  if (blob.type !== 'image/webp')
    throw new Error('This browser does not encode WebP');
  return { bytes: await blob.arrayBuffer(), height, width };
}

/**
 * What the thumbnail worker paints and encodes: a sheet's display list (its
 * cells took one 40-55 ms task on the main thread, measured 2026-10-11), with
 * the system fonts the worker falls back to, which read the same at a
 * quarter scale.
 */
export type ThumbnailRequest = {
  area: { height: number; width: number };
  frame: DisplayList;
};

export type ThumbnailResponse =
  | { page: OfficeRenderedPage }
  | { message: string };

/** Resolves when the frame's main thread is next idle. */
export function idle() {
  return new Promise<void>((resolve) => requestIdleCallback(() => resolve()));
}
