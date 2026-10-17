/// <reference lib="webworker" />

import type { DisplayList } from '@betteroffice/docx/layout/render';
import {
  configureDefaultFonts,
  initWasm,
  openDocumentViewer,
} from '@betteroffice/docx/viewer';
import { epochNow } from '@/lib/officeMarks';
import {
  keepOfficeFontBytes,
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
      /** Stage times (epoch ms) for the frame to mark. */
      marks: Record<string, number>;
      type: 'ready';
    }
  | { id: number; message: string; type: 'error' };

// The viewer registers the faces the layout requires before laying out.
configureDefaultFonts({ fonts: officeFonts });
keepOfficeFontBytes();
let fontFailure: Error | undefined;
onOfficeFontFailure((error) => {
  fontFailure ??= error;
});

// The engine loads as soon as the worker starts: the frame makes it before
// the file arrives when it knows a DOCX view is coming.
const wasmStart = epochNow();
const wasm = initWasm().then(epochNow);
wasm.catch(() => {});

self.onmessage = (event: MessageEvent<Request>) => {
  const { bytes, id } = event.data;
  const openStart = epochNow();
  void openDocumentViewer(new Uint8Array(bytes)).then(
    async (document) => {
      try {
        // A missing face would leave the fallback layout: fail instead.
        if (fontFailure) throw fontFailure;
        const openEnd = epochNow();
        const displayList = document.displayList();
        const faces = usedOfficeFaces(displayList);
        post(
          {
            displayList,
            faces,
            id,
            marks: {
              'wasm:docx-view:end': await wasm,
              'wasm:docx-view:start': wasmStart,
              'worker:display-list': epochNow(),
              'worker:open-end': openEnd,
              'worker:open-start': openStart,
            },
            type: 'ready',
          },
          // One face's bytes can stand for two family names.
          [...new Set(faces.map((face) => face.bytes))]
        );
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

function post(message: Response, transfer: Transferable[] = []) {
  self.postMessage(message, transfer);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
