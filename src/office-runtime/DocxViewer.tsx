import {
  createCanvasImageResolver,
  type DisplayList,
  type DisplayPage,
  rasterizeDisplayPage,
} from '@betteroffice/docx/layout/render';
import {
  DOCX_PAGES_PRESENTED_EVENT,
  DocxDisplayListViewer,
} from '@betteroffice/docx-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  OfficeAnalysis,
  OfficeCitation,
  OfficeLocale,
  OfficeRenderedPage,
  OfficeZoom,
} from '@/features/files/officeProtocol';
import { m } from '@/i18n';
import { officeMark, officeMarkAt } from '@/lib/officeMarks';
import { CITATION_FILL, docxCitation } from './citations';
import type {
  DocxViewerWorkerResponse,
  DocxViewport,
} from './DocxViewer.worker';
import { docxT, downloadMenu, printItem } from './docxMenus';
import { takeDocxViewerWorker } from './docxViewerWorker';
import {
  type OfficeFace,
  registerOfficeFaces,
  registerSlicedFaces,
  type SlicedOfficeFace,
} from './officeFonts';
import {
  canvasPage,
  type OfficeMenuReporter,
  type OfficeRenderer,
} from './runtimeMenus';
import { readViewToggle, writeViewToggle } from './viewToggles';

const ZOOMS = [50, 75, 90, 100, 125, 150, 200];
/** Each side of the reading layout's column, Capy's phone gutter. */
const READING_PADDING = 16;
/** A frame narrower than this (a phone, or a narrow panel beside others)
 * reads the reflowed column. */
const READING_BELOW_PX = 768;
/** Quiet time after a resize before the reading layout follows it. */
const RESIZE_SETTLE_MS = 200;

type Reading = { padding: number; width: number };

type Layout = {
  displayList: DisplayList;
  faces: OfficeFace[];
  marks: Record<string, number>;
  sliced: SlicedOfficeFace[];
};

/** The pages so far with the widest page of the document, and what this
 * batch paints with that none before did. */
type Arrival = {
  faces: OfficeFace[];
  pages: DisplayPage[];
  sliced: SlicedOfficeFace[];
  width: number;
};

/** Lays `bytes` out in a viewer worker of its own, as pages or, with
 * `reading`, as one column that wide, the pages `viewport` shows first. Each
 * batch of pages goes to `onPages` as it comes; the promise resolves with the
 * whole layout. The worker goes as soon as it is done, so the parser and
 * engine memory are released during ordinary reading. */
function layOut(
  bytes: Uint8Array,
  reading: Reading | null,
  viewport: DocxViewport,
  onPages?: (arrival: Arrival) => void
) {
  let cancel = () => {};
  const promise = new Promise<Layout>((resolve, reject) => {
    // Made at boot when the frame was opened for a DOCX view.
    const worker = takeDocxViewerWorker((message) => {
      stop();
      reject(new Error(message));
    });
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      worker.terminate();
    };
    // A print waiting for the whole layout fails rather than waits on.
    cancel = () => {
      stop();
      reject(new Error('The DOCX layout was cancelled'));
    };
    const pages: DisplayPage[] = [];
    const faces: OfficeFace[] = [];
    const sliced = new Map<string, SlicedOfficeFace>();
    worker.onmessage = ({ data }: MessageEvent<DocxViewerWorkerResponse>) => {
      if (data.type === 'pages') {
        for (const page of data.pages) pages[page.pageIndex] = page;
        faces.push(...data.faces);
        const changed = data.sliced.map(({ bytes, families, id }) => {
          // Only grown outlines come with bytes.
          const face = { bytes: bytes ?? sliced.get(id)!.bytes, families, id };
          sliced.set(id, face);
          return face;
        });
        onPages?.({
          faces: data.faces,
          pages: [...pages],
          sliced: changed,
          width: data.width,
        });
        return;
      }
      stop();
      if (data.type === 'error') reject(new Error(data.message));
      else
        resolve({
          displayList: { pages },
          faces,
          marks: data.marks,
          sliced: [...sliced.values()],
        });
    };
    const transferable = bytes.slice().buffer;
    worker.postMessage({ bytes: transferable, reading, viewport }, [
      transferable,
    ]);
  });
  return { cancel: () => cancel(), promise };
}

