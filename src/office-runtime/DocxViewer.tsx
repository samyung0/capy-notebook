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
} from '@/features/files/officeProtocol';
import { CITATION_FILL, docxCitation } from './citations';
import { docxT, downloadMenu, printItem } from './docxMenus';
import { type OfficeFace, registerOfficeFaces } from './officeFonts';
import {
  canvasPage,
  type OfficeMenuReporter,
  type OfficeRenderer,
} from './runtimeMenus';

const ZOOMS = [50, 75, 90, 100, 125, 150, 200];

type WorkerResponse =
  | {
      displayList: DisplayList;
      faces: OfficeFace[];
      id: number;
      type: 'ready';
    }
  | { id: number; message: string; type: 'error' };

export function DocxViewer({
  bytes,
  citation,
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
  /** 1 = 100%, the level the file was last shown at. */
  initialZoom?: number;
  locale: OfficeLocale;
  onAnalysis: (analysis: OfficeAnalysis) => void;
  onError: (error: Error) => void;
  onMenus: OfficeMenuReporter;
  onRenderer: (renderer: OfficeRenderer | null) => void;
  onZoomChange: (zoom: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [displayList, setDisplayList] = useState<DisplayList | null>(null);
  // In percent, as the menu lists it.
  const [zoom, setZoom] = useState(() => Math.round(initialZoom * 100));
  useEffect(() => onZoomChange(zoom / 100), [onZoomChange, zoom]);

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
            {
              icon: 'zoomIn',
              id: 'zoom',
              items: ZOOMS.map((value) => ({
                checked: value === zoom,
                edits: false,
                id: `zoom:${value}`,
                kind: 'item' as const,
                label: `${value}%`,
              })),
              kind: 'submenu',
              label: t('hostMenus.zoom'),
            },
          ],
          label: t('hostMenus.view'),
        },
      ],
      run: (id) => {
        const [command, value] = id.split(':');
        if (command === 'zoom') setZoom(Number(value));
      },
    });
    return () => onMenus(null);
  }, [displayList, locale, onMenus, zoom]);

  useEffect(() => {
    if (!displayList) return;
    const resolveImage = createCanvasImageResolver();
    onRenderer(async (kind) => {
      if (kind !== 'print') throw new Error('Nothing to render');
      // One page drawn, encoded and released at a time, as pptxRender does;
      // a page that cannot be drawn fails the print.
      const pages: OfficeRenderedPage[] = [];
      for (const page of displayList.pages) {
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
  }, [displayList, onRenderer]);

  useEffect(() => {
    const worker = new Worker(
      new URL('./DocxViewer.worker.ts', import.meta.url),
      { type: 'module' }
    );
    const id = 1;
    let stopped = false;
    let cancelled = false;
    const stopWorker = () => {
      if (stopped) return;
      stopped = true;
      worker.terminate();
    };
    setDisplayList(null);
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.id !== id) return;
      if (event.data.type === 'error') {
        stopWorker();
        onError(new Error(event.data.message));
        return;
      }
      // The display list has been cloned into the iframe. Terminate now so the
      // parser, transient Yrs projection, and viewer WASM memory are released
      // during ordinary reading rather than waiting for edit/unmount.
      stopWorker();
      const { displayList, faces } = event.data;
      // Paint with the faces the worker measured, under their Office names.
      void registerOfficeFaces(faces).then(
        () => {
          if (!cancelled) setDisplayList(displayList);
        },
        (value: unknown) => {
          if (!cancelled)
            onError(value instanceof Error ? value : new Error(String(value)));
        }
      );
    };
    worker.onerror = (event) => {
      stopWorker();
      onError(new Error(event.message));
    };
    const transferable = bytes.slice().buffer;
    worker.postMessage({ bytes: transferable, id }, [transferable]);
    return () => {
      cancelled = true;
      stopWorker();
    };
  }, [bytes, onError]);

  // Ready once the first pages are painted.
  useEffect(() => {
    const host = hostRef.current;
    if (!displayList || !host) return;
    const painted = () =>
      onAnalysis({ format: 'docx', pageCount: displayList.pages.length });
    host.addEventListener(DOCX_PAGES_PRESENTED_EVENT, painted, { once: true });
    return () => host.removeEventListener(DOCX_PAGES_PRESENTED_EVENT, painted);
  }, [displayList, onAnalysis]);

  useLayoutEffect(() => {
    if (!displayList) return;
    const match = docxCitation(displayList, citation);
    const overlays: HTMLDivElement[] = [];
    for (const rect of match?.rects ?? []) {
      const canvas = hostRef.current?.querySelector<HTMLCanvasElement>(
        `canvas[data-page-index="${rect.page}"]`
      );
      const host = canvas?.parentElement;
      if (!canvas || !host) continue;
      const page = displayList.pages.find(
        (page) => page.pageIndex === rect.page
      );
      if (!page) continue;
      const scale = canvas.getBoundingClientRect().width / page.width;
      const overlay = document.createElement('div');
      overlay.dataset.citationHighlight = 'true';
      overlay.setAttribute('aria-hidden', 'true');
      Object.assign(overlay.style, {
        background: CITATION_FILL,
        height: `${rect.h * scale}px`,
        left: `${rect.x * scale}px`,
        pointerEvents: 'none',
        position: 'absolute',
        top: `${rect.y * scale}px`,
        width: `${rect.w * scale}px`,
      });
      host.append(overlay);
      overlays.push(overlay);
    }
    overlays[0]?.scrollIntoView({ block: 'center' });
    return () => {
      for (const overlay of overlays) overlay.remove();
    };
  }, [displayList, citation, zoom]);

  return displayList ? (
    <div className="docx-runtime-viewer" ref={hostRef}>
      <DocxDisplayListViewer displayList={displayList} zoom={zoom / 100} />
    </div>
  ) : null;
}
