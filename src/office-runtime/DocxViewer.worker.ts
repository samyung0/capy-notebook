/// <reference lib="webworker" />

import type { DisplayList } from '@betteroffice/docx/layout/render';
import {
  configureDefaultFonts,
  initWasm,
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
      type: 'ready';
    }
  | { id: number; message: string; type: 'error' };

// The viewer registers the faces the layout requires before laying out.
configureDefaultFonts({ fonts: officeFonts });
let fontFailure: Error | undefined;
onOfficeFontFailure((error) => {
  fontFailure ??= error;
});

// The engine loads as soon as the worker starts: the frame makes it before
// the file arrives when it knows a DOCX view is coming.
initWasm().catch(() => {});

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
