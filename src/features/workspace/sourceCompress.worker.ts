/// <reference lib="webworker" />

import { SOURCE_IMAGE_MAX_PIXELS } from '@/api/limits.generated';
import {
  fitImage,
  ImageTooLargeError,
  ImageTooManyPixelsError,
  ImageUnreadableError,
} from '@/lib/fitImage';
import { compressOfficeImages } from '@/lib/officeImages';
import type { CompressMessage, CompressResponse } from './sourceCompress';

// The page makes the copy of each error from its code.
const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: CompressResponse) => workerScope.postMessage(message);

workerScope.onmessage = async ({ data }: MessageEvent<CompressMessage>) => {
  try {
    if (data.compression === 'office') {
      const { file, removed } = await compressOfficeImages(
        data.file,
        data.imageMaxBytes,
        (done, total) =>
          post({ type: 'progress', value: Math.round((done / total) * 100) })
      );
      post({ file, removed, type: 'done' });
      return;
    }
    const file = await fitImage(data.file, data.maxBytes, {
      maxPixels: SOURCE_IMAGE_MAX_PIXELS,
      png: data.png,
    });
    post({ file, removed: 0, type: 'done' });
  } catch (error) {
    post({
      code:
        error instanceof ImageUnreadableError
          ? 'unreadable'
          : error instanceof ImageTooLargeError
            ? 'too_large'
            : error instanceof ImageTooManyPixelsError
              ? 'too_many_pixels'
              : 'failed',
      type: 'error',
    });
  }
};
