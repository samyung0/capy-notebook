// The long side every image is resized within (Epo 2026-10-20, Q286), from
// the gateway's header check (server/internal/imagecheck), which refuses a
// larger one.
// No copy here: the compression workers load this, and the page makes the
// copy of each error where it shows it.
import { IMAGE_MAX_SIDE } from '@/api/limits.generated';

/** Bank figures' flat cap (server/internal/bank/assets.go); editor images take
 * the uploader's plan cap from the material (`imageMaxBytes`). */
export const BANK_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/** The image types the server stores as editor images (no SVG). */
export const IMAGE_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,image/avif';
/** JPEG and WebP quality of the first encode (Epo 2026-10-20). */
const QUALITY = 0.85;
/** Over the cap: the long side a lossy image is drawn at for its falling
 * qualities, and the long sides a transparent PNG is drawn at (Epo
 * 2026-10-13). */
const SHRINK_SIDE = 2000;
const QUALITIES = [0.85, 0.8, 0.7, 0.6, 0.5, 0.4];
const PNG_SIDES = [2000, 1400, 1000];
/** An opaque image of at most this many colours is a flat graphic, PNG in
 * an Office file. */
const FLAT_COLOURS = 256;
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
/** The image types older Word, PowerPoint, LibreOffice and Google Docs
 * imports open inside DOCX/PPTX; an Office file gets every other type
 * re-encoded (Epo 2026-10-13). */
const OFFICE_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png']);

/** An SVG's root element, after any XML declaration, comments and doctype,
 * as the server checks find it. */
export const SVG_ROOT =
  /^(?:\s|<\?[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*<svg[\s>/]/;

const decoder = new TextDecoder();

/** Whether an image is an SVG, by its root element in the first 4 KiB (the
 * decoder drops a byte-order mark). */
export function isSvgImage(bytes: Uint8Array) {
  return SVG_ROOT.test(decoder.decode(bytes.subarray(0, 4096)));
}

/** A byte cap as the image messages name it. */
export const imageLimit = (maxBytes: number) =>
  `${Math.round(maxBytes / 1024 ** 2)} MB`;

/** A picked image that nothing it can be shrunk to fits under `maxBytes`. */
export class ImageTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`no compression of the image fits ${maxBytes} bytes`);
    this.maxBytes = maxBytes;
  }
}

/** A picked image no decoder reads (SVG, PSD, a corrupt file), so it cannot
 * be shrunk or re-encoded. */
export class ImageUnreadableError extends Error {
  constructor() {
    super('no decoder reads the image');
  }
}

/** An animated GIF source past the pixel limit: a canvas keeps one frame, so
 * it cannot be shrunk. */
export class ImageTooManyPixelsError extends Error {
  constructor() {
    super('the animated GIF is past the pixel limit');
  }
}

/** A source's image type by its first bytes when it is one the server
 * measures and keeps (Q344): PNG, JPEG, GIF or WebP. A source of any other
 * format is re-saved even within the pixel limit. */
function sourceType(head: Uint8Array) {
  const at = (offset: number, ...values: number[]) =>
    values.every((value, i) => head[offset + i] === value);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
    return 'image/webp';
  return null;
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

/** Fits the long side within maxSide without upscaling. */
export function fitSize(width: number, height: number, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    height: Math.max(1, Math.round(height * scale)),
    width: Math.max(1, Math.round(width * scale)),
  };
}

/** Fits the area within maxPixels without upscaling, rounding down so the
 * result never passes it. */
export function fitArea(width: number, height: number, maxPixels: number) {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  return {
    height: Math.max(1, Math.floor(height * scale)),
    width: Math.max(1, Math.floor(width * scale)),
  };
}

/** Whether any pixel is not fully opaque and, for an opaque image, whether it
 * holds at most FLAT_COLOURS colours (RGBA bytes). */
export function pixelTraits(rgba: Uint8ClampedArray) {
  const colours = new Set<number>();
  let flat = true;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 255) return { alpha: true, flat: false };
    if (flat) {
      colours.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
      flat = colours.size <= FLAT_COLOURS;
    }
  }
  return { alpha: false, flat };
}

/** The picked image as a bitmap. One the browser cannot read (HEIC/HEIF,
 * TIFF, JPEG 2000) goes through a decoder loaded for it (Q294, Q333). */
async function decode(file: File) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (bitmap) return bitmap;
  const pixels = await decodeLazily(file);
  if (!pixels) throw new ImageUnreadableError();
  return createImageBitmap(
    new ImageData(pixels.data, pixels.width, pixels.height)
  );
}

async function decodeLazily(file: File) {
  const { decodeUncommon } = await import('@/lib/decodeImage');
  try {
    return await decodeUncommon(file);
  } catch {
    return null;
  }
}

