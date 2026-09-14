import type { DisplayList } from '@betteroffice/docx/layout/render';
import { DocxDisplayListViewer } from '@betteroffice/docx-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  OfficeAnalysis,
  OfficeCitation,
} from '@/features/files/officeProtocol';
import { CITATION_FILL, docxCitation } from './citations';

type WorkerResponse =
  | {
      displayList: DisplayList;
      id: number;
      pageCount: number;
      type: 'ready';
    }
  | { id: number; message: string; type: 'error' };

export function DocxViewer({
  bytes,
  citation,
  onAnalysis,
  onError,
}: {
  bytes: Uint8Array;
  citation: OfficeCitation | null;
  onAnalysis: (analysis: OfficeAnalysis) => void;
  onError: (error: Error) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [displayList, setDisplayList] = useState<DisplayList | null>(null);

  useEffect(() => {
    const worker = new Worker(
      new URL('./DocxViewer.worker.ts', import.meta.url),
      { type: 'module' }
    );
    const id = 1;
    let stopped = false;
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
      setDisplayList(event.data.displayList);
      onAnalysis({ format: 'docx', pageCount: event.data.pageCount });
    };
    worker.onerror = (event) => {
      stopWorker();
      onError(new Error(event.message));
    };
    const transferable = bytes.slice().buffer;
    worker.postMessage({ bytes: transferable, id }, [transferable]);
    return stopWorker;
  }, [bytes, onAnalysis, onError]);

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
  }, [displayList, citation]);

  return displayList ? (
    <div className="docx-runtime-viewer" ref={hostRef}>
      <DocxDisplayListViewer displayList={displayList} />
    </div>
  ) : null;
}
