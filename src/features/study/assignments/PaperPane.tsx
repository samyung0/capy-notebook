import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useEffect, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import {
  useOrderPaperFiles,
  usePaperFileLinks,
  useRemovePaperFile,
  useSourceUploadPolicy,
  useUploadSource,
} from '@/api/hooks';
import type { PaperFile, SourceFile } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { FileIcon } from '@/components/ui/FileIcon';
import { Skeleton } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { userToast } from '@/components/ui/userToast';
import { formatFileSize } from '@/features/files/fileUtils';
import { getFileKind } from '@/features/workspace/sourceUpload';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';
import { fileIconName } from '@/lib/fileIcons';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** A page yet to be measured takes a4's shape. */
const SHEET_RATIO = 210 / 297;

/** One page of a paper, numbered across its files. */
function Sheet({
  children,
  number,
  ratio = SHEET_RATIO,
}: {
  children: React.ReactNode;
  number: number;
  ratio?: number;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-paper-page={number}>
      <div
        className="relative w-full overflow-hidden rounded-[3px] border border-[#dcdfdf] bg-white shadow-[0_1px_3px_rgba(0,0,0,.08)]"
        style={{ aspectRatio: ratio }}
      >
        {children}
      </div>
      <span className="t-meta text-center text-fg-muted">{number}</span>
    </div>
  );
}

/** One file's pages: a PDF's each, an image as one, any other file as one tile
 * (its text is read as one page, as Make a quiz does). */
function FilePages({
  attemptId,
  file,
  first,
  only,
  onCount,
  width,
}: {
  attemptId: string;
  file: PaperFile;
  /** The paper's number for this file's first page. */
  first: number;
  /** Shows only these paper page numbers. */
  only?: readonly number[];
  onCount: (fileId: string, pages: number) => void;
  width: number;
}) {
  const { data: links, isError } = usePaperFileLinks(attemptId, file.id);
  const [count, setCount] = useState(0);
  const [ratios, setRatios] = useState<Record<number, number>>({});
  const pdf = file.kind === 'pdf';
  useEffect(() => {
    if (!pdf) onCount(file.id, 1);
  }, [file.id, pdf, onCount]);
  const shown = (page: number) => !only || only.includes(first + page - 1);
  if (isError)
    return (
      <p className="t-meta col-span-full text-tint-error-fg" role="alert">
        {m.make_quiz_pages_unavailable()}
      </p>
    );
  if (!pdf) {
    if (!shown(1)) return null;
    return (
      <Sheet number={first}>
        {file.kind === 'image' ? (
          links?.url && (
            <img
              alt=""
              className="h-full w-full object-contain"
              decoding="async"
              src={links.url}
            />
          )
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-4">
            <FileIcon
              className="size-11 shrink-0"
              name={fileIconName(file as Pick<SourceFile, 'kind' | 'name'>)}
            />
            <span className="wrap-anywhere text-center font-semibold text-sm">
              {file.name}
            </span>
          </div>
        )}
      </Sheet>
    );
  }
  if (!links?.url)
    return <Skeleton className="w-full" style={{ aspectRatio: SHEET_RATIO }} />;
  return (
    <Document
      className="contents"
      error={
        <p className="t-meta col-span-full text-tint-error-fg" role="alert">
          {m.make_quiz_pages_unavailable()}
        </p>
      }
      file={links.url}
      loading={
        <Skeleton className="w-full" style={{ aspectRatio: SHEET_RATIO }} />
      }
      onLoadSuccess={({ numPages }) => {
        setCount(numPages);
        onCount(file.id, numPages);
      }}
    >
      {Array.from({ length: count }, (_, i) => i + 1)
        .filter(shown)
        .map((page) => (
          <Sheet key={page} number={first + page - 1} ratio={ratios[page]}>
            <Page
              className="[&_canvas]:h-auto! [&_canvas]:w-full!"
              loading={<Skeleton className="h-full w-full rounded-none" />}
              onLoadSuccess={(pdfPage) => {
                const { height, width: w } = pdfPage.getViewport({ scale: 1 });
                if (height > 0)
                  setRatios((prev) => ({ ...prev, [page]: w / height }));
              }}
              pageNumber={page}
              renderAnnotationLayer={false}
              renderTextLayer={false}
              width={width}
            />
          </Sheet>
        ))}
    </Document>
  );
}

/** A paper's pages, numbered across its files as the read call numbers them;
 * `only` keeps the pages a part was found on (Approve, mock T1), and `wrap`
 * puts each file's pages in what the caller adds around them. */
