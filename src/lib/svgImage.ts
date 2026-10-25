import { IMAGE_MAX_SIDE } from '@/api/limits.generated';
import {
  fitSize,
  ImageUnreadableError,
  isSvgImage,
  SVG_ROOT,
} from '@/lib/fitImage';

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
  if (box?.length === 4 && box[2] > 0 && box[3] > 0) {
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

/** A picked image that is an SVG (by its content) as a PNG, so servers
 * receive no SVG image (Q364); null for any other image. It is drawn on the
 * page, since a worker has no image element and createImageBitmap refuses
 * an SVG: through an <img> from a blob URL, where an SVG runs no script and
 * loads nothing external. One that does not load or has no size throws an
 * ImageUnreadableError. The name takes .png; the compressor then treats the
 * PNG as any picked image. */
export async function pngFromSvg(file: File): Promise<File | null> {
  if (!isSvgImage(new Uint8Array(await file.slice(0, 4096).arrayBuffer())))
    return null;
  const url = URL.createObjectURL(new Blob([file], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode().catch(() => {
      throw new ImageUnreadableError();
    });
    const size = svgSize(await file.text(), {
      height: image.naturalHeight,
      width: image.naturalWidth,
    });
    if (!size) throw new ImageUnreadableError();
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2d canvas is unavailable');
    context.drawImage(image, 0, 0, size.width, size.height);
    const png = await canvas.convertToBlob({ type: 'image/png' });
    return new File([png], `${file.name.replace(EXTENSION, '')}.png`, {
      type: 'image/png',
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
