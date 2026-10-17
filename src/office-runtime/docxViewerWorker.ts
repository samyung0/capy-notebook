/** The DOCX viewer's worker, made when the frame boots for a DOCX view so its
 * module and engine load while Capy still reads the file. */
interface ViewerWorker {
  /** A failure before any viewer listened (its script did not load). */
  error?: string;
  worker: Worker;
}

let warm: ViewerWorker | null = null;

function spawn(): ViewerWorker {
  const entry: ViewerWorker = {
    worker: new Worker(new URL('./DocxViewer.worker.ts', import.meta.url), {
      type: 'module',
    }),
  };
  entry.worker.onerror = (event) => {
    entry.error = event.message || 'The DOCX viewer worker failed';
  };
  return entry;
}

export function prewarmDocxViewerWorker() {
  warm ??= spawn();
}

/** The warm worker, or a new one; `onError` hears a failure it already had. */
export function takeDocxViewerWorker(onError: (message: string) => void) {
  const taken = warm ?? spawn();
  warm = null;
  const { error, worker } = taken;
  worker.onerror = (event) => onError(event.message);
  if (error !== undefined) queueMicrotask(() => onError(error));
  return worker;
}

/** The frame opened something else: the warm worker goes. */
export function dropDocxViewerWorker() {
  warm?.worker.terminate();
  warm = null;
}
