import { parseHTML } from 'linkedom';
import type { ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { getLocale } from '@/i18n';
import type { OfficeRenderer } from './runtimeMenus';

// The locale resolves before a window exists, then linkedom's document goes
// in before react-dom/client loads (as FileViewer.test.tsx).
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
// A frame wide enough for page layout unless a test narrows it, and its
// font set.
let frameWidth = 1280;
Object.defineProperty(document.documentElement, 'clientWidth', {
  get: () => frameWidth,
});
const fonts = new Set<FakeFontFace>();
Object.assign(document, {
  fonts: {
    add: (face: FakeFontFace) => fonts.add(face),
    delete: (face: FakeFontFace) => fonts.delete(face),
  },
});
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

// FontFaces whose loads the test settles.
const loads: (() => void)[] = [];
class FakeFontFace {
  readonly family: string;
  constructor(family: string) {
    this.family = family;
  }
  load() {
    return new Promise<void>((resolve) => loads.push(resolve));
  }
}
vi.stubGlobal('FontFace', FakeFontFace);

// Each layout's viewer worker, answered by the test, and what each was asked.
const requests: unknown[] = [];
const workers: {
  answer: (family: string) => void;
  send: (data: unknown) => void;
}[] = [];
vi.mock('./docxViewerWorker', () => ({
  takeDocxViewerWorker: () => {
    const worker = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (request: unknown) => requests.push(request),
      terminate: () => {},
    };
    const send = (data: unknown) => worker.onmessage?.({ data });
    workers.push({
      answer: (family: string) => {
        send({
          faces: [],
          pages: [],
          sliced: [
            { bytes: new ArrayBuffer(1), families: [{ family }], id: family },
          ],
          type: 'pages',
          width: 816,
        });
        send({ marks: {}, type: 'ready' });
      },
      send,
    });
    return worker;
  },
}));
// What the viewer was last given to draw.
const drawn: { more: number | undefined; pages: number }[] = [];
vi.mock('@betteroffice/docx-react', () => ({
  DOCX_PAGES_PRESENTED_EVENT: 'docx-pages-presented',
  DocxDisplayListViewer: ({
    displayList,
    morePages,
  }: {
    displayList: { pages: unknown[] };
    morePages?: { width: number };
  }) => {
    drawn.push({ more: morePages?.width, pages: displayList.pages.length });
    return null;
  },
}));

// A print draws each page without a canvas.
vi.mock('@betteroffice/docx/layout/render', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@betteroffice/docx/layout/render')
  >()),
  rasterizeDisplayPage: async () => ({ height: 1, width: 1 }),
}));
vi.mock('./runtimeMenus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runtimeMenus')>()),
  canvasPage: async (_canvas: unknown, width: number, height: number) => ({
    height,
    width,
  }),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { DocxViewer } = await import('./DocxViewer');

afterEach(() => {
  frameWidth = 1280;
  requests.length = 0;
  fonts.clear();
  loads.length = 0;
  workers.length = 0;
  drawn.length = 0;
});

const families = () => [...fonts].map((face) => face.family);
const settle = () =>
  act(async () => {
    for (const load of loads.splice(0)) load();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

function viewer(
  bytes: Uint8Array,
  props: Partial<ComponentProps<typeof DocxViewer>> = {}
) {
  const noop = () => {};
  return (
    <DocxViewer
      bytes={bytes}
      citation={null}
      compact={false}
      locale="en"
      onAnalysis={noop}
      onError={noop}
      onMenus={noop}
      onPainted={noop}
      onRenderer={noop}
      onZoomChange={noop}
      {...props}
    />
  );
}

// Pages [from, to) of a five-page layout, whose widest page is wider.
const size = { height: 1056, width: 816 };
const sendPages = (from: number, to: number) =>
  workers[0]?.send({
    faces: [],
    pages: Array.from({ length: to - from }, (_, i) => ({
      height: size.height,
      pageIndex: from + i,
      primitives: [],
      width: size.width,
    })),
    // The sizes of every page a C6 worker sent with its first pages: the
    // count follows the pages that came, not these.
    sizes: from === 0 ? Array.from({ length: 5 }, () => size) : undefined,
    sliced: [],
    type: 'pages',
    width: 1056,
  });
const sendReady = () => workers[0]?.send({ marks: {}, type: 'ready' });
// The viewer's first pages on screen.
const present = () =>
  document
    .querySelector('.docx-runtime-viewer')
    ?.dispatchEvent(new window.Event('docx-pages-presented'));

async function open(props: Partial<ComponentProps<typeof DocxViewer>> = {}) {
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById('root') as never);
  await act(async () => root.render(viewer(new Uint8Array([1]), props)));
  return root;
}

it("registers a layout's sliced faces for it alone: a new layout replaces them, unmounting deletes them", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById('root') as never);
  await act(async () => root.render(viewer(new Uint8Array([1]))));
  await act(async () => workers[0]?.answer('BetterOffice Sliced 1.0'));
  await settle();
  expect(families()).toEqual(['BetterOffice Sliced 1.0']);

  // Other bytes lay out again; the first layout's faces go with it.
  await act(async () => root.render(viewer(new Uint8Array([2]))));
  await act(async () => workers[1]?.answer('BetterOffice Sliced 1.1'));
  await settle();
  expect(families()).toEqual(['BetterOffice Sliced 1.1']);

  await act(async () => root.unmount());
  expect(families()).toEqual([]);
});

