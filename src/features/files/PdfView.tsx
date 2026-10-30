import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import type { Region } from '@/api/types';
import { Skeleton } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Toolbar } from '@/components/ui/Toolbar';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { m } from '@/i18n';
import { useHorizontalWheelScroll } from '@/lib/useHorizontalWheelScroll';
import { CitationOverlay } from './CitationOverlay';
import { normalizeCitationRegions } from './citationRegions';
import { FileModeControl, useFileMode } from './FileModeControl';
import { FileError } from './FileStates';
import { FileHeaderTarget } from './fileModeContext';
import { PdfAnnotations } from './PdfAnnotations';
import { keepPdfPlace } from './pdfPlace';
import { scrollToCenter } from './scrollToCenter';

// Keep PDF rendering available under the app's CSP and while offline.
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const PAGE_OVERSCAN_PX = 1200;
/* Fit as pdf.js's "auto" zoom does (Firefox's default): a portrait page fills
   the pane's width less a gutter, a landscape one fits whole in the pane, and
   neither grows past 125% of the page's own size, where 10 pt body text reads
   like the app's. 100% draws a PDF point at 96/72 CSS px. */
const MAX_AUTO_SCALE = 1.25;
const PDF_TO_CSS_UNITS = 96 / 72;
/** Both sides' gutter together, pdf.js's SCROLLBAR_PADDING. */
const PAGE_GUTTER_PX = 40;

type Size = { height: number; width: number };

/** The CSS width the first page fits at; every page takes it. */
function autoPageWidth(page: Size, pane: Size) {
  const width = page.width * PDF_TO_CSS_UNITS;
  const height = page.height * PDF_TO_CSS_UNITS;
  const widthScale = (pane.width - PAGE_GUTTER_PX) / width;
  const fit =
    page.width > page.height
      ? Math.min(widthScale, (pane.height - PAGE_GUTTER_PX) / height)
      : widthScale;
  return Math.max(0, Math.floor(width * Math.min(MAX_AUTO_SCALE, fit)));
}

// TODO: better UX for PDF highlighting and overlays. Until then the annotation
// tools and the Edit/View switch stay hidden; saved marks still draw.
const ANNOTATION_TOOLS = false;

/** How long a citation box shows; matches the overlay's animation. */
const CITATION_FLASH_MS = 1600;

// A fresh regions array per citation click (openCitation copies it), so a
// second click on the same citation scrolls and flashes again.
const citationClicks = new WeakMap<Region[], number>();
let lastCitationClick = 0;
function citationClick(regions: Region[] | undefined) {
  if (!regions) return 0;
  let click = citationClicks.get(regions);
  if (click === undefined) {
    click = ++lastCitationClick;
    citationClicks.set(regions, click);
  }
  return click;
}

type ObserveVisibility = (
  element: HTMLElement,
  listener: (visible: boolean) => void
) => () => void;

function nearestScrollContainer(element: HTMLElement): Element | null {
  let parent = element.parentElement;
  while (parent) {
    const overflowY = window.getComputedStyle(parent).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return parent;
    parent = parent.parentElement;
  }
  return null;
}

