import { m } from '@/i18n';
import { CopyError } from '@/lib/errors';

/** The server's cap on images uploaded through a quiz (editor_assets.go). */
export const QUIZ_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const MAX_SIDE = 2000;
const QUALITIES = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4];
const EXTENSION = /\.[^.]*$/;
const EXTENSIONS: Record<string, string> = {
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

/** Whether a picked image uploads as is, gets shrunk first, or is refused. */
export function shrinkPlan(
  file: Pick<File, 'size' | 'type'>,
  animated: boolean
): 'upload' | 'shrink' | 'too_large' {
  if (file.size <= QUIZ_IMAGE_MAX_BYTES) return 'upload';
  return animated || !SHRINKABLE.has(file.type) ? 'too_large' : 'shrink';
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

/** Returns the image to upload into a quiz: the file itself when it fits,
 * otherwise a resized WebP (transparency kept) at falling quality, or JPEG
 * (opaque) or PNG (transparent) where WebP cannot be encoded. Throws a
 * CopyError naming the 2 MB limit when nothing fits. */
export async function fitQuizImage(file: File): Promise<File> {
  const animated =
    file.type === 'image/gif' &&
    file.size > QUIZ_IMAGE_MAX_BYTES &&
    isAnimatedGif(new Uint8Array(await file.arrayBuffer()));
  const plan = shrinkPlan(file, animated);
  if (plan === 'upload') return file;
  if (plan === 'shrink') {
    const bitmap = await createImageBitmap(file);
    try {
      const { width, height } = fitSize(bitmap.width, bitmap.height);
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('2d canvas is unavailable');
      context.drawImage(bitmap, 0, 0, width, height);
      const encodeWithin = async (type: string) => {
        for (const quality of QUALITIES) {
          const blob = await canvas.convertToBlob({ quality, type });
          // A browser without the encoder returns PNG and ignores quality.
          if (blob.type !== type) return null;
          if (blob.size <= QUIZ_IMAGE_MAX_BYTES) return blob;
        }
        return null;
      };
      // Safari has no WebP encoder: JPEG for opaque images, PNG keeps alpha.
      const blob =
        (await encodeWithin('image/webp')) ??
        (hasAlpha(context.getImageData(0, 0, width, height).data)
          ? await canvas.convertToBlob({ type: 'image/png' })
          : await encodeWithin('image/jpeg'));
      if (blob && blob.size <= QUIZ_IMAGE_MAX_BYTES)
        return new File(
          [blob],
          `${file.name.replace(EXTENSION, '')}.${EXTENSIONS[blob.type] ?? 'png'}`,
          { type: blob.type }
        );
    } finally {
      bitmap.close();
    }
  }
  throw new CopyError(m.quiz_image_too_large());
}
