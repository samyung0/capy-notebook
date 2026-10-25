import { m } from '@/i18n';
import { CopyError } from '@/lib/copyError';
import { ImageUnreadableError, imageLimit } from '@/lib/fitImage';
import { pngFromSvg } from '@/lib/svgImage';
import type { SourceCompression } from './sourceUpload';

export interface CompressRequest {
  compression: SourceCompression;
  file: File;
  /** The uploader's plan image cap, for an Office file's pictures. */
  imageMaxBytes: number;
  /** The uploader's per-file cap, for an image source. */
  maxBytes: number;
}

export type CompressResponse =
  | { type: 'progress'; value: number }
  | { file: File; removed: number; type: 'done' }
  | {
      code: 'unreadable' | 'too_large' | 'too_many_pixels' | 'failed';
      type: 'error';
    };

/** Runs one source's compression in its own worker, which `signal` stops,
 * an SVG image drawn as a PNG first, on the page (Q364). Resolves the file to
 * upload (the picked one when nothing changed) and how many pictures nothing
 * can show were removed; an image no decoder reads or no size fits is
 * refused with its reason, final like the server's. */
export async function compressSource(
  picked: CompressRequest,
  onProgress: (value: number) => void,
  signal: AbortSignal
) {
  const png =
    picked.compression === 'image'
      ? await pngFromSvg(picked.file).catch((error: unknown) => {
          throw error instanceof ImageUnreadableError
            ? new CopyError(m.source_image_unreadable())
            : error;
        })
      : null;
  const request = png ? { ...picked, file: png } : picked;
  return new Promise<{ file: File; removed: number }>((resolve, reject) => {
    const worker = new Worker(
      new URL('./sourceCompress.worker.ts', import.meta.url),
      { name: 'source-compress', type: 'module' }
    );
    const stop = () => {
      worker.terminate();
      reject(signal.reason);
    };
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    const settle = () => {
      signal.removeEventListener('abort', stop);
      worker.terminate();
    };
    worker.onmessage = ({ data }: MessageEvent<CompressResponse>) => {
      if (data.type === 'progress') return onProgress(data.value);
      settle();
      if (data.type === 'done')
        return resolve({ file: data.file, removed: data.removed });
      reject(
        data.code === 'unreadable'
          ? new CopyError(m.source_image_unreadable())
          : data.code === 'too_large'
            ? new CopyError(
                m.image_too_large({ limit: imageLimit(request.maxBytes) })
              )
            : data.code === 'too_many_pixels'
              ? new CopyError(m.error_source_image_too_large_title())
              : new Error('source compression failed')
      );
    };
    worker.onerror = () => {
      settle();
      reject(new Error('source compression failed'));
    };
    worker.postMessage(request);
  });
}