// Every wrapper stays in the scroll layout, but PDF.js canvases/text layers
// mount only near the viewport. The cited page is always mounted immediately.
function LazyPdfPage({
  forceRender,
  onRetry,
  pageNumber,
  pageWidth,
  onMeasured,
  onPainted,
  observeVisibility,
  placeholderAspectRatio,
  regions,
  flashing,
}: {
  flashing: boolean;
  forceRender: boolean;
  onRetry: () => void;
  pageNumber: number;
  pageWidth: number;
  onMeasured?: () => void;
  onPainted?: () => void;
  observeVisibility: ObserveVisibility;
  placeholderAspectRatio: number;
  regions: ReturnType<typeof normalizeCitationRegions>;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(forceRender);
  // The canvas is drawn; an offscreen page drops it.
  const [painted, setPainted] = useState(false);
  const [measuredAspectRatio, setMeasuredAspectRatio] = useState<number | null>(
    null
  );

  useEffect(() => {
    if (forceRender) {
      setVisible(true);
      return;
    }
    const wrapper = wrapperRef.current;
    if (!wrapper || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    return observeVisibility(wrapper, (next) => {
      setVisible(next);
      if (!next) setPainted(false);
    });
  }, [forceRender, observeVisibility]);

  return (
    <div
      className="relative w-full"
      data-page={pageNumber}
      data-painted={painted || undefined}
      ref={wrapperRef}
      style={{ aspectRatio: measuredAspectRatio ?? placeholderAspectRatio }}
    >
      {visible ? (
        <Page
          error={<FileError onRetry={onRetry} />}
          loading={<Skeleton className="absolute inset-0 h-full w-full" />}
          onLoadSuccess={(pdfPage) => {
            const viewport = pdfPage.getViewport({ scale: 1 });
            if (wrapperRef.current)
              wrapperRef.current.dataset.rotation = String(viewport.rotation);
            if (viewport.height > 0) {
              const ratio = viewport.width / viewport.height;
              setMeasuredAspectRatio(ratio);
              onMeasured?.();
            }
          }}
          onRenderSuccess={() => {
            setPainted(true);
            onPainted?.();
          }}
          pageNumber={pageNumber}
          renderAnnotationLayer={false}
          renderTextLayer
          width={pageWidth || undefined}
        />
      ) : (
        <div aria-hidden className="absolute inset-0 bg-white" />
      )}
      <CitationOverlay flashing={flashing} regions={regions} />
    </div>
  );
}

export default function PdfView({
  url,
  page,
  regions,
  annotationFile,
  annotationsReadOnly = false,
  onRetry,
}: {
  annotationFile?: { id: string; revision: number };
  /** A frozen account (the reader's or the owner's), or an owner at its
   * storage limit, keeps the marks visible but draws no new ones. */
  annotationsReadOnly?: boolean;
  onRetry?: () => void;
  url: string;
  /** 1-based page to scroll to once rendered, from a chat citation. */
  page?: number;
  regions?: Region[];
}) {
  // Page count and zoom sit in the file header, as an image's zoom does.
  const header = useContext(FileHeaderTarget);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const [strip, setStrip] = useState<HTMLDivElement | null>(null);
  useHorizontalWheelScroll(toolbar);
  const canAnnotate =
    ANNOTATION_TOOLS && !!annotationFile && !annotationsReadOnly;
  const [mode, setMode] = useFileMode(canAnnotate, 'view');
  const editing = mode === 'edit';
  const [annotationBusy, setAnnotationBusy] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [retryVersion, setRetryVersion] = useState(0);
  const retry = () => {
    setNumPages(0);
    setFirstPageFailed(false);
    setRetryVersion((value) => value + 1);
    onRetry?.();
  };
  const [pane, setPane] = useState<Size | null>(null);
  // The first page's size in PDF points, read before any page mounts so none
  // paints at a width it then leaves.
  const [firstPage, setFirstPage] = useState<Size | null>(null);
  const [firstPageFailed, setFirstPageFailed] = useState(false);
  const loadingPdf = useRef<unknown>(null);
  const pageWidth = pane && firstPage ? autoPageWidth(firstPage, pane) : 0;
  const pageAspectRatio = firstPage ? firstPage.width / firstPage.height : 1;
  const [pageMeasureVersion, setPageMeasureVersion] = useState(0);
  // Bumped when the cited page paints, to run the final citation scroll.
  const [paintVersion, setPaintVersion] = useState(0);
  // The citation whose box is flashing; it shows only during the flash.
  const [flashKey, setFlashKey] = useState<string | null>(null);
  // The latest citation scroll, whether its box flashes when it lands, and
  // whether it has. One the reader stopped (wheel, key, pointer) never lands.
  const citationScrollRef = useRef<{
    flash: boolean;
    key: string;
    landed: boolean;
    stop: () => void;
  }>(undefined);
  useEffect(() => () => citationScrollRef.current?.stop(), []);
  const visibilityObserverRef = useRef<IntersectionObserver | null>(null);
  const visibilityListenersRef = useRef(
    new Map<Element, (visible: boolean) => void>()
  );
  const lastCitationScrollRef = useRef<string | null>(null);
  const citationRegions = useMemo(
    () => normalizeCitationRegions(regions),
    [regions]
  );
  const targetPage =
    citationRegions.find((region) => region.page > 0)?.page ?? page;
  const citationKey = useMemo(() => {
    if (!targetPage) return null;
    const boxes = citationRegions
      .map(
        (region) =>
          `${region.page}:${region.left}:${region.top}:${region.right}:${region.bottom}`
      )
      .join('|');
    return `${url}:${targetPage}:${citationClick(regions)}:${boxes}`;
  }, [citationRegions, regions, targetPage, url]);

  const observeVisibility = useCallback<ObserveVisibility>(
    (element, listener) => {
      visibilityListenersRef.current.set(element, listener);
      visibilityObserverRef.current?.observe(element);
      return () => {
        visibilityObserverRef.current?.unobserve(element);
        visibilityListenersRef.current.delete(element);
      };
    },
    []
  );

  useEffect(() => {
    setNumPages(0);
    setFirstPage(null);
    setFirstPageFailed(false);
  }, [url]);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const container = containerRef.current;
    if (!container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          visibilityListenersRef.current.get(entry.target)?.(
            entry.isIntersecting
          );
        }
      },
      {
        root: nearestScrollContainer(container),
        rootMargin: `${PAGE_OVERSCAN_PX}px 0px`,
      }
    );
    visibilityObserverRef.current = observer;
    for (const element of visibilityListenersRef.current.keys()) {
      observer.observe(element);
    }
    return () => {
      visibilityObserverRef.current = null;
      observer.disconnect();
    };
  }, []);

  // Scroll the cited box to the middle once its wrapper exists, and again
  // when its page has painted with measured geometry; the box flashes when
  // that scroll lands. A paint before the first scroll lands only adds the
  // flash to it, since its frames already aim at the box's current place, and
  // adds nothing to one the reader stopped. Resizing the pane does not pull a
  // reader back after they scroll away.
  useEffect(() => {
    if (!citationKey || !numPages || !pageWidth) return;
    const painted = !!containerRef.current?.querySelector(
      `[data-page="${targetPage}"][data-painted]`
    );
    const phase = painted ? 'painted' : 'placeholder';
    const scrollKey = `${citationKey}:${phase}`;
    if (lastCitationScrollRef.current === scrollKey) return;
    const firstRegion = citationRegions.find(
      (region) => region.page <= numPages
    );
    const target = firstRegion
      ? containerRef.current?.querySelector(
          `[data-citation-region-index="${firstRegion.sourceIndex}"]`
        )
      : page
        ? containerRef.current?.querySelector(`[data-page="${page}"]`)
        : null;
    const scroller = scrollRef.current;
    if (!target || !scroller) return;
    lastCitationScrollRef.current = scrollKey;
    const flash = painted && !!firstRegion;
    const last = citationScrollRef.current;
    if (last?.key === citationKey && !last.landed) {
      last.flash ||= flash;
      return;
    }
    last?.stop();
    let timer = 0;
    const run = { flash, key: citationKey, landed: false, stop: () => {} };
    const stopScroll = scrollToCenter(scroller, target, () => {
      run.landed = true;
      if (!run.flash) return;
      setFlashKey(citationKey);
      timer = window.setTimeout(() => setFlashKey(null), CITATION_FLASH_MS);
    });
    run.stop = () => {
      stopScroll();
      window.clearTimeout(timer);
    };
    citationScrollRef.current = run;
  }, [
    citationKey,
    citationRegions,
    numPages,
    page,
    paintVersion,
    pageWidth,
    targetPage,
  ]);

  useEffect(() => {
    const scroller = scrollRef.current;
    const content = containerRef.current;
    return scroller && content ? keepPdfPlace(scroller, content) : undefined;
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver(([entry]) => {
      setPane({
        height: entry.contentRect.height,
        width: entry.contentRect.width,
      });
    });

    if (scrollRef.current) resizeObserver.observe(scrollRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    if (!containerRef.current || !scrollRef.current || !numPages) return;
    const visible = new Map<Element, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting)
            visible.set(entry.target, entry.intersectionRect.height);
          else visible.delete(entry.target);
        }
        const page = [...visible].sort((a, b) => b[1] - a[1])[0]?.[0];
        if (page instanceof HTMLElement)
          setCurrentPage(Number(page.dataset.page));
      },
      { root: scrollRef.current, threshold: [0, 0.25, 0.5, 0.75, 1] }
    );
    containerRef.current.querySelectorAll('[data-page]').forEach((page) => {
      observer.observe(page);
    });
    return () => observer.disconnect();
  }, [numPages]);
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <FileModeControl
        canEdit={canAnnotate}
        disabled={annotationBusy}
        mode={mode}
        onChange={setMode}
      />
      {header &&
        createPortal(
          <>
            <span className="t-body whitespace-nowrap px-1 text-fg-muted lg:pr-[7px]">
              {numPages ? (
                m.pdf_page_count({ count: numPages, page: currentPage })
              ) : (
                <Skeleton className="inline-block h-3.5 w-20 rounded-full align-middle" />
              )}
            </span>
            <ToolbarButton
              className="hidden lg:flex"
              disabled={zoom <= 0.5}
              label={m.material_zoom_out()}
              onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
            >
              <Icon name="zoomOut" />
            </ToolbarButton>
            <ToolbarButton
              className="hidden lg:flex"
              disabled={zoom >= 3}
              label={m.material_zoom_in()}
              onClick={() => setZoom((value) => Math.min(3, value + 0.25))}
            >
              <Icon name="zoomIn" />
            </ToolbarButton>
          </>,
          header
        )}
      {canAnnotate && (
        <Toolbar className="justify-center">
          <div
            aria-label={m.pdf_private_annotations()}
            className="scroll-fade-x flex h-full min-w-0 max-w-full items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            ref={setToolbar}
            role="toolbar"
          />
        </Toolbar>
      )}
      <div ref={setStrip} />
      <div
        className="min-h-0 flex-1 overflow-auto [overflow-anchor:none]"
        ref={scrollRef}
      >
        <div
          className="relative flex min-h-full w-max min-w-full flex-col items-center [&_.react-pdf__Page__textContent_span]:cursor-inherit"
          ref={containerRef}
          tabIndex={annotationFile ? 0 : undefined}
        >
          {firstPageFailed && (
            <div className="absolute inset-0">
              <FileError onRetry={retry} />
            </div>
          )}
          <div className="shrink-0" style={{ width: pageWidth * zoom }}>
            <Document
              className="shrink-0"
              error={
                <div className="absolute inset-0">
                  <FileError onRetry={retry} />
                </div>
              }
              file={url}
              key={`${url}:${retryVersion}`}
              loading={<Skeleton className="h-full w-full" />}
              onLoadSuccess={async (pdf) => {
                loadingPdf.current = pdf;
                try {
                  const first = (await pdf.getPage(1)).getViewport({
                    scale: 1,
                  });
                  if (loadingPdf.current !== pdf) return;
                  setFirstPage({ height: first.height, width: first.width });
                  setNumPages(pdf.numPages);
                } catch {
                  if (loadingPdf.current === pdf) setFirstPageFailed(true);
                }
              }}
            >
              <div className="flex w-full flex-col items-center gap-4">
                {Array.from({ length: numPages }, (_, i) => {
                  const p = i + 1;
                  const pageRegions = citationRegions.filter(
                    (region) => region.page === p
                  );
                  return (
                    <LazyPdfPage
                      flashing={!!flashKey && flashKey === citationKey}
                      forceRender={p === 1 || p === targetPage}
                      key={p}
                      observeVisibility={observeVisibility}
                      onMeasured={() =>
                        setPageMeasureVersion((value) => value + 1)
                      }
                      onPainted={
                        p === targetPage
                          ? () => setPaintVersion((value) => value + 1)
                          : undefined
                      }
                      onRetry={retry}
                      pageNumber={p}
                      pageWidth={pageWidth * zoom}
                      placeholderAspectRatio={pageAspectRatio}
                      regions={pageRegions}
                    />
                  );
                })}
              </div>
            </Document>
          </div>
          {annotationFile && numPages > 0 && (
            <PdfAnnotations
              containerRef={containerRef}
              editing={editing}
              fileId={annotationFile.id}
              key={`${annotationFile.id}:${annotationFile.revision}`}
              onPendingChange={setAnnotationBusy}
              renderVersion={`${numPages}:${zoom}:${pageWidth}:${pageAspectRatio}:${pageMeasureVersion}`}
              revision={annotationFile.revision}
              strip={strip}
              toolbar={toolbar}
            />
          )}
        </div>
      </div>
    </div>
  );
}
