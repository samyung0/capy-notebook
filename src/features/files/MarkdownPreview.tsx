import { useEffect, useRef, useState } from 'react';
import { Skeleton } from '@/components/ui/feedback';
import {
  createMaterialDocument,
  type MaterialDocument,
} from '@/features/materials/document';
import { MaterialPreview } from '@/features/materials/MaterialPreview';
import type {
  MarkdownPreviewRequest,
  MarkdownPreviewResponse,
} from './MarkdownPreview.worker';

const asWritten = (text: string) =>
  createMaterialDocument([{ children: [{ text }], type: 'p' }]);

/* One worker for every preview, started on the first conversion and kept:
   its bundle (the converter on Plate and the markdown parser) loads once. */
let worker: Worker | undefined;
let lastId = 0;
const waiting = new Map<number, (document: MaterialDocument | null) => void>();

function startWorker() {
  const started = new Worker(
    new URL('./MarkdownPreview.worker.ts', import.meta.url),
    { type: 'module' }
  );
  started.addEventListener(
    'message',
    ({ data }: MessageEvent<MarkdownPreviewResponse>) => {
      waiting.get(data.id)?.(data.type === 'result' ? data.document : null);
      waiting.delete(data.id);
    }
  );
  // The worker failed to load: its texts show as written, and the next
  // conversion starts a new one.
  started.addEventListener('error', () => {
    started.terminate();
    if (worker === started) worker = undefined;
    for (const settle of waiting.values()) settle(null);
    waiting.clear();
  });
  return started;
}

/** The text's document, or null when it does not convert. */
function convert(text: string): Promise<MaterialDocument | null> {
  worker ??= startWorker();
  const id = ++lastId;
  const request: MarkdownPreviewRequest = { id, text };
  worker.postMessage(request);
  return new Promise((resolve) => waiting.set(id, resolve));
}

/** An uploaded markdown file, converted in a worker with the editor's markdown
 * import and shown with the note renderer. Text that fails to convert shows as
 * written. While a newer text converts the last document stays on screen, and
 * texts that arrive during a conversion collapse into the latest one. */
export default function MarkdownPreview({ text }: { text: string }) {
  const [document, setDocument] = useState<MaterialDocument | null>(null);
  const push = useRef<(text: string) => void>(null);

  useEffect(() => {
    let closed = false;
    let busy = false;
    let next: string | undefined;
    const run = (text: string) => {
      busy = true;
      void convert(text).then((converted) => {
        busy = false;
        if (closed) return;
        setDocument(converted ?? asWritten(text));
        if (next === undefined) return;
        const latest = next;
        next = undefined;
        run(latest);
      });
    };
    push.current = (text) => {
      if (busy) next = text;
      else run(text);
    };
    return () => {
      closed = true;
      push.current = null;
    };
  }, []);

  useEffect(() => {
    push.current?.(text);
  }, [text]);

  if (!document) return <Skeleton className="h-[60vh] w-full" />;
  return <MaterialPreview className="mx-auto max-w-175" content={document} />;
}
