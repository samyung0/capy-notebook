import { parseHTML } from 'linkedom';
import type { ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { getLocale } from '@/i18n';
import type { OfficePositioner, OfficeRenderer } from './runtimeMenus';

// The locale resolves before a window exists, then linkedom's document goes
// in before react-dom/client loads (as FileViewer.test.tsx).
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
// A frame wide enough for page layout, and its font set.
Object.defineProperty(document.documentElement, 'clientWidth', {
  value: 1280,
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

// Each layout's viewer worker, answered by the test.
const workers: {
  answer: (family: string) => void;
  send: (data: unknown) => void;
}[] = [];
vi.mock('./docxViewerWorker', () => ({
  takeDocxViewerWorker: () => {
    const worker = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: () => {},
      terminate: () => {},
    };
    const send = (data: unknown) => worker.onmessage?.({ data });
    workers.push({
      answer: (family: string) => {
        send({
          faces: [],
          pages: [],
          sizes: [],
          sliced: [
            { bytes: new ArrayBuffer(1), families: [{ family }], id: family },
          ],
          type: 'pages',
        });
        send({ marks: {}, type: 'ready' });
      },
      send,
    });
    return worker;
  },
}));
// What the viewer was last given to draw.
const drawn: { pages: number; pending: number }[] = [];
vi.mock('@betteroffice/docx-react', () => ({
  DOCX_PAGES_PRESENTED_EVENT: 'docx-pages-presented',
  DocxDisplayListViewer: ({
    displayList,
    pendingPages,
  }: {
    displayList: { pages: unknown[] };
    pendingPages?: unknown[];
  }) => {
    drawn.push({
      pages: displayList.pages.length,
      pending: pendingPages?.length ?? 0,
    });
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
      onPositioner={noop}
      onRenderer={noop}
      onZoomChange={noop}
      {...props}
    />
  );
}

// Pages [from, to) of a five-page layout; the first batch carries every size.
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
    sizes: from === 0 ? Array.from({ length: 5 }, () => size) : undefined,
    sliced: [],
    type: 'pages',
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

it('draws the first pages before the rest are in, holding their space', async () => {
  const root = await open();
  await act(async () => sendPages(0, 2));
  await settle();
  expect(drawn.at(-1)).toEqual({ pages: 2, pending: 3 });

  await act(async () => sendPages(2, 5));
  await settle();
  expect(drawn.at(-1)).toEqual({ pages: 5, pending: 0 });
  await act(async () => root.unmount());
});

it('reports the first pages painted before every page is in, then the analysis', async () => {
  const onAnalysis = vi.fn();
  const onPainted = vi.fn();
  const root = await open({ onAnalysis, onPainted });
  await act(async () => sendPages(0, 2));
  await settle();
  await act(async () => present());
  expect(onPainted).toHaveBeenCalledWith({ format: 'docx', pageCount: 5 });
  expect(onAnalysis).not.toHaveBeenCalled();

  await act(async () => {
    sendPages(2, 5);
    sendReady();
  });
  await settle();
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

// Q608 A: View says where its reader is for the editor that follows it, as
// the editor's own positioner does: by body paragraph id, offsets counted
// from the paragraph's first fragment (here on the page before).
it('reads the scroll offset, the body paragraph at the top and the text-layer selection by paragraph id and offset', async () => {
  let positioner: OfficePositioner | null = null;
  const root = await open({
    onPositioner: (value) => {
      positioner = value;
    },
  });
  const text = (
    docStart: number,
    fromLine: number,
    fragmentDocStart: number
  ) => ({
    docStart,
    fragmentDocStart,
    fromLine,
    kind: 'text',
    paraId: 'P1',
  });
  await act(async () =>
    workers[0]?.send({
      faces: [],
      pages: [
        { ...size, pageIndex: 0, primitives: [text(11, 0, 10)] },
        { ...size, pageIndex: 1, primitives: [text(40, 3, 40)] },
      ],
      sizes: [size, size],
      sliced: [],
      type: 'pages',
    })
  );
  await settle();
  // The text layer the mocked viewer would draw: P1's first line on page 0,
  // its fourth on page 1, at the top of the scroll box.
  const host = document.querySelector<HTMLElement>('.docx-runtime-viewer')!;
  host.innerHTML = [0, 1]
    .map(
      (page) =>
        `<div class="layout-page-mirror" data-page-index="${page}"><div class="layout-page-content"><div class="layout-paragraph" data-para-id="P1" data-from-line="${page ? 3 : 0}"><span class="layout-run-text" data-doc-start="${page ? 40 : 11}" data-doc-end="${page ? 45 : 16}">${page ? 'world' : 'Hello'}</span></div></div></div>`
    )
    .join('');
  Object.defineProperty(host, 'scrollTop', { value: 1500.4 });
  const rect = (top: number, height: number) => () => ({
    bottom: top + height,
    height,
    top,
  });
  host.getBoundingClientRect = rect(0, 800) as never;
  const [first, second] = host.querySelectorAll<HTMLElement>('[data-para-id]');
  first!.getBoundingClientRect = rect(-900, 400) as never;
  second!.getBoundingClientRect = rect(-20, 300) as never;
  const [hello, world] = host.querySelectorAll('.layout-run-text');
  Object.assign(document, {
    getSelection: () => ({
      anchorNode: world!.firstChild,
      anchorOffset: 2,
      focusNode: hello!.firstChild,
      focusOffset: 1,
    }),
  });
  expect(positioner!.read()).toEqual({
    format: 'docx',
    scrollTop: 1500,
    // Text starts one past the paragraph's opening (10): "wo|rld" at 42.
    selection: {
      anchor: { offset: 31, paraId: 'P1', story: 'body' },
      head: { offset: 1, paraId: 'P1', story: 'body' },
    },
    top: { line: 3, offset: -20, paraId: 'P1' },
  });
  Reflect.deleteProperty(document, 'getSelection');
  await act(async () => root.unmount());
  expect(positioner).toBeNull();
});