/** Compresses every image (Epo 2026-10-20, Q285, Q286): the long side within
 * IMAGE_MAX_SIDE, then WebP at QUALITY for a note (JPEG, or PNG when
 * transparent, where the browser has no WebP encoder) and, for an `office`
 * file (DOCX/PPTX/XLSX), JPEG for a photo and PNG for a transparent image or
 * a flat graphic, never WebP. The original is kept when it needs no resize,
 * fits `maxBytes`, is a type its target takes and the result is not smaller.
 * A result over `maxBytes` is shrunk: a lossy one at SHRINK_SIDE with falling
 * quality, a transparent PNG at PNG_SIDES. An animated GIF is kept within the
 * side and the cap and refused past either, since a canvas keeps one frame.
 * Throws an ImageTooLargeError when nothing fits, an ImageUnreadableError
 * when the image cannot be decoded. With `maxPixels` (an image uploaded as a
 * source, Epo 2026-10-24) the area is the limit instead of the side, a PNG,
 * JPEG, GIF or WebP within it is kept as it is (Q344), anything else takes
 * the Office rules, and an animated GIF past it throws an
 * ImageTooManyPixelsError. The import worker applies the same rules
 * (pipeline/pipeline/ingest/images.py). */
export async function fitImage(
  file: File,
  maxBytes: number,
  {
    maxPixels = 0,
    office = maxPixels > 0,
  }: { maxPixels?: number; office?: boolean } = {}
): Promise<File> {
  const bitmap = await decode(file);
  try {
    const target = maxPixels
      ? fitArea(bitmap.width, bitmap.height, maxPixels)
      : fitSize(bitmap.width, bitmap.height, IMAGE_MAX_SIDE);
    const resized =
      target.width !== bitmap.width || target.height !== bitmap.height;
    if (
      maxPixels &&
      !resized &&
      sourceType(new Uint8Array(await file.slice(0, 12).arrayBuffer()))
    )
      return file;
    if (
      file.type === 'image/gif' &&
      isAnimatedGif(new Uint8Array(await file.arrayBuffer()))
    ) {
      if (!resized && file.size <= maxBytes) return file;
      throw maxPixels && resized
        ? new ImageTooManyPixelsError()
        : new ImageTooLargeError(maxBytes);
    }
    const draw = ({ height, width } = target, smooth = true) => {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('2d canvas is unavailable');
      context.imageSmoothingEnabled = smooth;
      if (smooth) context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, width, height);
      return { canvas, context };
    };
    // Read from a nearest-neighbour sample, which holds only the image's own
    // colours, so a resized flat graphic still reads as one.
    const sample = draw(target, !resized);
    const { alpha, flat } = pixelTraits(
      sample.context.getImageData(0, 0, target.width, target.height).data
    );
    const canvas = resized ? draw().canvas : sample.canvas;
    const encode = async (
      from: OffscreenCanvas,
      type: string,
      quality?: number
    ) => {
      const blob = await from.convertToBlob({ quality, type });
      // A browser without the encoder returns PNG and ignores quality.
      return blob.type === type ? blob : null;
    };
    const lossless = alpha || (office && flat);
    let type = lossless ? 'image/png' : 'image/jpeg';
    let blob = office ? null : await encode(canvas, 'image/webp', QUALITY);
    if (blob) type = 'image/webp';
    else blob = await encode(canvas, type, QUALITY);
    if (!blob) throw new ImageTooLargeError(maxBytes);
    const keeps = office
      ? OFFICE_TYPES.has(file.type)
      : file.type in IMAGE_EXTENSIONS;
    if (!resized && keeps && file.size <= maxBytes && blob.size >= file.size)
      return file;
    const named = (result: Blob) =>
      new File(
        [result],
        `${file.name.replace(EXTENSION, '')}.${IMAGE_EXTENSIONS[result.type]}`,
        { type: result.type }
      );
    if (blob.size <= maxBytes) return named(blob);
    const longSide = Math.max(target.width, target.height);
    if (alpha && type === 'image/png') {
      for (const side of PNG_SIDES) {
        if (side >= longSide) continue;
        blob = await draw(
          fitSize(bitmap.width, bitmap.height, side)
        ).canvas.convertToBlob({ type });
        if (blob.size <= maxBytes) return named(blob);
      }
    } else {
      // An opaque PNG too large is a photo after all: JPEG.
      if (type === 'image/png') type = 'image/jpeg';
      const small =
        longSide > SHRINK_SIDE
          ? draw(fitSize(bitmap.width, bitmap.height, SHRINK_SIDE)).canvas
          : canvas;
      for (const quality of QUALITIES) {
        blob = await encode(small, type, quality);
        if (blob && blob.size <= maxBytes) return named(blob);
      }
    }
    throw new ImageTooLargeError(maxBytes);
  } finally {
    bitmap.close();
  }
}
