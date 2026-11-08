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

/** Removing and reordering a running paper's files, page by page. */
type PaperEdit = {
  dragged: string | null;
  onDragStart: (fileId: string) => void;
  onDrop: (fileId: string) => void;
  onRemove: (file: PaperFile) => void;
  removing: boolean;
};

/** One page of a paper, numbered across its files; while it runs, a file's
 * first page carries its remove button and every page drags the file. */
function Sheet({
  children,
  edit,
  file,
  firstOfFile,
  number,
  ratio = SHEET_RATIO,
}: {
  children: React.ReactNode;
  edit?: PaperEdit;
  file: PaperFile;
  firstOfFile: boolean;
  number: number;
  ratio?: number;
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-1.5',
        edit && 'cursor-grab',
        edit?.dragged === file.id && 'opacity-50'
      )}
      data-paper-page={number}
      draggable={!!edit}
      onDragOver={edit && ((e) => e.preventDefault())}
      onDragStart={edit && (() => edit.onDragStart(file.id))}
      onDrop={edit && (() => edit.onDrop(file.id))}
    >
      <div
        className="relative w-full overflow-hidden rounded-[3px] border border-[#dcdfdf] bg-white shadow-[0_1px_3px_rgba(0,0,0,.08)]"
        style={{ aspectRatio: ratio }}
      >
        {children}
        {edit && firstOfFile && (
          <button
            aria-label={m.assignment_paper_remove_file({ name: file.name })}
            className="absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full bg-black/55 text-white outline-none focus-visible:ring-2 focus-visible:ring-action"
            disabled={edit.removing}
            onClick={() => edit.onRemove(file)}
            type="button"
          >
            <Icon name="x" size={14} />
          </button>
        )}
      </div>
      <span className="t-meta text-center text-fg-muted">{number}</span>
    </div>
  );
}

/** One file's pages: a PDF's each, an image as one, any other file as one tile
 * (its text is read as one page, as Make a quiz does). */
function FilePages({
  attemptId,
  edit,
  file,
  first,
  only,
  onCount,
  width,
}: {
  attemptId: string;
  edit?: PaperEdit;
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
      <Sheet edit={edit} file={file} firstOfFile number={first}>
        {file.kind === 'image' ? (
          links?.url && (
            <img
              alt=""
              className="h-full w-full object-contain"
              decoding="async"
              draggable={false}
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
          <Sheet
            edit={edit}
            file={file}
            firstOfFile={page === 1}
            key={page}
            number={first + page - 1}
            ratio={ratios[page]}
          >
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

/** A paper's pages in one grid, numbered across its files as the read call
 * numbers them; `only` keeps the pages a part was found on (Approve, mock T1). */
export function PaperPages({
  attemptId,
  className,
  edit,
  files,
  only,
  width = 220,
}: {
  attemptId: string;
  className?: string;
  edit?: PaperEdit;
  files: readonly PaperFile[];
  only?: readonly number[];
  width?: number;
}) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const onCount = useRef((fileId: string, pages: number) =>
    setCounts((prev) =>
      prev[fileId] === pages ? prev : { ...prev, [fileId]: pages }
    )
  ).current;
  let first = 1;
  return (
    <div className={cn('grid gap-3', className)}>
      {files.map((file) => {
        const start = first;
        first += counts[file.id] ?? 1;
        return (
          <FilePages
            attemptId={attemptId}
            edit={edit}
            file={file}
            first={start}
            key={file.id}
            onCount={onCount}
            only={only}
            width={width}
          />
        );
      })}
    </div>
  );
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
        <h2 className="mr-auto font-extrabold text-[1.25rem] leading-snug tracking-[-0.01rem] max-md:basis-full lg:text-[1.375rem]">
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
      {files.length > 0 && (
        <p className="t-meta text-fg-secondary">
          {files.length === 1
            ? m.assignment_paper_file_meta({
                name: files[0]!.name,
                size: formatFileSize(files[0]!.sizeBytes),
              })
            : m.assignment_paper_file_meta({
                name: m.assignment_paper_files({ count: files.length }),
                size: formatFileSize(
                  files.reduce((n, f) => n + f.sizeBytes, 0)
                ),
              })}
        </p>
      )}
      <PaperPages
        attemptId={attemptId}
        className="grid-cols-3 sm:grid-cols-5"
        edit={{
          dragged,
          onDragStart: setDragged,
          onDrop: drop,
          onRemove: (file) => remove(file.id),
          removing,
        }}
        files={files}
        width={160}
      />
      {uploading.map((name) => (
        <p className="t-meta text-fg-secondary" key={name}>
          {m.assignment_paper_uploading({ name })}
        </p>
      ))}
    </div>
  );
}