export function PaperPages({
  attemptId,
  className,
  files,
  only,
  width = 220,
  wrap = (_file, pages) => pages,
}: {
  attemptId: string;
  className?: string;
  files: readonly PaperFile[];
  only?: readonly number[];
  width?: number;
  wrap?: (file: PaperFile, pages: React.ReactNode) => React.ReactNode;
}) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const onCount = useRef((fileId: string, pages: number) =>
    setCounts((prev) =>
      prev[fileId] === pages ? prev : { ...prev, [fileId]: pages }
    )
  ).current;
  let first = 1;
  return files.map((file) => {
    const start = first;
    first += counts[file.id] ?? 1;
    return (
      <div className="contents" key={file.id}>
        {wrap(
          file,
          <div className={cn('grid gap-3', className)}>
            <FilePages
              attemptId={attemptId}
              file={file}
              first={start}
              onCount={onCount}
              only={only}
              width={width}
            />
          </div>
        )}
      </div>
    );
  });
}

/** S5's Your paper (Epo 2026-11-08): the whole paper as a PDF or photos, in
 * order, nothing labelled; files can be removed or dragged into order. Each
 * file goes through the normal upload with the attempt named. */
export function PaperPane({
  attemptId,
  files,
}: {
  attemptId: string;
  files: readonly PaperFile[];
}) {
  const { data: policy } = useSourceUploadPolicy(undefined, {
    errorBoundary: false,
  });
  const { mutateAsync: upload } = useUploadSource(null);
  const { mutate: remove, isPending: removing } = useRemovePaperFile(attemptId);
  const { mutate: order } = useOrderPaperFiles(attemptId);
  const [uploading, setUploading] = useState<string[]>([]);
  const [dragged, setDragged] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);

  const add = async (list: FileList | null) => {
    if (!list?.length || !policy) return;
    const picked = [...list];
    const batchId = crypto.randomUUID();
    setUploading((prev) => [...prev, ...picked.map((f) => f.name)]);
    for (const file of picked) {
      try {
        await upload({
          attemptId,
          batchId,
          batchTotal: picked.length,
          file,
          kind: getFileKind(file.name, policy),
        });
      } catch (error) {
        userToast({
          title: errorCopy(error, m.assignment_paper_upload_failed()),
          variant: 'error',
        });
      } finally {
        setUploading((prev) => prev.filter((name) => name !== file.name));
      }
    }
  };
  const drop = (onto: string) => {
    if (!dragged || dragged === onto) return;
    const ids = files.map((f) => f.id).filter((id) => id !== dragged);
    ids.splice(ids.indexOf(onto), 0, dragged);
    order(ids);
    setDragged(null);
  };

  return (
    <div className="mx-auto flex w-full max-w-180 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-extrabold text-[1.25rem] leading-snug tracking-[-0.01rem] lg:text-[1.375rem]">
          {m.assignment_paper_title()}
        </h2>
        <Button
          className="md:hidden"
          iconLeft="camera"
          onClick={() => camera.current?.click()}
          size="sm"
          variant="outline"
        >
          {m.assignment_paper_photo()}
        </Button>
        <Button
          disabled={!policy}
          iconLeft="plus"
          onClick={() => picker.current?.click()}
          size="sm"
          variant="outline"
        >
          {m.assignment_paper_add()}
        </Button>
        <input
          className="hidden"
          multiple
          onChange={(e) => {
            void add(e.target.files);
            e.target.value = '';
          }}
          ref={picker}
          type="file"
        />
        <input
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            void add(e.target.files);
            e.target.value = '';
          }}
          ref={camera}
          type="file"
        />
      </div>
      <p className="t-meta text-fg-secondary">{m.assignment_paper_hint()}</p>
      {files.length === 0 && uploading.length === 0 && (
        <p className="text-fg-muted">{m.assignment_paper_empty()}</p>
      )}
      <PaperPages
        attemptId={attemptId}
        className="grid-cols-3 sm:grid-cols-5"
        files={files}
        width={160}
        wrap={(file, pages) => (
          <section
            className={cn(
              'flex flex-col gap-2 rounded-lg',
              dragged === file.id && 'opacity-50'
            )}
            draggable={files.length > 1}
            onDragOver={(e) => e.preventDefault()}
            onDragStart={() => setDragged(file.id)}
            onDrop={() => drop(file.id)}
          >
            <div className="flex items-center gap-2">
              {files.length > 1 && (
                <Icon
                  className="cursor-grab text-fg-muted"
                  name="gripVertical"
                  size={18}
                />
              )}
              <span className="t-meta min-w-0 flex-1 truncate text-fg-secondary">
                {m.assignment_paper_file_meta({
                  name: file.name,
                  size: formatFileSize(file.sizeBytes),
                })}
              </span>
              <Button
                disabled={removing}
                iconLeft="trash"
                onClick={() => remove(file.id)}
                size="sm"
                variant="danger-light"
              >
                {m.assignment_paper_remove()}
              </Button>
            </div>
            {pages}
          </section>
        )}
      />
      {uploading.map((name) => (
        <p className="t-meta text-fg-secondary" key={name}>
          {m.assignment_paper_uploading({ name })}
        </p>
      ))}
    </div>
  );
}
