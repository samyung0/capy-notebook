import { useEffect, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { Skeleton } from '@/components/ui/feedback';

// Load the worker from a CDN matching the bundled pdfjs version.
pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.mjs`;

const MAX_PAGE_WIDTH = 800;

export default function PdfView({ url }: { url: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageWidth, setPageWidth] = useState(0);

  useEffect(() => {
    setNumPages(0);
  }, [url]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver(([entry]) => {
      setPageWidth(
        Math.min(MAX_PAGE_WIDTH, Math.floor(entry.contentRect.width))
      );
    });

    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, []);

  return (
    <div
      className="relative flex h-full w-full flex-col items-center"
      ref={containerRef}
    >
      <Document
        className="h-full w-full max-w-[800px]"
        error={
          <p className="py-8 text-tint-error-fg">Couldn't load this PDF.</p>
        }
        file={url}
        loading={<Skeleton className="h-full w-full" />}
        onLoadSuccess={({ numPages: n }) => setNumPages(n)}
      >
        <div className="flex w-full flex-col items-center gap-4">
          {Array.from({ length: numPages }, (_, i) => {
            const p = i + 1;
            return (
              <div className="w-full" data-page={p} key={p}>
                <Page
                  loading={<Skeleton className="aspect-[1/1.414] w-full" />}
                  pageNumber={p}
                  renderAnnotationLayer={false}
                  renderTextLayer
                  width={pageWidth || undefined}
                />
              </div>
            );
          })}
        </div>
      </Document>
    </div>
  );
}
