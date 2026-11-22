/// <reference lib="webworker" />

import type { DisplayPage } from '@betteroffice/docx/layout/render';
import {
  configureDefaultFonts,
  type DocxPageSize,
  type DocxViewerPages,
  type DocxViewerSlicedFace,
  initWasm,
  openDocumentViewer,
} from '@betteroffice/docx/viewer';
import { epochNow } from '@/lib/officeMarks';
import {
  keepOfficeFontBytes,
  type OfficeFace,
  officeViewerFonts,
  onOfficeFontFailure,
  openFailure,
  paintedFamilies,
  type SlicedOfficeFace,
  slicedOfficeFaces,
  usedOfficeFaces,
} from './officeFonts';

/** Where the pages open: those it shows at the top go first. */
export type DocxViewport = {
  height: number;
  width: number;
  zoom: number | 'fit';
};

/** One layout per worker: pages, or with `reading` one column that wide. */
type Request = {
  bytes: ArrayBuffer;
  reading: { padding: number; width: number } | null;
  viewport: DocxViewport;
};
export type DocxViewerWorkerResponse =
  | {
      /** The faces these pages paint with that no batch before sent. */
      faces: OfficeFace[];
      /** In order, each at its `pageIndex`: a page sent again replaces the
       * one before. */
      pages: DisplayPage[];
      /** The widest page of the whole document, known before its pages are. */
      width: number;
      /** Sliced faces whose outlines (`bytes`) or painted families grew. */
      sliced: (Omit<SlicedOfficeFace, 'bytes'> & { bytes?: ArrayBuffer })[];
      type: 'pages';
    }
  | {
      /** Stage times (epoch ms) for the frame to mark. */
      marks: Record<string, number>;
      type: 'ready';
    }
  | { message: string; type: 'error' };

// The viewer registers the faces the layout requires before laying out.
configureDefaultFonts({ fonts: officeViewerFonts });
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

/** How many pages the viewport shows at the top, plus one, from the sizes of
 * the pages laid out so far and the widest page of the document. */
function firstPages(
  sizes: readonly DocxPageSize[],
  width: number,
  viewport: DocxViewport
) {
  const zoom =
    viewport.zoom === 'fit'
      ? Math.min(1, viewport.width / width)
      : viewport.zoom;
  let shown = 0;
  for (let top = 0; shown < sizes.length && top < viewport.height; shown++)
    top += sizes[shown].height * zoom;
  return shown + 1;
}

self.onmessage = (event: MessageEvent<Request>) => {
  const { bytes, reading, viewport } = event.data;
  const marks: Record<string, number> = { 'worker:open-start': epochNow() };
  // What the batches so far sent: whole faces by family, weight and style,
  // and each sliced face's painted families.
  const sentFaces = new Set<string>();
  const sliced = new Map<
    string,
    { family: string; sent: string; slices: DocxViewerSlicedFace['slices'] }
  >();
  const painted = new Set<string>();
  const progressive = {
    firstPages(sizes: readonly DocxPageSize[], width: number) {
      // The layout of the first pages, or of every page when the body
      // can't be cut after them.
      marks['worker:first-layout-end'] = epochNow();
      return firstPages(sizes, width, viewport);
    },
    onPages({ pages, slicedFaces, width }: DocxViewerPages) {
      // A missing face would leave the fallback layout: fail instead.
      if (fontFailure) throw fontFailure;
      for (const family of paintedFamilies(pages)) painted.add(family);
      const faces = usedOfficeFaces(pages).filter(({ face, family }) => {
        const key = `${family}|${face.weight}|${face.style}`;
        if (sentFaces.has(key)) return false;
        sentFaces.add(key);
        return true;
      });
      const grown = new Map(
        slicedFaces.map((face) => [face.family, face.bytes])
      );
      for (const { family, slices } of slicedFaces)
        if (!sliced.has(family))
          sliced.set(family, { family, sent: '', slices });
      const changed = slicedOfficeFaces([...sliced.values()], painted).flatMap(
        ({ families, id }) => {
          const entry = sliced.get(id)!;
          const key = JSON.stringify(families);
          if (!grown.has(id) && entry.sent === key) return [];
          entry.sent = key;
          return [{ bytes: grown.get(id), families, id }];
        }
      );
      marks['worker:first-pages'] ??= epochNow();
      self.postMessage(
        {
          faces,
          pages,
          sliced: changed,
          type: 'pages',
          width,
        } satisfies DocxViewerWorkerResponse,
        // Outlines come in a new buffer each time.
        changed.flatMap(({ bytes }) => (bytes ? [bytes] : []))
      );
    },
  };
  void openDocumentViewer(
    new Uint8Array(bytes),
    reading ? { progressive, reading } : { progressive }
  ).then(
    async (document) => {
      document.dispose();
      post({
        marks: {
          ...marks,
          'wasm:docx-view:end': await wasm,
          'wasm:docx-view:start': wasmStart,
          'worker:open-end': epochNow(),
        },
        type: 'ready',
      });
    },
    // A slice that fails fails the open, naming its file.
    (value: unknown) => {
      post({ message: openFailure(value).message, type: 'error' });
    }
  );
};

function post(message: DocxViewerWorkerResponse) {
  self.postMessage(message);
}
