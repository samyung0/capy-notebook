import type { DisplayPage } from '@betteroffice/docx/layout/render';
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
// What the viewer was last given to draw, and its pages.
const drawn: { more: number | undefined; pages: number }[] = [];
let drawnPages: unknown[] = [];
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
    drawnPages = displayList.pages;
    return null;
  },
}));

// A print draws each page without a canvas; the pages it was given.
const rasterized: DisplayPage[] = [];
vi.mock('@betteroffice/docx/layout/render', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@betteroffice/docx/layout/render')
  >()),
  rasterizeDisplayPage: async (page: DisplayPage) => {
    rasterized.push(page);
    return { height: 1, width: 1 };
  },
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
const { DocxPage } = await import('./docxPages');

afterEach(() => {
  frameWidth = 1280;
  requests.length = 0;
  fonts.clear();
  loads.length = 0;
  workers.length = 0;
  drawn.length = 0;
  drawnPages = [];
  rasterized.length = 0;
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

// Q864 A: a cited open reads each compact page for its quote as it comes, so
// finding the quote once every page is in decodes none again.
it('reads each page of a cited open for its quote as it comes', async () => {
  const decode = vi.spyOn(DocxPage.prototype, 'decode');
  const root = await open({ citation: { quote: 'the quoted passage' } });
  const quoted = (pageIndex: number) => ({
    ...size,
    pageIndex,
    primitives: [
      {
        baselineY: 80,
        color: '#000',
        font: '16px Arial',
        kind: 'text',
        paraId: `P${pageIndex}`,
        text: pageIndex === 3 ? 'Here is the quoted passage.' : 'Other text.',
        width: 300,
        x: 20,
      },
    ],
  });
  const send = (from: number, to: number) =>
    workers[0]?.send({
      faces: [],
      pages: Array.from({ length: to - from }, (_, i) => quoted(from + i)),
      sliced: [],
      type: 'pages',
      width: size.width,
    });
  await act(async () => send(0, 2));
  await settle();
  expect(decode).toHaveBeenCalledTimes(2);
  // The pages the mocked viewer would draw, for the highlight.
  document.querySelector('.docx-runtime-viewer')!.innerHTML = [0, 1, 2, 3, 4]
    .map((page) => `<div><canvas data-page-index="${page}"></canvas></div>`)
    .join('');
  await act(async () => {
    send(2, 5);
    sendReady();
  });
  await settle();
  // linkedom draws no layout: the highlight's scroll does nothing.
  const div = Object.getPrototypeOf(document.createElement('div'));
  div.scrollIntoView = () => {};
  await act(async () => present());
  Reflect.deleteProperty(div, 'scrollIntoView');
  expect(decode).toHaveBeenCalledTimes(5);
  expect(
    document
      .querySelector('canvas[data-page-index="3"]')
      ?.parentElement?.querySelector('[data-citation-highlight]')
  ).not.toBeNull();
  decode.mockRestore();
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
  // Each page decoded for the print, in turn.
  expect(
    rasterized.map(({ pageIndex, primitives }) => [pageIndex, primitives])
  ).toEqual([0, 1, 2, 3, 4].map((pageIndex) => [pageIndex, []]));
  await act(async () => root.unmount());
});

// Q864 A: once every page is in, View keeps each page packed, its JSON
// deflated at idle time.
it('packs every page once all are in and the frame is idle', async () => {
  vi.useFakeTimers();
  try {
    const root = await open();
    await act(async () => {
      sendPages(0, 5);
      sendReady();
    });
    await act(async () => {
      for (const load of loads.splice(0)) load();
      // fflate loads once packing starts.
      await vi.dynamicImportSettled();
      await vi.runAllTimersAsync();
    });
    expect(drawnPages).toHaveLength(5);
    expect(
      drawnPages.every((page) => page instanceof DocxPage && page.packed)
    ).toBe(true);
    expect((drawnPages[4] as InstanceType<typeof DocxPage>).decode()).toEqual({
      ...size,
      pageIndex: 4,
      primitives: [],
    });
    await act(async () => root.unmount());
  } finally {
    vi.useRealTimers();
  }
});

// Q864 A: a page the worker sends again before `ready` (the first screen's
// pages, a CJK rename run) replaces the one before; that one is packed.
it('packs the page a worker sent again, not the one it replaced', async () => {
  vi.useFakeTimers();
  try {
    const root = await open();
    await act(async () => {
      sendPages(0, 5);
      workers[0]?.send({
        faces: [],
        pages: [{ ...size, pageIndex: 2, primitives: [{ kind: 'rect' }] }],
        sliced: [],
        type: 'pages',
        width: size.width,
      });
      sendReady();
    });
    await act(async () => {
      for (const load of loads.splice(0)) load();
      await vi.dynamicImportSettled();
      await vi.runAllTimersAsync();
    });
    const page = drawnPages[2] as InstanceType<typeof DocxPage>;
    expect(page.packed).toBe(true);
    expect(page.decode()).toEqual({
      ...size,
      pageIndex: 2,
      primitives: [{ kind: 'rect' }],
    });
    await act(async () => root.unmount());
  } finally {
    vi.useRealTimers();
  }
});

// Q805 A: an open that fails keeps the pages it showed, drawn and copyable as
// they came: none is packed.
it('keeps the pages of a failed open as they came', async () => {
  vi.useFakeTimers();
  try {
    const onError = vi.fn();
    const root = await open({ onError });
    await act(async () => {
      sendPages(0, 3);
      workers[0]?.send({ message: 'broken', type: 'error' });
    });
    await act(async () => {
      for (const load of loads.splice(0)) load();
      await vi.dynamicImportSettled();
      await vi.runAllTimersAsync();
    });
    expect(onError).toHaveBeenCalled();
    expect(drawnPages).toHaveLength(3);
    for (const page of drawnPages as InstanceType<typeof DocxPage>[]) {
      expect(page.packed).toBe(false);
      expect(page.decode()).toMatchObject({ pageIndex: page.pageIndex });
    }
    await act(async () => root.unmount());
  } finally {
    vi.useRealTimers();
  }
});

// Q864 A: with no citation the viewer reads no page for one, at the open's
// end or when a citation is cleared.
it('decodes no page for a citation it does not have', async () => {
  const decode = vi.spyOn(DocxPage.prototype, 'decode');
  const root = await open();
  await act(async () => {
    sendPages(0, 5);
    sendReady();
  });
  await settle();
  await act(async () => present());
  expect(decode).not.toHaveBeenCalled();

  // A cited open, its quote found, then the citation cleared.
  await act(async () =>
    root.render(viewer(new Uint8Array([2]), { citation: { quote: 'a quote' } }))
  );
  await act(async () => {
    workers[1]?.send({
      faces: [],
      pages: [{ ...size, pageIndex: 0, primitives: [] }],
      sliced: [],
      type: 'pages',
      width: size.width,
    });
    workers[1]?.send({ marks: {}, type: 'ready' });
  });
  await settle();
  await act(async () => present());
  const read = decode.mock.calls.length;
  await act(async () =>
    root.render(viewer(new Uint8Array([2]), { citation: null }))
  );
  expect(decode).toHaveBeenCalledTimes(read);
  decode.mockRestore();
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
      sliced: [],
      type: 'pages',
      width: size.width,
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
