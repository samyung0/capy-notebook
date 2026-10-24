import { ImageTooLargeError, ImageUnreadableError } from '@/lib/fitImage';

export interface FitRequest {
  file: File;
  maxBytes: number;
}

export type FitResponse =
  | { file: File }
  | { code: 'unreadable' | 'too_large' | 'failed' };

/** fitImage for a note, quiz, flashcard or bank image in its own worker, so
 * a large photo's decode and colour scan stay off the main thread (Q348,
 * review N5). Throws what fitImage throws. */
export function fitImageOffThread(file: File, maxBytes: number) {
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
          ? new ImageUnreadableError()
          : data.code === 'too_large'
            ? new ImageTooLargeError(maxBytes)
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
