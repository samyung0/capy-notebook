import { m } from '@/i18n';
// Not errors.ts, which pulls in the API client: the Office runtime loads this.
import { CopyError } from '@/lib/copyError';

/** Bank figures' flat cap (server/internal/bank/assets.go); editor images take
 * the uploader's plan cap from the material (`imageMaxBytes`). */
export const BANK_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/** The image types the server stores as editor images (no SVG). */
export const IMAGE_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,image/avif';
const MAX_SIDE = 2000;
const QUALITIES = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4];
const EXTENSION = /\.[^.]*$/;
/** The image types the server stores as editor images, by the extension its
 * reservation wants (server/internal/httpapi/editor_assets.go). */
export const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const SHRINKABLE = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
/** The image types older Word, PowerPoint, LibreOffice and Google Docs
 * imports open inside DOCX/PPTX; an Office file gets every other type
 * re-encoded, whatever its size (Epo 2026-10-13). */
const OFFICE_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png']);
/** Smaller long sides a transparent image for an Office file is drawn at,
 * as PNG, until one fits the cap. */
const OFFICE_PNG_STEPS = [1400, 1000];

/** A byte cap as the image messages name it. */
export const imageLimit = (maxBytes: number) =>
  `${Math.round(maxBytes / 1024 ** 2)} MB`;

/** A picked image that nothing it can be shrunk to fits under `maxBytes`. */
export class ImageTooLargeError extends CopyError {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(m.image_too_large({ limit: imageLimit(maxBytes) }));
    this.maxBytes = maxBytes;
  }
}

/** A picked image the browser cannot decode (TIFF, HEIC or SVG in Chrome),
 * so it cannot be shrunk or re-encoded. */
export class ImageUnreadableError extends CopyError {
  constructor() {
    super(m.image_unreadable());
  }
}

/** True when a GIF holds more than one frame: each frame's graphic control
 * extension (21 F9 04, four bytes, terminator) precedes an image or another
 * extension. */
export function isAnimatedGif(bytes: Uint8Array) {
  let frames = 0;
  for (let i = 0; i + 8 < bytes.length; i++) {
    if (
      bytes[i] === 0x21 &&
      bytes[i + 1] === 0xf9 &&
      bytes[i + 2] === 0x04 &&
      bytes[i + 7] === 0x00 &&
      (bytes[i + 8] === 0x2c || bytes[i + 8] === 0x21) &&
      ++frames > 1
    )
      return true;
  }
  return false;
}

/** Whether a picked image uploads as is, gets shrunk (re-encoded) first, or
 * is refused; for an Office file only PNG, JPEG and GIF can go in as is. */
export function shrinkPlan(
  file: Pick<File, 'size' | 'type'>,
  animated: boolean,
  maxBytes: number,
  office = false
): 'upload' | 'shrink' | 'too_large' {
  if (file.size <= maxBytes && (!office || OFFICE_TYPES.has(file.type)))
    return 'upload';
  if (animated) return 'too_large';
  return office || SHRINKABLE.has(file.type) ? 'shrink' : 'too_large';
}

/** True when any pixel is not fully opaque (RGBA bytes). */
export function hasAlpha(rgba: Uint8ClampedArray) {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) return true;
  return false;
}

/** Fits the long side within maxSide without upscaling. */
export function fitSize(width: number, height: number, maxSide = MAX_SIDE) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    height: Math.max(1, Math.round(height * scale)),
    width: Math.max(1, Math.round(width * scale)),
  };
}

/** Returns the image to upload under maxBytes: the file itself when it fits,
 * otherwise a resized WebP (transparency kept) at falling quality, or JPEG
 * (opaque) or PNG (transparent) where WebP cannot be encoded. For an `office`
 * file (DOCX/PPTX) it is never WebP, every type but PNG, JPEG and GIF is
 * re-encoded, and a transparent image too large as PNG is drawn smaller
 * (OFFICE_PNG_STEPS). Throws an ImageTooLargeError when nothing fits, an
 * ImageUnreadableError when the image cannot be decoded. */
export async function fitImage(
  file: File,
  maxBytes: number,
  { office = false } = {}
): Promise<File> {
  const animated =
    file.type === 'image/gif' &&
    file.size > maxBytes &&
    isAnimatedGif(new Uint8Array(await file.arrayBuffer()));
  const plan = shrinkPlan(file, animated, maxBytes, office);
  if (plan === 'upload') return file;
  if (plan === 'shrink') {
    const bitmap = await createImageBitmap(file).catch(() => {
      throw new ImageUnreadableError();
    });
    try {
      const draw = (side: number) => {
        const { width, height } = fitSize(bitmap.width, bitmap.height, side);
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('2d canvas is unavailable');
        context.drawImage(bitmap, 0, 0, width, height);
        return { canvas, context };
      };
      const { canvas, context } = draw(MAX_SIDE);
      const encodeWithin = async (type: string) => {
        for (const quality of QUALITIES) {
          const blob = await canvas.convertToBlob({ quality, type });
          // A browser without the encoder returns PNG and ignores quality.
          if (blob.type !== type) return null;
          if (blob.size <= maxBytes) return blob;
        }
        return null;
      };
      // Safari has no WebP encoder and Office files take none: JPEG for
      // opaque images, PNG keeps alpha.
      let blob = office ? null : await encodeWithin('image/webp');
      if (!blob) {
        const { width, height } = canvas;
        if (hasAlpha(context.getImageData(0, 0, width, height).data)) {
          let side = Math.max(width, height);
          blob = await canvas.convertToBlob({ type: 'image/png' });
          for (const step of office ? OFFICE_PNG_STEPS : [])
            if (blob.size > maxBytes && step < side) {
              side = step;
              blob = await draw(step).canvas.convertToBlob({
                type: 'image/png',
              });
            }
        } else blob = await encodeWithin('image/jpeg');
      }
      if (blob && blob.size <= maxBytes)
        return new File(
          [blob],
          `${file.name.replace(EXTENSION, '')}.${IMAGE_EXTENSIONS[blob.type] ?? 'png'}`,
          { type: blob.type }
        );
    } finally {
      bitmap.close();
    }
  }
  throw new ImageTooLargeError(maxBytes);
}
