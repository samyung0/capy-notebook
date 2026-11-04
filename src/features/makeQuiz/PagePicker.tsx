import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import {
  useCreateExtraction,
  useFileLinks,
  useFiles,
  useMaterials,
} from '@/api/hooks';
import { EXTRACTION_PAGES_MAX } from '@/api/limits.generated';
import type { SourceFile } from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { Button } from '@/components/ui/Button';
import { FileIcon } from '@/components/ui/FileIcon';
import { FormAlert } from '@/components/ui/FormAlert';
import { Skeleton, Spinner } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy, unexpectedErrorId } from '@/lib/errors';
import { fileIconName } from '@/lib/fileIcons';
import {
  estimatedCredits,
  extractionRequest,
  type PaperPage,
  pageKey,
  quizTitleFrom,
  togglePage,
} from './makeQuiz';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Board X1's sheet: drawn once, at this CSS width, and scaled to its column. */
const SHEET_WIDTH = 220;
/** A page yet to be measured takes a4's shape. */
const SHEET_RATIO = 220 / 296;

/** One page: a large sheet, one click selects it (Epo 2026-11-02). */
function Sheet({
  children,
  disabled,
  number,
  onToggle,
  ratio,
  selected,
  sheetRef,
}: {
  children: React.ReactNode;
  /** The cap is reached and this page isn't one of them. */
  disabled: boolean;
  number: number;
  onToggle: () => void;
  ratio: number;
  selected: boolean;
  sheetRef?: React.Ref<HTMLSpanElement>;
}) {
  return (
    <button
      aria-disabled={disabled || undefined}
      aria-label={m.make_quiz_page_label({
        page: number,
        state: selected
          ? m.make_quiz_page_selected()
          : m.make_quiz_page_not_selected(),
      })}
      aria-pressed={selected}
      className={cn(
        'flex min-w-0 flex-col items-center gap-2 outline-none',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
      )}
      data-page-sheet={number}
      onClick={() => {
        if (!disabled) onToggle();
      }}
      type="button"
    >
      <span
        className={cn(
          'relative block w-full rounded-[3px] border border-[#dcdfdf] bg-white shadow-[0_1px_3px_rgba(0,0,0,.08)]',
          selected && 'outline-[2.5px] outline-action-accent outline-offset-3',
          // A keyboard's focus shows as the selection's outline does.
          !selected &&
            'in-focus-visible:outline-2 in-focus-visible:outline-action'
        )}
        ref={sheetRef}
        style={{ aspectRatio: ratio }}
      >
        <span className="absolute inset-0 overflow-hidden rounded-[inherit]">
          {children}
        </span>
        {selected && (
          <span className="absolute -top-2.5 -right-2.5 flex size-6.5 items-center justify-center rounded-full bg-action-accent text-white shadow-[0_0_0_3px_var(--color-surface)]">
            <Icon name="check" size={16} />
          </span>
        )}
      </span>
      <span
        className={cn(
          'font-semibold text-[13px] text-fg-muted',
          selected && 'text-tint-accent-1-fg'
        )}
      >
        {number}
      </span>
    </button>
  );
}

/** A PDF page, drawn only near the viewport: a long file stays light. */
function PdfSheet({
  disabled,
  number,
  onToggle,
  page,
  selected,
}: {
  disabled: boolean;
  number: number;
  onToggle: () => void;
  page: number;
  selected: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  const [ratio, setRatio] = useState(SHEET_RATIO);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => setNear(!!entry?.isIntersecting),
      { rootMargin: '800px 0px' }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <Sheet
      disabled={disabled}
      number={number}
      onToggle={onToggle}
      ratio={ratio}
      selected={selected}
      sheetRef={ref}
    >
      {near && (
        <Page
          className="[&_canvas]:h-auto! [&_canvas]:w-full!"
          loading={<Skeleton className="h-full w-full rounded-none" />}
          onLoadSuccess={(pdfPage) => {
            const { height, width } = pdfPage.getViewport({ scale: 1 });
            if (height > 0) setRatio(width / height);
          }}
          pageNumber={page}
          renderAnnotationLayer={false}
          renderTextLayer={false}
          width={SHEET_WIDTH}
        />
      )}
    </Sheet>
  );
}

