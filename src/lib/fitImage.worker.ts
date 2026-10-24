/// <reference lib="webworker" />

import { baseLocale, overwriteGetLocale } from '@/i18n';
import {
  fitImage,
  ImageTooLargeError,
  ImageUnreadableError,
} from '@/lib/fitImage';
import type { FitRequest, FitResponse } from '@/lib/fitImageOffThread';

// A worker has no localStorage to read the locale from; the page makes the
// copy of each error from its code.
overwriteGetLocale(() => baseLocale);

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: FitResponse) => workerScope.postMessage(message);

workerScope.onmessage = async ({ data }: MessageEvent<FitRequest>) => {
  try {
    post({ file: await fitImage(data.file, data.maxBytes) });
  } catch (error) {
    post({
      code:
        error instanceof ImageUnreadableError
          ? 'unreadable'
          : error instanceof ImageTooLargeError
            ? 'too_large'
            : 'failed',
    });
  }
};
