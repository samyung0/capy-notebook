import {
  analyzeOpenWorkbook,
  initWasm,
  openWorkbook,
  paintDisplayList,
  type WorkbookAnalysis,
  type WorkbookViewerHandle,
} from '@betteroffice/xlsx/viewer';
import { useCallback, useEffect, useRef, useState } from 'react';

export function XlsxViewer({
  bytes,
  onAnalysis,
  onError,
}: {
  bytes: Uint8Array;
  onAnalysis: (analysis: WorkbookAnalysis) => void;
  onError: (error: Error) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<WorkbookViewerHandle | null>(null);
  const rafRef = useRef<number | null>(null);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [extent, setExtent] = useState({ height: 0, width: 0 });

  const paint = useCallback(() => {
    const scroll = scrollRef.current;
    const canvas = canvasRef.current;
    const handle = handleRef.current;
    if (!scroll || !canvas || !handle) return;
    const width = scroll.clientWidth;
    const height = scroll.clientHeight;
    if (width === 0 || height === 0) return;
    try {
      const frame = handle.displayList({
        height,
        width,
        x: scroll.scrollLeft,
        y: scroll.scrollTop,
      });
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const context = canvas.getContext('2d');
      if (context) paintDisplayList(context, frame, dpr);
    } catch (value) {
      onError(toError(value));
    }
  }, [onError]);

  useEffect(() => {
    let disposed = false;
    let handle: WorkbookViewerHandle | null = null;
    void initWasm().then(
      () => {
        if (disposed) return;
        try {
          handle = openWorkbook(bytes);
          handleRef.current = handle;
          const analysis = analyzeOpenWorkbook(handle);
          const info = handle.sheetInfo();
          setSheetNames(info.sheetNames);
          setActiveSheet(info.activeSheet);
          setExtent({ height: info.contentHeight, width: info.contentWidth });
          onAnalysis(analysis);
          requestAnimationFrame(paint);
        } catch (value) {
          onError(toError(value));
        }
      },
      (value: unknown) => onError(toError(value))
    );
    return () => {
      disposed = true;
      handleRef.current = null;
      handle?.dispose();
    };
  }, [bytes, onAnalysis, onError, paint]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const schedule = () => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        paint();
      });
    };
    scroll.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(scroll);
    return () => {
      scroll.removeEventListener('scroll', schedule);
      observer.disconnect();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [paint]);

  const selectSheet = (index: number) => {
    const handle = handleRef.current;
    if (!handle) return;
    try {
      handle.setActiveSheet(index);
      const info = handle.sheetInfo();
      setActiveSheet(index);
      setExtent({ height: info.contentHeight, width: info.contentWidth });
      const scroll = scrollRef.current;
      if (scroll) {
        scroll.scrollLeft = info.initialScrollX;
        scroll.scrollTop = info.initialScrollY;
      }
      paint();
    } catch (value) {
      onError(toError(value));
    }
  };

  return (
    <div className="office-runtime">
      {sheetNames.length > 1 && (
        <div className="office-tabs" role="tablist">
          {sheetNames.map((name, index) => (
            <button
              aria-selected={index === activeSheet}
              className="office-tab"
              key={`${name}-${index}`}
              onClick={() => selectSheet(index)}
              role="tab"
              type="button"
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <div className="xlsx-viewport" ref={scrollRef}>
        <div
          aria-hidden="true"
          style={{
            height: extent.height,
            left: 0,
            position: 'absolute',
            top: 0,
            width: extent.width,
          }}
        />
        <div className="xlsx-canvas-layer">
          <canvas ref={canvasRef} />
        </div>
      </div>
    </div>
  );
}

function toError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value));
}