/** One file's sheets. Numbers run across the paper's files. */
function PaperSheets({
  file,
  firstNumber,
  full,
  onCount,
  onToggle,
  selected,
}: {
  file: SourceFile;
  firstNumber: number;
  full: boolean;
  onCount: (fileId: string, pages: number) => void;
  onToggle: (key: string) => void;
  selected: ReadonlySet<string>;
}) {
  const { data: links, isError } = useFileLinks(file.id, {
    errorBoundary: false,
  });
  const [count, setCount] = useState(0);
  const url = links?.url;
  const image = file.kind === 'image';
  useEffect(() => {
    if (image) onCount(file.id, 1);
  }, [file.id, image, onCount]);
  if (isError)
    return (
      <p className="t-meta col-span-full text-tint-error-fg" role="alert">
        {m.make_quiz_pages_unavailable()}
      </p>
    );
  if (image) {
    const key = pageKey({ fileId: file.id, page: 1 });
    const on = selected.has(key);
    return (
      <Sheet
        disabled={full && !on}
        number={firstNumber}
        onToggle={() => onToggle(key)}
        ratio={SHEET_RATIO}
        selected={on}
      >
        {url && (
          <img
            alt=""
            className="h-full w-full object-contain"
            decoding="async"
            src={url}
          />
        )}
      </Sheet>
    );
  }
  if (!url)
    return <Skeleton className="w-full" style={{ aspectRatio: SHEET_RATIO }} />;
  return (
    <Document
      className="contents"
      error={
        <p className="t-meta col-span-full text-tint-error-fg" role="alert">
          {m.make_quiz_pages_unavailable()}
        </p>
      }
      file={url}
      loading={
        <Skeleton className="w-full" style={{ aspectRatio: SHEET_RATIO }} />
      }
      onLoadSuccess={({ numPages }) => {
        setCount(numPages);
        onCount(file.id, numPages);
      }}
    >
      {Array.from({ length: count }, (_, i) => {
        const page = i + 1;
        const key = pageKey({ fileId: file.id, page });
        const on = selected.has(key);
        return (
          <PdfSheet
            disabled={full && !on}
            key={page}
            number={firstNumber + i}
            onToggle={() => onToggle(key)}
            page={page}
            selected={on}
          />
        );
      })}
    </Document>
  );
}

/**
 * Click the pages with questions (Epo 2026-11-02, board X1): pages shown large,
 * one click selects one, up to 40 in a run, and pages left unclicked are
 * skipped. The rail stays beside it; the Files panel doesn't.
 */
