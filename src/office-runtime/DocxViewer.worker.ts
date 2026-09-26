/// <reference lib="webworker" />

import type { DisplayList } from '@betteroffice/docx/layout/render';
import {
  configureDefaultFonts,
  openDocumentViewer,
} from '@betteroffice/docx/viewer';
import {
  type OfficeFace,
  officeFonts,
  onOfficeFontFailure,
  usedOfficeFaces,
} from './officeFonts';

type Request = { bytes: ArrayBuffer; id: number };
type Response =
  | {
      displayList: DisplayList;
      faces: OfficeFace[];
      id: number;
      pageCount: number;
      type: 'ready';
    }
  | { id: number; message: string; type: 'error' };

// The viewer registers the faces the layout requires before laying out.
configureDefaultFonts({ fonts: officeFonts });
let fontFailure: Error | undefined;
onOfficeFontFailure((error) => {
  fontFailure ??= error;
});

self.onmessage = (event: MessageEvent<Request>) => {
  const { bytes, id } = event.data;
  void openDocumentViewer(new Uint8Array(bytes)).then(
    (document) => {
      try {
        // A missing face would leave the fallback layout: fail instead.
        if (fontFailure) throw fontFailure;
        const displayList = document.displayList();
        post({
          displayList,
          faces: usedOfficeFaces(),
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
