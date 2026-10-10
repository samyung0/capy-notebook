/// <reference lib="webworker" />

import { paintDisplayList } from '@betteroffice/xlsx/viewer';
import {
  encodeThumbnail,
  type ThumbnailRequest,
  type ThumbnailResponse,
  thumbnailCanvas,
} from './thumbnail';

// One XLSX list-card capture off the runtime's main thread
// (`sheetThumbnail` in xlsxRender.ts), then the worker is ended.
self.onmessage = (event: MessageEvent<ThumbnailRequest>) => {
  const { area, frame } = event.data;
  const fail = (value: unknown) =>
    self.postMessage({
      message: value instanceof Error ? value.message : String(value),
    } satisfies ThumbnailResponse);
  try {
    const { canvas, context, scale } = thumbnailCanvas(area.width, area.height);
    paintDisplayList(context, frame, scale);
    encodeThumbnail(canvas, context).then(
      (page) =>
        self.postMessage({ page } satisfies ThumbnailResponse, [page.bytes]),
      fail
    );
  } catch (error) {
    fail(error);
  }
};