export function PagePicker({
  answers,
  onBack,
  onCancel,
  onStarted,
  paper,
  workspaceId,
}: {
  answers: string[];
  /** Back to the dialog, with what it chose. */
  onBack: () => void;
  onCancel: () => void;
  onStarted: (runId: string) => void;
  paper: string[];
  workspaceId: string;
}) {
  const { data: files } = useFiles(workspaceId, { errorBoundary: false });
  const { data: materials } = useMaterials(workspaceId, {
    errorBoundary: false,
  });
  const { mutate: start, isPending, error } = useCreateExtraction(workspaceId);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [counts, setCounts] = useState<Record<string, number>>({});
  const onCount = useCallback(
    (fileId: string, pages: number) =>
      setCounts((current) =>
        current[fileId] === pages ? current : { ...current, [fileId]: pages }
      ),
    []
  );
  const onToggle = useCallback(
    (key: string) => setSelected((current) => togglePage(current, key)),
    []
  );
  const paperFiles = paper.flatMap((id) => {
    const file = files?.find((row) => row.id === id);
    return file ? [file] : [];
  });
  const answerFiles = answers.flatMap((id) => {
    const file = files?.find((row) => row.id === id);
    return file ? [file] : [];
  });
  const total = paper.reduce((sum, id) => sum + (counts[id] ?? 0), 0);
  const allPages: PaperPage[] = paperFiles.flatMap((file) =>
    Array.from({ length: counts[file.id] ?? 0 }, (_, i) => ({
      fileId: file.id,
      page: i + 1,
    }))
  );
  const full = selected.size >= EXTRACTION_PAGES_MAX;
  // An answer file may still be reading after the dialog (X0b); the run only
  // takes files with indexed text.
  const answersReading = answerFiles.some((file) => !file.indexed);
  const first = paperFiles[0];

  if (files && (paperFiles.length < paper.length || !first))
    return (
      <ErrorState
        action={
          <Button onClick={onBack} type="button" variant="outline">
            {m.action_back()}
          </Button>
        }
        description={m.make_quiz_file_gone()}
        title={m.make_quiz_pages_unavailable()}
        variant="page"
      />
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-3.5 gap-y-2 px-4 pt-4 pb-3 sm:px-10 sm:pt-5.5 sm:pb-3.5">
        <ToolbarButton label={m.action_back()} onClick={onBack}>
          <Icon name="navigationBack" />
        </ToolbarButton>
        <div className="min-w-0 flex-1">
          <h1 className="font-extrabold text-[22px] leading-tight tracking-[-.01rem]">
            {m.make_quiz_pages_title()}
          </h1>
          <p className="t-meta truncate text-fg-muted">
            {[
              paperFiles.map((file) => file.name).join(', '),
              total > 0 &&
                (total === 1
                  ? m.make_quiz_one_page()
                  : m.source_pages({ count: total })),
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        {answerFiles.length > 0 && (
          <span className="inline-flex h-7.5 min-w-0 items-center gap-1.5 rounded-md bg-page-hover px-2.5 font-semibold text-[12.5px] text-fg-secondary">
            {answerFiles.slice(0, 3).map((file) => (
              <FileIcon
                className="size-4 shrink-0"
                key={file.id}
                name={fileIconName(file)}
              />
            ))}
            <span className="truncate">
              {answerFiles.length === 1
                ? m.make_quiz_with_one_file()
                : m.make_quiz_with_files({ count: answerFiles.length })}
            </span>
          </span>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          aria-label={m.make_quiz_pages_title()}
          className="grid grid-cols-2 gap-x-3 gap-y-5 px-4 pt-2.5 pb-6 sm:grid-cols-[repeat(auto-fill,220px)] sm:justify-center sm:gap-x-7.5 sm:gap-y-6.5 sm:px-10"
          role="group"
        >
          {paperFiles.map((file, i) => (
            <PaperSheets
              file={file}
              firstNumber={
                1 +
                paper
                  .slice(0, i)
                  .reduce((sum, id) => sum + (counts[id] ?? 0), 0)
              }
              full={full}
              key={file.id}
              onCount={onCount}
              onToggle={onToggle}
              selected={selected}
            />
          ))}
        </div>
      </div>
      <footer className="border-divider border-t px-4 py-3 sm:px-10 sm:py-4">
        <FormAlert
          errorId={unexpectedErrorId(error)}
          message={error ? errorCopy(error, m.source_try_again()) : null}
        />
        <div className="mt-0 flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-2.5">
            <strong className="font-semibold">
              {m.make_quiz_pages_count({
                count: selected.size,
                max: EXTRACTION_PAGES_MAX,
              })}
            </strong>
            <span className="t-meta text-fg-muted">
              {full
                ? m.make_quiz_at_cap({ max: EXTRACTION_PAGES_MAX })
                : answersReading
                  ? m.make_quiz_waiting_answers()
                  : m.make_quiz_credits({
                      count: estimatedCredits(selected.size),
                    })}
            </span>
          </p>
          <div className="ml-auto flex items-center gap-1">
            <Button onClick={onCancel} type="button" variant="ghost-hover">
              {m.action_cancel()}
            </Button>
            <Button
              disabled={selected.size === 0 || answersReading || isPending}
              onClick={() =>
                first &&
                start(
                  extractionRequest(
                    quizTitleFrom(
                      first.name,
                      (materials ?? []).map((row) => row.title)
                    ),
                    allPages,
                    selected,
                    answers
                  ),
                  { onSuccess: (run) => onStarted(run.id) }
                )
              }
              type="button"
            >
              {isPending ? <Spinner /> : m.make_quiz_extract()}
            </Button>
          </div>
        </div>
      </footer>
    </div>
  );
}