/** The frame's size: the first pages it shows are built first. */
function frameViewport(zoom: number | 'fit'): DocxViewport {
  const { clientHeight: height, clientWidth: width } = document.documentElement;
  return { height, width, zoom };
}

/** The frame's width, following resizes once they settle. */
function useFrameWidth() {
  const [width, setWidth] = useState(
    () => document.documentElement.clientWidth
  );
  useEffect(() => {
    let timer = 0;
    const resized = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => setWidth(document.documentElement.clientWidth),
        RESIZE_SETTLE_MS
      );
    };
    window.addEventListener('resize', resized);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', resized);
    };
  }, []);
  return width;
}

export function DocxViewer({
  bytes,
  citation,
  compact,
  initialZoom = 1,
  locale,
  onAnalysis,
  onError,
  onMenus,
  onPainted,
  onRenderer,
  onZoomChange,
}: {
  bytes: Uint8Array;
  citation: OfficeCitation | null;
  /** Below md: a pinch zooms the pages. */
  compact: boolean;
  /** 1 = 100%, or 'fit' to the pane: where the file was last shown. */
  initialZoom?: OfficeZoom;
  locale: OfficeLocale;
  /** Every page is in and the first are painted. */
  onAnalysis: (analysis: OfficeAnalysis) => void;
  onError: (error: Error) => void;
  onMenus: OfficeMenuReporter;
  /** The first pages are painted, before the rest are in, then again as
   * more come: the page count so far. */
  onPainted: (analysis: OfficeAnalysis) => void;
  onRenderer: (renderer: OfficeRenderer | null) => void;
  onZoomChange: (zoom: OfficeZoom) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  // The layout shown: its pages so far (more come as they are laid out),
  // whether all are in, the widest page of the document, the whole layout's
  // promise and what deletes the sliced faces registered for it (one
  // function per layout).
  const [shown, setShown] = useState<{
    complete: boolean;
    displayList: DisplayList;
    id: number;
    release: () => void;
    whole: Promise<DisplayList>;
    width: number;
  } | null>(null);
  const displayList = shown?.displayList ?? null;
  const release = shown?.release;
  useEffect(() => release, [release]);
  // In percent, as the menu lists it, or 'fit' until a level is picked.
  const [zoom, setZoom] = useState<number | 'fit'>(() =>
    initialZoom === 'fit' ? 'fit' : Math.round(initialZoom * 100)
  );
  // The level a new layout opens at, for the pages it builds first.
  const zoomRef = useRef(zoom);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(
    () => onZoomChange(zoom === 'fit' ? 'fit' : zoom / 100),
    [onZoomChange, zoom]
  );
  // View › Page layout, one choice per person for every DOCX file.
  const [pageLayout, setPageLayout] = useState(() =>
    readViewToggle('docxPageLayout')
  );
  // A narrow frame reads the text reflowed to its width, unless View › Page
  // layout is ticked.
  const frameWidth = useFrameWidth();
  const narrow = frameWidth < READING_BELOW_PX;
  const reading = narrow && !pageLayout;
  const readingWidth = reading ? frameWidth : 0;

  const showing = shown !== null;
  const complete = shown?.complete ?? false;

  // View mode offers what works here: Download and Print, and the zoom.
  useEffect(() => {
    if (!showing) return;
    const t = docxT(locale);
    onMenus({
      menus: [
        {
          id: 'file',
          items: [downloadMenu(locale), printItem(locale)],
          label: t('toolbar.file'),
        },
        {
          id: 'view',
          items: [
            // The reading layout is laid out at 100% for the frame's width.
            ...(reading
              ? []
              : [
                  {
                    icon: 'zoomIn' as const,
                    id: 'zoom',
                    items: ZOOMS.map((value) => ({
                      checked: value === zoom,
                      edits: false,
                      id: `zoom:${value}`,
                      kind: 'item' as const,
                      label: `${value}%`,
                    })),
                    kind: 'submenu' as const,
                    label: t('hostMenus.zoom'),
                  },
                ]),
            ...(narrow
              ? [
                  {
                    checked: !reading,
                    edits: false,
                    id: 'pageLayout',
                    kind: 'item' as const,
                    label: m.files_office_docx_page_layout(),
                  },
                ]
              : []),
          ],
          label: t('hostMenus.view'),
        },
      ],
      run: (id) => {
        const [command, value] = id.split(':');
        if (command === 'zoom') setZoom(Number(value));
        if (command === 'pageLayout') {
          writeViewToggle('docxPageLayout', !pageLayout);
          setPageLayout(!pageLayout);
        }
      },
    });
    return () => onMenus(null);
  }, [locale, narrow, onMenus, pageLayout, reading, showing, zoom]);

  const whole = shown?.whole;
  useEffect(() => {
    if (!whole) return;
    const resolveImage = createCanvasImageResolver();
    onRenderer(async (kind) => {
      if (kind !== 'print') throw new Error('Nothing to render');
      // A print waits for every page; the reading layout is one column, so
      // a print takes the pages.
      let printed = await whole;
      let release = () => {};
      if (reading) {
        const layout = await layOut(bytes, null, frameViewport(1)).promise;
        await registerOfficeFaces(layout.faces);
        release = await registerSlicedFaces(layout.sliced);
        printed = layout.displayList;
      }
      // One page drawn, encoded and released at a time, as pptxRender does;
      // a page that cannot be drawn fails the print.
      const pages: OfficeRenderedPage[] = [];
      try {
        for (const page of printed.pages) {
          const canvas = await rasterizeDisplayPage(page, { resolveImage });
          try {
            pages.push(await canvasPage(canvas, page.width, page.height));
          } finally {
            canvas.width = 0;
            canvas.height = 0;
          }
        }
      } finally {
        release();
      }
      return pages;
    });
    return () => onRenderer(null);
  }, [bytes, onRenderer, reading, whole]);

  // The open's stage marks belong to the first layout of these bytes, not to
  // a reading layout following a resize.
  const markedRef = useRef<Uint8Array | null>(null);
  const layoutsRef = useRef(0);
  useEffect(() => {
    // The reading layout waits for the frame's width.
    if (reading && !readingWidth) return;
    const id = ++layoutsRef.current;
    let cancelled = false;
    let showed = false;
    // This layout's sliced faces by id, registered as their pages arrive and
    // deleted together once another layout is shown or the viewer goes.
    const registered = new Map<string, () => void>();
    let released = false;
    const release = () => {
      released = true;
      for (const drop of registered.values()) drop();
      registered.clear();
    };
    // Each batch shows once its faces are registered, in order.
    let arrived = Promise.resolve();
    const job = layOut(
      bytes,
      reading ? { padding: READING_PADDING, width: readingWidth } : null,
      frameViewport(
        reading ? 1 : zoomRef.current === 'fit' ? 'fit' : zoomRef.current / 100
      ),
      ({ faces, pages, sliced, width }) => {
        arrived = arrived.then(async () => {
          // Paint with the faces the worker measured, under their Office
          // names, from the bytes it fetched.
          if (!showed) officeMark('fonts:start', { faces: faces.length });
          await registerOfficeFaces(faces);
          for (const face of sliced) {
            const drop = await registerSlicedFaces([face]);
            if (released) drop();
            else {
              // The face's earlier FontFaces go once the new ones paint.
              registered.get(face.id)?.();
              registered.set(face.id, drop);
            }
          }
          if (cancelled) return;
          if (!showed) officeMark('fonts:end');
          showed = true;
          setShown({
            complete: false,
            displayList: { pages },
            id,
            release,
            whole,
            width,
          });
        });
        // Awaited by `whole`, which reports a failure.
        arrived.catch(() => {});
      }
    );
    const whole = job.promise.then(async ({ displayList, marks }) => {
      await arrived;
      if (markedRef.current !== bytes) {
        markedRef.current = bytes;
        for (const [stage, epoch] of Object.entries(marks))
          officeMarkAt(stage, epoch);
      }
      return displayList;
    });
    void whole
      .then(() => {
        if (!cancelled)
          setShown((current) =>
            current?.id === id ? { ...current, complete: true } : current
          );
      })
      .catch((value: unknown) => {
        if (!cancelled)
          onError(value instanceof Error ? value : new Error(String(value)));
      });
    return () => {
      cancelled = true;
      job.cancel();
      // A layout never shown deletes its faces now; one shown keeps them
      // while its pages stay, until the next is shown.
      if (!showed) release();
    };
  }, [bytes, onError, reading, readingWidth]);

  // The layout whose first pages have been presented: a fitted first open
  // settles its level after the commit that mounts them.
  const [paintedId, setPaintedId] = useState(0);
  const layoutId = shown?.id ?? 0;
  const painted = layoutId !== 0 && paintedId === layoutId;
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!layoutId || !host) return;
    const presented = () => setPaintedId(layoutId);
    host.addEventListener(DOCX_PAGES_PRESENTED_EVENT, presented, {
      once: true,
    });
    return () =>
      host.removeEventListener(DOCX_PAGES_PRESENTED_EVENT, presented);
  }, [layoutId]);

  // The first pages are painted, and the page count grows as more come;
  // ready once every page is in. A file opened from a citation sends no
  // early paint: the host keeps its skeleton until every page is in and the
  // quote is found (Q802 B).
  const citedRef = useRef(citation);
  useEffect(() => {
    citedRef.current = citation;
  }, [citation]);
  const pagesSoFar = displayList?.pages.length ?? 0;
  useEffect(() => {
    if (painted && !citedRef.current)
      onPainted({ format: 'docx', pageCount: pagesSoFar });
  }, [onPainted, pagesSoFar, painted]);
  const pageCount = complete ? (displayList?.pages.length ?? 0) : 0;
  useEffect(() => {
    if (painted && complete) onAnalysis({ format: 'docx', pageCount });
  }, [complete, onAnalysis, pageCount, painted]);

  // A citation waits for every page: its quote must be unique in the file.
  const citedList = complete && painted ? displayList : null;
  useLayoutEffect(() => {
    const viewer = hostRef.current;
    if (!citedList || !viewer) return;
    const match = docxCitation(citedList, citation);
    const overlays: HTMLDivElement[] = [];
    for (const rect of match?.rects ?? []) {
      const canvas = viewer.querySelector<HTMLCanvasElement>(
        `canvas[data-page-index="${rect.page}"]`
      );
      const host = canvas?.parentElement;
      if (!canvas || !host) continue;
      const page = citedList.pages.find((page) => page.pageIndex === rect.page);
      if (!page) continue;
      // In percent of the page, so it follows every zoom, re-fit and pinch.
      const percent = (value: number, of: number) => `${(value / of) * 100}%`;
      const overlay = document.createElement('div');
      overlay.dataset.citationHighlight = 'true';
      overlay.setAttribute('aria-hidden', 'true');
      Object.assign(overlay.style, {
        background: CITATION_FILL,
        height: percent(rect.h, page.height),
        left: percent(rect.x, page.width),
        pointerEvents: 'none',
        position: 'absolute',
        top: percent(rect.y, page.height),
        width: percent(rect.w, page.width),
      });
      host.append(overlay);
      overlays.push(overlay);
    }
    overlays[0]?.scrollIntoView({ block: 'center' });
    return () => {
      for (const overlay of overlays) overlay.remove();
    };
  }, [citedList, citation]);

  return displayList ? (
    <div
      className="docx-runtime-viewer"
      data-reading={reading || undefined}
      ref={hostRef}
    >
      <DocxDisplayListViewer
        displayList={displayList}
        flush={reading}
        morePages={shown && !complete ? { width: shown.width } : undefined}
        onZoomChange={(level) => setZoom(Math.round(level * 100))}
        pinchZoom={compact && !reading}
        zoom={reading ? 1 : zoom === 'fit' ? 'fit' : zoom / 100}
      />
    </div>
  ) : null;
}
