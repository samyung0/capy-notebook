/// <reference lib="webworker" />

import { SOURCE_IMAGE_MAX_PIXELS } from '@/api/limits.generated';
import { baseLocale, overwriteGetLocale } from '@/i18n';
import {
  fitImage,
  ImageTooLargeError,
  ImageTooManyPixelsError,
  ImageUnreadableError,
} from '@/lib/fitImage';
import { compressOfficeImages } from '@/lib/officeImages';
import type { CompressRequest, CompressResponse } from './sourceCompress';

// A worker has no localStorage to read the locale from. The copy of errors
// made here is never shown: the page maps their codes to its own.
overwriteGetLocale(() => baseLocale);

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: CompressResponse) => workerScope.postMessage(message);

workerScope.onmessage = async ({ data }: MessageEvent<CompressRequest>) => {
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
