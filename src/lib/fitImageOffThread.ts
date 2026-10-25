import { m } from '@/i18n';
import { CopyError } from '@/lib/copyError';
import { ImageUnreadableError, imageLimit } from '@/lib/fitImage';
import { pngFromSvg } from '@/lib/svgImage';

export interface FitRequest {
  file: File;
  maxBytes: number;
}

export type FitResponse =
  | { file: File }
  | { code: 'unreadable' | 'too_large' | 'failed' };

/** fitImage for a note, quiz, flashcard or bank image in its own worker, so
 * a large photo's decode and colour scan stay off the main thread (Q348,
 * review N5); an SVG is drawn as a PNG first, on the page (Q364). An image no
 * decoder reads or no size fits is refused with its copy. */
export async function fitImageOffThread(picked: File, maxBytes: number) {
  const file =
    (await pngFromSvg(picked).catch((error: unknown) => {
      throw error instanceof ImageUnreadableError
        ? new CopyError(m.image_unreadable())
        : error;
    })) ?? picked;
  return new Promise<File>((resolve, reject) => {
    const worker = new Worker(
      new URL('./fitImage.worker.ts', import.meta.url),
      {
        name: 'fit-image',
        type: 'module',
      }
    );
    worker.onmessage = ({ data }: MessageEvent<FitResponse>) => {
      worker.terminate();
      if ('file' in data) return resolve(data.file);
      reject(
        data.code === 'unreadable'
          ? new CopyError(m.image_unreadable())
          : data.code === 'too_large'
            ? new CopyError(m.image_too_large({ limit: imageLimit(maxBytes) }))
            : new Error('image compression failed')
      );
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error('image compression failed'));
    };
    worker.postMessage({ file, maxBytes } satisfies FitRequest);
  });
}
