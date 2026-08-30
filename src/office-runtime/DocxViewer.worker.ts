/// <reference lib="webworker" />

import type { DisplayList } from '@betteroffice/docx/layout/render';
import { openDocumentViewer } from '@betteroffice/docx/viewer';

type Request = { bytes: ArrayBuffer; id: number };
type Response =
  | { displayList: DisplayList; id: number; pageCount: number; type: 'ready' }
  | { id: number; message: string; type: 'error' };

self.onmessage = (event: MessageEvent<Request>) => {
  const { bytes, id } = event.data;
  void openDocumentViewer(new Uint8Array(bytes)).then(
    (document) => {
      try {
        const displayList = document.displayList();
        post({
          displayList,
          id,
          pageCount: displayList.pages.length,
          type: 'ready',
        });
      } catch (value) {
        post({ id, message: toError(value).message, type: 'error' });
      } finally {
        document.dispose();
      }
    },
    (value: unknown) => {
      post({ id, message: toError(value).message, type: 'error' });
    }
  );
};

function post(message: Response) {
  self.postMessage(message);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
