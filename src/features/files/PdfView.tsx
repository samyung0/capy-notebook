import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import type { Region } from '@/api/types';
import { Skeleton } from '@/components/ui/feedback';
import { IconButton } from '@/components/ui/IconButton';
import { m } from '@/i18n';
import { CitationOverlay } from './CitationOverlay';
import { normalizeCitationRegions } from './citationRegions';
import { FileModeControl } from './FileModeControl';
import { FileError } from './FileStates';
import { PdfAnnotations } from './PdfAnnotations';

// Keep PDF rendering available under the app's CSP and while offline.
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const MAX_PAGE_WIDTH = 800;
const PAGE_OVERSCAN_PX = 1200;
const DEFAULT_PAGE_ASPECT_RATIO = 1 / Math.SQRT2;

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
  onAspectRatio,
  onMeasured,
  observeVisibility,
  placeholderAspectRatio,
  regions,
}: {
  forceRender: boolean;
  onRetry: () => void;
  pageNumber: number;
  pageWidth: number;
  onAspectRatio?: (ratio: number) => void;
  onMeasured?: () => void;
  observeVisibility: ObserveVisibility;
  placeholderAspectRatio: number;
  regions: ReturnType<typeof normalizeCitationRegions>;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(forceRender);
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
    return observeVisibility(wrapper, setVisible);
  }, [forceRender, observeVisibility]);

  return (
    <div
      className="relative w-full"
      data-page={pageNumber}
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
              onAspectRatio?.(ratio);
              onMeasured?.();
            }
          }}
          pageNumber={pageNumber}
          renderAnnotationLayer={false}
          renderTextLayer
          width={pageWidth || undefined}
        />
      ) : (
        <div aria-hidden className="absolute inset-0 bg-white" />
      )}
      <CitationOverlay regions={regions} />
    </div>
  );
}

export default function PdfView({
  url,
  page,
  regions,
  annotationFile,
  onDirtyChange,
  onRetry,
}: {
  annotationFile?: { id: string; revision: number };
  onDirtyChange?: (dirty: boolean) => void;
  onRetry?: () => void;
  url: string;
  /** 1-based page to scroll to once rendered, from a chat citation. */
  page?: number;
  regions?: Region[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [annotationBusy, setAnnotationBusy] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  useEffect(() => {
    onDirtyChange?.(annotationBusy);
    return () => onDirtyChange?.(false);
  }, [annotationBusy, onDirtyChange]);
  const [numPages, setNumPages] = useState(0);
  const [retryVersion, setRetryVersion] = useState(0);
  const retry = () => {
    setNumPages(0);
    setRetryVersion((value) => value + 1);
    onRetry?.();
  };
  const [pageWidth, setPageWidth] = useState(0);
  const [pageMeasureVersion, setPageMeasureVersion] = useState(0);
  const [pageAspectRatio, setPageAspectRatio] = useState(
    DEFAULT_PAGE_ASPECT_RATIO
  );
  const [measuredCitationKey, setMeasuredCitationKey] = useState<string | null>(
    null
  );
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
    return `${url}:${targetPage}:${boxes}`;
  }, [citationRegions, targetPage, url]);

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
    setPageAspectRatio(DEFAULT_PAGE_ASPECT_RATIO);
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

  // Place the cited box near the middle once its wrapper exists, then once
  // more if PDF.js replaces the placeholder ratio with measured geometry.
  // Resizing the pane does not pull a reader back after they scroll away.
  useEffect(() => {
    if (!citationKey || !numPages || !pageWidth) return;
    const phase =
      measuredCitationKey === citationKey ? 'measured' : 'placeholder';
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
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    lastCitationScrollRef.current = scrollKey;
  }, [
    citationKey,
    citationRegions,
    measuredCitationKey,
    numPages,
    page,
    pageWidth,
  ]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver(([entry]) => {
      setPageWidth(
        Math.min(MAX_PAGE_WIDTH, Math.floor(entry.contentRect.width))
      );
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
        canEdit={!!annotationFile}
        disabled={annotationBusy}
        mode={editing ? 'edit' : 'view'}
        onChange={(mode) => setEditing(mode === 'edit')}
      />
      <div className="grid shrink-0 grid-cols-[max-content_minmax(0,1fr)] items-center gap-3 border-divider border-b px-3 py-1.5 lg:grid-cols-[minmax(max-content,1fr)_minmax(0,max-content)_minmax(max-content,1fr)]">
        <span className="t-meta whitespace-nowrap text-fg-muted">
          {numPages
            ? m.pdf_page_count({ count: numPages, page: currentPage })
            : m.common_loading()}
        </span>
        <div
          aria-label={m.pdf_private_annotations()}
          className="scroll-fade-x flex min-w-0 max-w-full items-center justify-self-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          ref={setToolbar}
          role="toolbar"
        />
        <div className="hidden items-center justify-self-end lg:flex">
          <IconButton
            disabled={zoom <= 0.5}
            icon="zoomOut"
            label={m.material_zoom_out()}
            onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
            size="sm"
            tooltip
            variant="ghost-hover"
          />
          <IconButton
            disabled={zoom >= 3}
            icon="zoomIn"
            label={m.material_zoom_in()}
            onClick={() => setZoom((value) => Math.min(3, value + 0.25))}
            size="sm"
            tooltip
            variant="ghost-hover"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto" ref={scrollRef}>
        <div
          className="relative flex min-h-full w-max min-w-full flex-col items-center [&_.react-pdf__Page__textContent_span]:cursor-inherit"
          ref={containerRef}
          tabIndex={annotationFile ? 0 : undefined}
        >
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
              onLoadSuccess={(pdf) => setNumPages(pdf.numPages)}
            >
              <div className="flex w-full flex-col items-center gap-4">
                {Array.from({ length: numPages }, (_, i) => {
                  const p = i + 1;
                  const pageRegions = citationRegions.filter(
                    (region) => region.page === p
                  );
                  return (
                    <LazyPdfPage
                      forceRender={p === 1 || p === targetPage}
                      key={p}
                      observeVisibility={observeVisibility}
                      onAspectRatio={p === 1 ? setPageAspectRatio : undefined}
                      onMeasured={() => {
                        setPageMeasureVersion((value) => value + 1);
                        if (p === targetPage && citationKey)
                          setMeasuredCitationKey(citationKey);
                      }}
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
              toolbar={toolbar}
            />
          )}
        </div>
      </div>
    </div>
  );
}
