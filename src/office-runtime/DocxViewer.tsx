import {
  createCanvasImageResolver,
  type DisplayList,
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
import { docxT, downloadMenu, printItem } from './docxMenus';
import { takeDocxViewerWorker } from './docxViewerWorker';
import { type OfficeFace, registerOfficeFaces } from './officeFonts';
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
};

type WorkerResponse =
  | (Layout & { type: 'ready' })
  | { message: string; type: 'error' };

/** Lays `bytes` out in a viewer worker of its own, as pages or, with
 * `reading`, as one column that wide. The worker goes as soon as it answers,
 * so the parser and engine memory are released during ordinary reading. */
function layOut(bytes: Uint8Array, reading: Reading | null) {
  let stop = () => {};
  const promise = new Promise<Layout>((resolve, reject) => {
    // Made at boot when the frame was opened for a DOCX view.
    const worker = takeDocxViewerWorker((message) => {
      stop();
      reject(new Error(message));
    });
    let stopped = false;
    stop = () => {
      if (stopped) return;
      stopped = true;
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      stop();
      if (event.data.type === 'error') reject(new Error(event.data.message));
      else resolve(event.data);
    };
    const transferable = bytes.slice().buffer;
    worker.postMessage({ bytes: transferable, reading }, [transferable]);
  });
  return { cancel: () => stop(), promise };
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
  onAnalysis: (analysis: OfficeAnalysis) => void;
  onError: (error: Error) => void;
  onMenus: OfficeMenuReporter;
  onRenderer: (renderer: OfficeRenderer | null) => void;
  onZoomChange: (zoom: OfficeZoom) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [displayList, setDisplayList] = useState<DisplayList | null>(null);
  // In percent, as the menu lists it, or 'fit' until a level is picked.
  const [zoom, setZoom] = useState<number | 'fit'>(() =>
    initialZoom === 'fit' ? 'fit' : Math.round(initialZoom * 100)
  );
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

  // View mode offers what works here: Download and Print, and the zoom.
  useEffect(() => {
    if (!displayList) return;
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
  }, [displayList, locale, narrow, onMenus, pageLayout, reading, zoom]);

  useEffect(() => {
    if (!displayList) return;
    const resolveImage = createCanvasImageResolver();
    onRenderer(async (kind) => {
      if (kind !== 'print') throw new Error('Nothing to render');
      // The reading layout is one column: a print takes the pages.
      let printed = displayList;
      if (reading) {
        const layout = await layOut(bytes, null).promise;
        await registerOfficeFaces(layout.faces);
        printed = layout.displayList;
      }
      // One page drawn, encoded and released at a time, as pptxRender does;
      // a page that cannot be drawn fails the print.
      const pages: OfficeRenderedPage[] = [];
      for (const page of printed.pages) {
        const canvas = await rasterizeDisplayPage(page, { resolveImage });
        try {
          pages.push(await canvasPage(canvas, page.width, page.height));
        } finally {
          canvas.width = 0;
          canvas.height = 0;
        }
      }
      return pages;
    });
    return () => onRenderer(null);
  }, [bytes, displayList, onRenderer, reading]);

  // The open's stage marks belong to the first layout of these bytes, not to
  // a reading layout following a resize.
  const markedRef = useRef<Uint8Array | null>(null);
  useEffect(() => {
    // The reading layout waits for the frame's width.
    if (reading && !readingWidth) return;
    let cancelled = false;
    const job = layOut(
      bytes,
      reading ? { padding: READING_PADDING, width: readingWidth } : null
    );
    void job.promise
      .then(async ({ displayList, faces, marks }) => {
        if (markedRef.current !== bytes) {
          markedRef.current = bytes;
          for (const [stage, epoch] of Object.entries(marks))
            officeMarkAt(stage, epoch);
        }
        // Paint with the faces the worker measured, under their Office
        // names, from the bytes it fetched.
        officeMark('fonts:start', { faces: faces.length });
        await registerOfficeFaces(faces);
        officeMark('fonts:end');
        if (!cancelled) setDisplayList(displayList);
      })
      .catch((value: unknown) => {
        if (!cancelled)
          onError(value instanceof Error ? value : new Error(String(value)));
      });
    return () => {
      cancelled = true;
      job.cancel();
    };
  }, [bytes, onError, reading, readingWidth]);

  // Ready once the first pages are painted.
  useEffect(() => {
    const host = hostRef.current;
    if (!displayList || !host) return;
    const painted = () =>
      onAnalysis({ format: 'docx', pageCount: displayList.pages.length });
    host.addEventListener(DOCX_PAGES_PRESENTED_EVENT, painted, { once: true });
    return () => host.removeEventListener(DOCX_PAGES_PRESENTED_EVENT, painted);
  }, [displayList, onAnalysis]);

  // Whether the pages have been presented: a fitted first open settles its
  // level after the commit that mounts them.
  const presentedRef = useRef(false);
  useLayoutEffect(() => {
    presentedRef.current = false;
    const host = hostRef.current;
    if (!displayList || !host) return;
    const presented = () => {
      presentedRef.current = true;
    };
    host.addEventListener(DOCX_PAGES_PRESENTED_EVENT, presented, {
      once: true,
    });
    return () =>
      host.removeEventListener(DOCX_PAGES_PRESENTED_EVENT, presented);
  }, [displayList]);

  useLayoutEffect(() => {
    const viewer = hostRef.current;
    if (!displayList || !viewer) return;
    const match = docxCitation(displayList, citation);
    const overlays: HTMLDivElement[] = [];
    for (const rect of match?.rects ?? []) {
      const canvas = viewer.querySelector<HTMLCanvasElement>(
        `canvas[data-page-index="${rect.page}"]`
      );
      const host = canvas?.parentElement;
      if (!canvas || !host) continue;
      const page = displayList.pages.find(
        (page) => page.pageIndex === rect.page
      );
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
    const center = () => overlays[0]?.scrollIntoView({ block: 'center' });
    if (presentedRef.current) center();
    else
      viewer.addEventListener(DOCX_PAGES_PRESENTED_EVENT, center, {
        once: true,
      });
    return () => {
      viewer.removeEventListener(DOCX_PAGES_PRESENTED_EVENT, center);
      for (const overlay of overlays) overlay.remove();
    };
  }, [displayList, citation]);

  return displayList ? (
    <div
      className="docx-runtime-viewer"
      data-reading={reading || undefined}
      ref={hostRef}
    >
      <DocxDisplayListViewer
        displayList={displayList}
        flush={reading}
        onZoomChange={(level) => setZoom(Math.round(level * 100))}
        pinchZoom={compact && !reading}
        zoom={reading ? 1 : zoom === 'fit' ? 'fit' : zoom / 100}
      />
    </div>
  ) : null;
}
