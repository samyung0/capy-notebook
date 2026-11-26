import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '@/api/client';
import { type SubmissionOf, useStoreMarkedCopy } from '@/api/hooks';
import type { PaperFile } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { officePagesPdf } from '@/features/files/pagesPdf';
import { useOfficeRuntime } from '@/features/files/useOfficeRuntime';
import { m } from '@/i18n';

/** A Word submission's PDF copy, made for staff to mark on (Epo 2026-11-25,
 * mock B6H1Z7o4byVFBVyCRSUK3B C1): the Office runtime draws its pages in an
 * unseen frame with its print path, as Make a quiz does, and the copy is
 * stored once. The links then sign it and the pane shows it; a browser that
 * lost the race to another opens theirs. The frame goes once it has drawn or
 * failed: it shares the app's main thread. */
export default function WordCopy({
  file,
  of,
  url,
}: {
  file: PaperFile;
  of: SubmissionOf;
  /** The .docx's signed link. */
  url: string;
}) {
  const [attempt, setAttempt] = useState(0);
  return (
    <WordCopyDrawing
      file={file}
      key={attempt}
      of={of}
      onRetry={() => setAttempt((n) => n + 1)}
      url={url}
    />
  );
}

function WordCopyDrawing({
  file,
  of,
  onRetry,
  url,
}: {
  file: PaperFile;
  of: SubmissionOf;
  onRetry: () => void;
  url: string;
}) {
  const { mutateAsync: store } = useStoreMarkedCopy(of, file.id);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`Word file ${response.status}`);
      return response.arrayBuffer();
    },
    [url]
  );
  const {
    analysis,
    error,
    iframeAllow,
    iframeKey,
    iframeRef,
    iframeSandbox,
    iframeUrl,
    ready,
    render,
  } = useOfficeRuntime({
    canEdit: false,
    file,
    format: 'docx',
    load,
    revision: file.revision,
  });
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState(false);
  const asked = useRef(false);
  useEffect(() => {
    if (!ready || !analysis || asked.current) return;
    asked.current = true;
    render('print')
      .then(({ pages, truncated }) => {
        // Stored once for good: a copy missing pages is never stored.
        if (truncated || pages.length === 0)
          throw new Error('The Word file drew no whole copy');
        return officePagesPdf(pages);
      })
      .then((pdf) => store(pdf))
      .catch((value: unknown) => {
        // Another staff browser stored it first: the links now sign theirs.
        if (value instanceof ApiError && value.code === 'marked_copy_taken')
          return;
        throw value;
      })
      .then(() => setDone(true))
      .catch(() => setFailed(true));
  }, [analysis, ready, render, store]);
  const stopped = failed || !!error;
  return (
    <>
      {/* On the body and in the viewport, unseen: Chromium stops animation
          frames in a cross-origin frame off screen (PagePicker). */}
      {!stopped &&
        !done &&
        createPortal(
          <iframe
            allow={iframeAllow}
            aria-hidden
            className="pointer-events-none fixed top-0 left-0 -z-10 h-[768px] w-[1024px] border-0 opacity-0"
            inert
            key={iframeKey}
            ref={iframeRef}
            sandbox={iframeSandbox}
            src={iframeUrl}
            tabIndex={-1}
            title={m.files_office_document_frame_title({ name: file.name })}
          />,
          document.body
        )}
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        {stopped ? (
          <div className="flex flex-col items-center gap-3" role="alert">
            <p className="t-meta text-tint-error-fg">
              {m.assignment_copy_failed()}
            </p>
            <Button onClick={onRetry} size="sm" type="button" variant="outline">
              {m.error_action_retry()}
            </Button>
          </div>
        ) : (
          <p className="t-meta text-fg-muted" role="status">
            {m.assignment_copy_making({ name: file.name })}
          </p>
        )}
      </div>
    </>
  );
}