it('deletes the faces of an open cancelled while they loaded', async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById('root') as never);
  await act(async () => root.render(viewer(new Uint8Array([1]))));
  await act(async () => workers[0]?.answer('BetterOffice Sliced 1.0'));
  // Unmounted before the faces finished loading.
  await act(async () => root.unmount());
  await settle();
  expect(families()).toEqual([]);
});

// Q801 B: the pages, the scroll height with them, grow as they come; the
// widest page of the document holds the fit until every page is in.
it('draws the pages as they come, fitting the widest page to come until every page is in', async () => {
  const root = await open();
  expect(requests).toMatchObject([{ reading: null, whole: false }]);
  await act(async () => sendPages(0, 2));
  await settle();
  expect(drawn.at(-1)).toEqual({ more: 1056, pages: 2 });

  await act(async () => sendPages(2, 5));
  await settle();
  expect(drawn.at(-1)).toEqual({ more: 1056, pages: 5 });

  await act(async () => sendReady());
  await settle();
  expect(drawn.at(-1)).toEqual({ more: undefined, pages: 5 });
  await act(async () => root.unmount());
});

it('reports the first pages painted with the page count so far, growing as more come, then the analysis', async () => {
  const onAnalysis = vi.fn();
  const onPainted = vi.fn();
  const root = await open({ onAnalysis, onPainted });
  await act(async () => sendPages(0, 2));
  await settle();
  await act(async () => present());
  expect(onPainted).toHaveBeenLastCalledWith({ format: 'docx', pageCount: 2 });

  await act(async () => sendPages(2, 4));
  await settle();
  expect(onPainted).toHaveBeenLastCalledWith({ format: 'docx', pageCount: 4 });
  expect(onAnalysis).not.toHaveBeenCalled();

  await act(async () => {
    sendPages(4, 5);
    sendReady();
  });
  await settle();
  expect(onPainted).toHaveBeenLastCalledWith({ format: 'docx', pageCount: 5 });
  expect(onAnalysis).toHaveBeenCalledWith({ format: 'docx', pageCount: 5 });
  await act(async () => root.unmount());
});

// Q802 B: the host keeps its skeleton until `ready`, then shows the quote.
it('sends a cited open no early paint: it is ready once every page is in', async () => {
  const onAnalysis = vi.fn();
  const onPainted = vi.fn();
  const root = await open({
    citation: { quote: 'a quote' },
    onAnalysis,
    onPainted,
  });
  // Q823 A: it waits for every page, so the worker lays them all out first.
  expect(requests).toMatchObject([{ whole: true }]);
  await act(async () => sendPages(0, 2));
  await settle();
  await act(async () => present());
  await act(async () => {
    sendPages(2, 5);
    sendReady();
  });
  await settle();
  expect(onAnalysis).toHaveBeenCalledWith({ format: 'docx', pageCount: 5 });
  expect(onPainted).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it('prints every page, waiting for those still to come', async () => {
  let renderer: OfficeRenderer | null = null;
  const root = await open({
    onRenderer: (value) => {
      renderer = value;
    },
  });
  await act(async () => sendPages(0, 2));
  await settle();
  let printed: unknown;
  const printing = renderer!('print').then((pages) => {
    printed = pages;
  });
  await settle();
  expect(printed).toBeUndefined();

  await act(async () => {
    sendPages(2, 5);
    sendReady();
  });
  await settle();
  await printing;
  expect(printed).toHaveLength(5);
  await act(async () => root.unmount());
});

// Q823 A: a print of the reading layout lays the pages out whole first.
it('prints a reading layout from pages laid out whole', async () => {
  frameWidth = 360;
  let renderer: OfficeRenderer | null = null;
  const root = await open({
    onRenderer: (value) => {
      renderer = value;
    },
  });
  expect(requests).toMatchObject([{ reading: { width: 360 }, whole: false }]);
  await act(async () => {
    sendPages(0, 5);
    sendReady();
  });
  await settle();
  const printing = renderer!('print');
  await settle();
  expect(requests[1]).toMatchObject({ reading: null, whole: true });

  await act(async () => {
    workers[1]?.send({
      faces: [],
      pages: Array.from({ length: 3 }, (_, pageIndex) => ({
        ...size,
        pageIndex,
        primitives: [],
      })),
      sliced: [],
      type: 'pages',
      width: size.width,
    });
    workers[1]?.send({ marks: {}, type: 'ready' });
  });
  expect(await printing).toHaveLength(3);
  await act(async () => root.unmount());
});
