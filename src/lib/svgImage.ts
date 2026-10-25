import { IMAGE_MAX_SIDE } from '@/api/limits.generated';
import {
  fitSize,
  ImageUnreadableError,
  isSvgImage,
  SVG_ROOT,
} from '@/lib/fitImage';

const decoder = new TextDecoder();
/** How much of a picked SVG is read for its root tag's size attributes,
 * when a long prolog or attribute list takes the tag past the 4 KiB the
 * detection reads. */
const ROOT_HEAD = 64 << 10;
const ROOT_TAG = /^<svg\b[^>]*>/;
const ATTRIBUTE = /\s(width|height|viewBox)\s*=\s*(["'])(.*?)\2/g;
const BOX_SEPARATOR = /[\s,]+/;
const EXTENSION = /\.[^.]*$/;

/** The size an SVG is drawn at: its own (the browser's natural size, within
 * IMAGE_MAX_SIDE) when its root names a width and a height, else its
 * viewBox's aspect ratio at IMAGE_MAX_SIDE on the long side (Q364), else
 * the browser's natural size if it has one; null when nothing sizes it. */
export function svgSize(
  text: string,
  natural: { height: number; width: number }
) {
  const prolog = SVG_ROOT.exec(text);
  const root = prolog
    ? (ROOT_TAG.exec(text.slice(prolog[0].length - 5))?.[0] ?? '')
    : '';
  const named = new Map(
    [...root.matchAll(ATTRIBUTE)].map(([, name, , value]) => [
      name,
      value.trim(),
    ])
  );
  const drawable = natural.width > 0 && natural.height > 0;
  const sized = ['width', 'height'].every(
    (name) => named.get(name) && !named.get(name)?.endsWith('%')
  );
  if (sized && drawable)
    return fitSize(natural.width, natural.height, IMAGE_MAX_SIDE);
  const box = named.get('viewBox')?.split(BOX_SEPARATOR).map(Number);
  if (
    box?.length === 4 &&
    box.every(Number.isFinite) &&
    box[2] > 0 &&
    box[3] > 0
  ) {
    const scale = IMAGE_MAX_SIDE / Math.max(box[2], box[3]);
    return {
      height: Math.max(1, Math.round(box[3] * scale)),
      width: Math.max(1, Math.round(box[2] * scale)),
    };
  }
  return drawable
    ? fitSize(natural.width, natural.height, IMAGE_MAX_SIDE)
    : null;
}

/** The image drawn at `size` and encoded as PNG. */
async function encodePng(
  image: HTMLImageElement,
  { height, width }: { height: number; width: number }
) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2d canvas is unavailable');
  context.drawImage(image, 0, 0, width, height);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** A picked image that is an SVG (by its content) as a PNG, so servers
 * receive no SVG image (Q364); null for any other image. It is drawn on the
 * page, since a worker has no image element and createImageBitmap refuses
 * an SVG: through an <img> from a blob URL, where an SVG runs no script and
 * loads nothing external. One that does not load, has no size, or cannot be
 * drawn or encoded (a tainted canvas) throws an ImageUnreadableError. The
 * name takes .png, and the compressor keeps it PNG (`png`). */
export async function pngFromSvg(file: File): Promise<File | null> {
  // Only heads are read on the page; the <img> parses the file itself.
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  if (!isSvgImage(head)) return null;
  const url = URL.createObjectURL(new Blob([file], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode().catch(() => {
      throw new ImageUnreadableError();
    });
    const root = await file.slice(0, ROOT_HEAD).arrayBuffer();
    const size = svgSize(decoder.decode(root), {
      height: image.naturalHeight,
      width: image.naturalWidth,
    });
    if (!size) throw new ImageUnreadableError();
    // One that cannot be drawn or encoded never will be (review r4 N2).
    const png = await encodePng(image, size).catch(() => {
      throw new ImageUnreadableError();
    });
    return new File([png], `${file.name.replace(EXTENSION, '')}.png`, {
      type: 'image/png',
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
