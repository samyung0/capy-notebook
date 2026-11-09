import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useEffect, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import {
  type SubmissionOf,
  useOrderPaperFiles,
  usePaperFileLinks,
  useRemovePaperFile,
} from '@/api/hooks';
import type { PaperFile, SourceFile } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { FileIcon } from '@/components/ui/FileIcon';
import { Skeleton } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { userToast } from '@/components/ui/userToast';
import { fileExt, formatFileSize } from '@/features/files/fileUtils';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName } from '@/lib/fileIcons';
import type { SubmissionFiles } from './useAddSubmissionFiles';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** A page yet to be measured takes a4's shape. */
const SHEET_RATIO = 210 / 297;

/** The read's page cap (`PAPER_MAX_PAGES` in pipeline/retrieval/paper.py,
 * Epo's 15, held): checked as files are picked so the member hears it then,
 * not as every part's Grade Error once marked (finding 7). */
const PAPER_MAX_PAGES = 15;

/** A picked file's pages as the read numbers them: a PDF's each, anything
 * else one. A PDF the browser cannot open counts one; the read reports it. */
async function pickedPages(file: File) {
  if (fileExt(file.name) !== 'pdf') return 1;
  try {
    const pdf = await pdfjs.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
    }).promise;
    const pages = pdf.numPages;
    void pdf.destroy();
    return pages;
  } catch {
    return 1;
  }
}

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
  edit,
  file,
  first,
  only,
  onCount,
  width,
  of,
}: {
  edit?: PaperEdit;
  file: PaperFile;
  /** The paper's number for this file's first page. */
  first: number;
  /** Shows only these paper page numbers. */
  only?: readonly number[];
  onCount: (fileId: string, pages: number) => void;
  of: SubmissionOf;
  width: number;
}) {
  const { data: links, isError } = usePaperFileLinks(of, file.id);
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
  className,
  edit,
  files,
  of,
  onCounts,
  only,
  width = 220,
}: {
  className?: string;
  edit?: PaperEdit;
  files: readonly PaperFile[];
  of: SubmissionOf;
  /** Each file's pages once known, for the page cap. */
  onCounts?: (counts: Record<string, number>) => void;
  only?: readonly number[];
  width?: number;
}) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const onCount = useRef((fileId: string, pages: number) =>
    setCounts((prev) =>
      prev[fileId] === pages ? prev : { ...prev, [fileId]: pages }
    )
  ).current;
  useEffect(() => onCounts?.(counts), [counts, onCounts]);
  let first = 1;
  return (
    <div className={cn('grid gap-3', className)}>
      {files.map((file) => {
        const start = first;
        first += counts[file.id] ?? 1;
        return (
          <FilePages
            edit={edit}
            file={file}
            first={start}
            key={file.id}
            of={of}
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
 * file goes through the normal upload with the attempt named, by `uploads`,
 * which the page holds so Submit waits for them (finding 6). */
export function PaperPane({
  attemptId,
  files,
  uploads,
}: {
  attemptId: string;
  files: readonly PaperFile[];
  uploads: SubmissionFiles;
}) {
  const { ready, uploading } = uploads;
  const { mutate: remove, isPending: removing } = useRemovePaperFile(attemptId);
  const [counts, setCounts] = useState<Record<string, number>>({});
  // A PDF's pages as picked, until its own render counts them.
  const picked = useRef(new Map<string, number>());
  // Pages of picks still uploading.
  const flying = useRef(0);
  const add = async (list: FileList | null) => {
    if (!list?.length) return;
    const chosen = [...list];
    const pages = await Promise.all(chosen.map(pickedPages));
    const held = files.reduce(
      (n, f) =>
        n +
        (counts[f.id] ?? picked.current.get(`${f.name}:${f.sizeBytes}`) ?? 1),
      flying.current
    );
    const adding = pages.reduce((n, p) => n + p, 0);
    if (held + adding > PAPER_MAX_PAGES) {
      userToast({
        title: m.assignment_paper_too_many_pages({
          max: PAPER_MAX_PAGES,
          pages: held + adding,
        }),
        variant: 'error',
      });
      return;
    }
    chosen.forEach((file, i) => {
      if (pages[i]! > 1)
        picked.current.set(`${file.name}:${file.size}`, pages[i]!);
    });
    flying.current += adding;
    try {
      await uploads.add(chosen);
    } finally {
      flying.current -= adding;
    }
  };
  const { mutate: order } = useOrderPaperFiles(attemptId);
  const [dragged, setDragged] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
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
          disabled={!ready}
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
        className="grid-cols-3 sm:grid-cols-5"
        edit={{
          dragged,
          onDragStart: setDragged,
          onDrop: drop,
          onRemove: (file) => remove(file.id),
          removing,
        }}
        files={files}
        of={{ attemptId }}
        onCounts={setCounts}
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
