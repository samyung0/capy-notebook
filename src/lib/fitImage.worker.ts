/// <reference lib="webworker" />

import {
  fitImage,
  ImageTooLargeError,
  ImageUnreadableError,
} from '@/lib/fitImage';
import type { FitRequest, FitResponse } from '@/lib/fitImageOffThread';

// The page makes the copy of each error from its code.
const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: FitResponse) => workerScope.postMessage(message);

workerScope.onmessage = async ({ data }: MessageEvent<FitRequest>) => {
  try {
    post({
      file: await fitImage(data.file, data.maxBytes, { png: data.png }),
    });
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
