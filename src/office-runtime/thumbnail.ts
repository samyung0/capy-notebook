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
  return { bytes: imageOnlyWebP(await blob.arrayBuffer()), height, width };
}

/** A DOCX editor's print pages, drawn one at a time (`renderPages`). */
type RenderPages = (
  each: (page: {
    canvas: HTMLCanvasElement;
    height: number;
    width: number;
  }) => Promise<unknown>
) => Promise<unknown[]>;

/** Ends `renderPages` once page 1 is captured: no later page is drawn. */
class FirstPage extends Error {
  readonly page: OfficeRenderedPage;
  constructor(page: OfficeRenderedPage) {
    super('Page 1 is captured');
    this.page = page;
  }
}

/**
 * DOCX page 1 as a list-card capture, as ingest renders it: Print's raster of
 * the page (twice its CSS size, on the main thread, where the document's
 * fonts are) drawn down to 200 px wide. `renderPages` waits for an edit's
 * layout to land, so null (no page) is never a finished capture: the host
 * keeps the capture cycle open for it.
 */
export async function pageThumbnail(
  renderPages: RenderPages
): Promise<OfficeRenderedPage | null> {
  try {
    await renderPages(async ({ canvas, height, width }) => {
      const capture = thumbnailCanvas(width, height);
      // An 8x reduction: the default smoothing leaves text unreadable.
      capture.context.imageSmoothingQuality = 'high';
      capture.context.drawImage(
        canvas,
        0,
        0,
        capture.canvas.width,
        height * capture.scale
      );
      throw new FirstPage(
        await encodeThumbnail(capture.canvas, capture.context)
      );
    });
    return null;
  } catch (error) {
    if (error instanceof FirstPage) return error.page;
    throw error;
  }
}

const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));

/**
 * The WebP as its image chunk alone, the only layout Go takes besides one
 * with alpha. Chrome writes an sRGB ICC profile before the image (VP8X with
 * the ICC flag, then ICCP), which browsers assume without it; a capture is
 * opaque, so there is no ALPH chunk to keep.
 */
export function imageOnlyWebP(webp: ArrayBuffer): ArrayBuffer {
  const view = new DataView(webp);
  for (let at = 12; at + 8 <= webp.byteLength; ) {
    const id = String.fromCharCode(...new Uint8Array(webp, at, 4));
    const size = view.getUint32(at + 4, true);
    const length = 8 + size + (size % 2);
    if (id === 'ALPH') throw new Error('The capture has an alpha channel');
    if (id === 'VP8 ' || id === 'VP8L') {
      const out = new Uint8Array(12 + length);
      out.set([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')]);
      new DataView(out.buffer).setUint32(4, 4 + length, true);
      out.set(new Uint8Array(webp, at, length), 12);
      return out.buffer;
    }
    at += length;
  }
  throw new Error('The capture has no image');
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
