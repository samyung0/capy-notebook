import type { DisplayList } from '@betteroffice/docx/layout/render';
import { DocxDisplayListViewer } from '@betteroffice/docx-react';
import { useEffect, useState } from 'react';
import type { OfficeAnalysis } from '@/features/files/officeProtocol';

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
  onAnalysis,
  onError,
}: {
  bytes: Uint8Array;
  onAnalysis: (analysis: OfficeAnalysis) => void;
  onError: (error: Error) => void;
}) {
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

  return displayList ? (
    <div className="docx-runtime-viewer">
      <DocxDisplayListViewer displayList={displayList} />
    </div>
  ) : null;
}
