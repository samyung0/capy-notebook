import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import {
  useCreateExtraction,
  useFileLinks,
  useFiles,
  useMaterials,
} from '@/api/hooks';
import {
  EXTRACTION_PAGES_MAX,
  EXTRACTION_QUESTION_CREDITS,
} from '@/api/limits.generated';
import type { SourceFile } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { useIsPhone } from '@/components/ui/Dialog';
import { FileIcon } from '@/components/ui/FileIcon';
import { FormAlert } from '@/components/ui/FormAlert';
import { Skeleton, Spinner } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';

import { useOfficeRuntime } from '@/features/files/useOfficeRuntime';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy, unexpectedErrorId } from '@/lib/errors';
import { fileIconName } from '@/lib/fileIcons';
import { type DrawnPage, drawnPage } from './drawnPages';
import {
  drawnPaperFormat,
  extractionRefusal,
  extractionRequest,
  isReadingFile,
  isUnreadable,
  isWholeFile,
  pageKey,
  pickedPages,
  quizTitleFrom,
  toggleAllPages,
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

/** A PDF's or an image's sheets. */
function PaperSheets({
  file,
  full,
  onCount,
  onToggle,
  selected,
}: {
  file: SourceFile;
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
        number={1}
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
            number={page}
            onToggle={() => onToggle(key)}
            page={page}
            selected={on}
          />
        );
      })}
    </Document>
  );
}

/** A Word or PowerPoint file's sheets. Retry starts the drawing over in a new frame. */
function OfficeSheets(props: Omit<OfficeDrawingProps, 'onRetry'>) {
  const [attempt, setAttempt] = useState(0);
  return (
    <OfficeDrawing
      {...props}
      key={attempt}
      onRetry={() => setAttempt((n) => n + 1)}
    />
  );
}

interface OfficeDrawingProps {
  file: SourceFile;
  format: 'docx' | 'pptx';
  full: boolean;
  onCount: (fileId: string, pages: number) => void;
  onDrawn: (fileId: string, pages: readonly DrawnPage[]) => void;
  onRetry: () => void;
  onToggle: (key: string) => void;
  selected: ReadonlySet<string>;
}

/** The Office runtime draws every page in a frame off screen, with its print path, and
 * each becomes a JPEG the run is sent (Epo 2026-11-05, "draw those pages on client
 * side"). The frame is gone once it has drawn or failed: a render that timed out would
 * otherwise go on drawing, and it shares the app's main thread, so the wait is still. */
function OfficeDrawing({
  file,
  format,
  full,
  onCount,
  onDrawn,
  onRetry,
  onToggle,
  selected,
}: OfficeDrawingProps) {
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
    format,
    revision: file.revision,
  });
  const [pages, setPages] = useState<readonly DrawnPage[] | null>(null);
  const [failed, setFailed] = useState(false);
  const asked = useRef(false);
  useEffect(() => {
    if (!ready || !analysis || asked.current) return;
    asked.current = true;
    render('print')
      .then(async ({ pages: rendered }) => {
        const drawn: DrawnPage[] = [];
        // One at a time: a long deck decodes large PNGs.
        for (const page of rendered) drawn.push(await drawnPage(page));
        setPages(drawn);
        onCount(file.id, drawn.length);
        onDrawn(file.id, drawn);
      })
      .catch(() => setFailed(true));
  }, [analysis, file.id, onCount, onDrawn, ready, render]);
  const stopped = failed || !!error;
  return (
    <>
      {!stopped && !pages && (
        <iframe
          allow={iframeAllow}
          aria-hidden
          className="pointer-events-none fixed top-0 left-[-200vw] h-[768px] w-[1024px] border-0"
          inert
          key={iframeKey}
          ref={iframeRef}
          sandbox={iframeSandbox}
          src={iframeUrl}
          tabIndex={-1}
          title={m.files_office_document_frame_title({ name: file.name })}
        />
      )}
      {stopped ? (
        <div className="col-span-full flex items-center gap-3" role="alert">
          <p className="t-meta text-tint-error-fg">
            {m.make_quiz_pages_unavailable()}
          </p>
          <Button onClick={onRetry} size="sm" type="button" variant="outline">
            {m.error_action_retry()}
          </Button>
        </div>
      ) : pages ? (
        pages.map((page, i) => {
          const key = pageKey({ fileId: file.id, page: i + 1 });
          const on = selected.has(key);
          return (
            <Sheet
              disabled={full && !on}
              key={key}
              number={i + 1}
              onToggle={() => onToggle(key)}
              ratio={page.width / page.height}
              selected={on}
            >
              <img
                alt=""
                className="h-full w-full object-contain"
                decoding="async"
                src={page.url}
              />
            </Sheet>
          );
        })
      ) : (
        <p className="t-meta col-span-full text-fg-muted" role="status">
          {m.make_quiz_drawing_pages({ name: file.name })}
        </p>
      )}
    </>
  );
}

/** A text file's tile: no pages, the run reads all of it. */
function WholeFileTile({ file }: { file: SourceFile }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 rounded-[3px] border border-[#dcdfdf] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,.08)]"
      style={{ aspectRatio: SHEET_RATIO }}
    >
      <FileIcon className="size-11 shrink-0" name={fileIconName(file)} />
      <span className="wrap-anywhere text-center font-semibold text-sm">
        {file.name}
      </span>
    </div>
  );
}

type TabKind = 'pages' | 'reading' | 'unread' | 'whole';

function tabKind(file: SourceFile): TabKind {
  if (isReadingFile(file) && !file.indexed) return 'reading';
  if (isUnreadable(file)) return 'unread';
  return isWholeFile(file) ? 'whole' : 'pages';
}

const FILE_EXTENSION = /\.[^.]+$/;
const fileTitle = (name: string) => name.replace(FILE_EXTENSION, '');

/** What a step of the Make a quiz dialog puts in it. */
export interface DialogStep {
  action?: React.ReactNode;
  body: React.ReactNode;
  closable?: boolean;
  footer?: React.ReactNode;
  /** Keeps a stray click or Escape from ending the step. */
  guarded?: boolean;
  onBack?: () => void;
  onCloseClick?: () => void;
  title: React.ReactNode;
  width: number;
}

/**
 * Click the pages with questions, then with answers (Epo 2026-11-02, board X1;
 * 2026-11-05, boards B to E): pages shown large, one click selects one, up to 40 across
 * a run's files, and pages left unclicked are skipped. A text file goes whole. A step of
 * the Make a quiz dialog, so going back to the files keeps the picks of files left in.
 */
export function usePageStep({
  active,
  answers,
  onCancel,
  onChangeFiles,
  onStarted,
  paper,
  workspaceId,
}: {
  active: boolean;
  answers: string[];
  onCancel: () => void;
  /** Back to the files, with what was chosen and picked. */
  onChangeFiles: () => void;
  onStarted: (runId: string) => void;
  paper: string | undefined;
  workspaceId: string;
}): DialogStep {
  const phone = useIsPhone();
  const { data: files } = useFiles(workspaceId, { errorBoundary: false });
  const { data: materials } = useMaterials(workspaceId, {
    errorBoundary: false,
  });
  const { mutate: start, isPending, error } = useCreateExtraction(workspaceId);
  const chosen = paper ? [paper, ...answers] : answers;
  const chosenKey = chosen.join(',');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [drawn, setDrawn] = useState<ReadonlyMap<string, string>>(new Map());
  const [activeId, setActiveId] = useState<string>();
  // A tab's sheets stay mounted once opened, so a file isn't drawn twice.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const onDrawn = useCallback(
    (fileId: string, pages: readonly DrawnPage[]) =>
      setDrawn((current) => {
        const next = new Map(current);
        pages.forEach((page, i) => {
          next.set(pageKey({ fileId, page: i + 1 }), page.jpegBase64);
        });
        return next;
      }),
    []
  );
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
  // A file taken out of the dialog takes its picks with it.
  useEffect(() => {
    const ids = chosenKey.split(',');
    setSelected((current) => {
      const next = [...current].filter((key) =>
        ids.some((id) => key.startsWith(`${id}:`))
      );
      return next.length === current.size ? current : new Set(next);
    });
  }, [chosenKey]);
  const rows = chosen.flatMap((id) => {
    const file = files?.find((row) => row.id === id);
    return file ? [file] : [];
  });
  const first = rows.find((row) => row.id === paper);
  const answerFiles = rows.filter((row) => row.id !== paper);
  // An image is its one page, picked until unclicked.
  const imagesPicked = useRef(new Set<string>());
  useEffect(() => {
    if (!active) return;
    for (const file of rows) {
      if (file.kind !== 'image' || imagesPicked.current.has(file.id)) continue;
      if (tabKind(file) !== 'pages') continue;
      imagesPicked.current.add(file.id);
      const key = pageKey({ fileId: file.id, page: 1 });
      setSelected((current) =>
        current.has(key) ? current : togglePage(current, key)
      );
    }
  });
  const full = selected.size >= EXTRACTION_PAGES_MAX;
  const answersReading = answerFiles.some(
    (file) => tabKind(file) === 'reading'
  );
  const unpicked = rows.find(
    (file) =>
      tabKind(file) === 'pages' && pickedPages(selected, file.id).length === 0
  );
  const drawing = rows.some(
    (file) =>
      drawnPaperFormat(file) &&
      pickedPages(selected, file.id).some(
        (page) => !drawn.has(pageKey({ fileId: file.id, page }))
      )
  );
  const current = rows.find((row) => row.id === activeId) ?? first;
  const kind = current && tabKind(current);
  const activeCount = current ? counts[current.id] : undefined;
  const activePicked = current ? pickedPages(selected, current.id).length : 0;
  const allPicked = !!activeCount && activePicked === activeCount;
  const shown = new Set(opened);
  if (current) shown.add(current.id);
  const tabCount = (file: SourceFile) => {
    const tab = tabKind(file);
    if (tab === 'whole') return m.make_quiz_tab_whole();
    if (tab === 'unread') return m.make_quiz_tab_unread();
    if (tab === 'reading') return m.make_quiz_reading_pages();
    const count = pickedPages(selected, file.id).length;
    return (
      <>
        <span className="sm:hidden">{count}</span>
        <span className="max-sm:hidden">
          {count === 1 ? m.make_quiz_one_page() : m.source_pages({ count })}
        </span>
      </>
    );
  };
  const held = answersReading || (unpicked && selected.size > 0) || drawing;
  const counter = (
    <p className="flex min-w-0 flex-wrap items-baseline gap-x-2.5">
      <strong className="font-semibold">
        {m.make_quiz_pages_count({
          count: selected.size,
          max: EXTRACTION_PAGES_MAX,
        })}
      </strong>
      <span
        className={cn(
          't-meta text-fg-muted',
          !held && full && 'text-tint-error-fg'
        )}
      >
        {answersReading
          ? m.make_quiz_waiting_answers()
          : unpicked && selected.size > 0
            ? m.make_quiz_pick_in({ name: unpicked.name })
            : drawing
              ? m.make_quiz_drawing_picks()
              : full
                ? m.make_quiz_at_cap()
                : m.make_quiz_question_price({
                    price: EXTRACTION_QUESTION_CREDITS,
                  })}
      </span>
    </p>
  );
  const gone = !!files && !first;
  return {
    action: !gone && (
      <Button
        disabled={!!unpicked || answersReading || drawing || isPending}
        onClick={() => {
          if (!first) return;
          start(
            extractionRequest(
              quizTitleFrom(
                first.name,
                (materials ?? []).map((row) => row.title)
              ),
              first.id,
              answerFiles.map((file) => file.id),
              selected,
              drawn
            ),
            { onSuccess: (run) => onStarted(run.id) }
          );
        }}
        type="button"
      >
        {isPending ? <Spinner /> : m.make_quiz_extract()}
      </Button>
    ),
    body: gone ? (
      <div className="flex flex-col gap-3 pb-1">
        <p className="t-meta text-fg-muted">{m.make_quiz_file_gone()}</p>
        <div>
          <Button
            onClick={onChangeFiles}
            size="sm"
            type="button"
            variant="outline"
          >
            {m.make_quiz_change_files()}
          </Button>
        </div>
      </div>
    ) : (
      <div className="flex min-h-0 flex-col sm:h-[min(66dvh,640px)]">
        <div className="z-10 bg-overlay max-sm:sticky max-sm:top-14 max-sm:-mx-4 max-sm:px-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="t-meta min-w-0 flex-1 basis-40 truncate text-fg-muted">
              {[
                current?.name,
                kind === 'whole'
                  ? m.make_quiz_whole_note({ max: EXTRACTION_PAGES_MAX })
                  : activeCount &&
                    (activeCount === 1
                      ? m.make_quiz_one_page()
                      : m.source_pages({ count: activeCount })),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <div className="flex items-center gap-2">
              {kind === 'pages' && (
                <Button
                  disabled={
                    !activeCount || (full && !allPicked && activePicked === 0)
                  }
                  onClick={() =>
                    current &&
                    activeCount &&
                    setSelected((picks) =>
                      toggleAllPages(picks, current.id, activeCount)
                    )
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {allPicked
                    ? m.make_quiz_clear_all()
                    : m.make_quiz_select_all()}
                </Button>
              )}
              <Button
                onClick={onChangeFiles}
                size="sm"
                type="button"
                variant="outline"
              >
                {m.make_quiz_change_files()}
              </Button>
            </div>
          </div>
          <div
            aria-label={m.make_quiz_title()}
            className="mt-1.5 flex gap-4.5 overflow-x-auto border-divider border-b sm:gap-6"
            role="tablist"
          >
            {rows.map((file) => (
              <button
                aria-selected={file.id === current?.id}
                className={cn(
                  'flex h-10 shrink-0 cursor-pointer items-center gap-1.5 border-transparent border-b-2 px-0.5 font-medium text-fg-muted text-sm outline-none focus-visible:text-fg sm:gap-2',
                  file.id === current?.id && 'border-fg text-fg'
                )}
                key={file.id}
                onClick={() => {
                  setActiveId(file.id);
                  setOpened((was) => new Set(was).add(file.id));
                }}
                role="tab"
                type="button"
              >
                <span className="max-w-52 truncate">
                  {file.id === paper
                    ? m.make_quiz_tab_questions()
                    : fileTitle(file.name)}
                </span>
                <span className="t-meta font-normal text-fg-muted">
                  {tabCount(file)}
                </span>
              </button>
            ))}
          </div>
          {phone && <div className="py-2">{counter}</div>}
        </div>
        <div className="min-h-0 flex-1 sm:overflow-y-auto">
          {rows
            .filter((file) => shown.has(file.id))
            .map((file) => {
              const tab = tabKind(file);
              const format = drawnPaperFormat(file);
              return (
                <div
                  aria-label={file.name}
                  className="grid grid-cols-2 gap-x-3 gap-y-5 pt-3 pb-5 sm:grid-cols-[repeat(auto-fill,190px)] sm:justify-center sm:gap-x-6 sm:gap-y-6 sm:pt-5"
                  hidden={file.id !== current?.id}
                  key={file.id}
                  role="group"
                >
                  {tab === 'whole' ? (
                    <WholeFileTile file={file} />
                  ) : tab === 'unread' ? (
                    <p className="t-meta col-span-full text-center text-fg-muted">
                      {m.make_quiz_unread_note()}
                    </p>
                  ) : tab === 'reading' ? (
                    <p
                      className="t-meta col-span-full text-center text-fg-muted"
                      role="status"
                    >
                      {m.make_quiz_waiting_answers()}
                    </p>
                  ) : format ? (
                    <OfficeSheets
                      file={file}
                      format={format}
                      full={full}
                      onCount={onCount}
                      onDrawn={onDrawn}
                      onToggle={onToggle}
                      selected={selected}
                    />
                  ) : (
                    <PaperSheets
                      file={file}
                      full={full}
                      onCount={onCount}
                      onToggle={onToggle}
                      selected={selected}
                    />
                  )}
                </div>
              );
            })}
        </div>
        <FormAlert
          errorId={unexpectedErrorId(error)}
          message={
            error
              ? (extractionRefusal(error) ??
                errorCopy(error, m.source_try_again()))
              : null
          }
        />
      </div>
    ),
    closable: false,
    footer: (
      <>
        {!phone && <div className="mr-auto self-center">{counter}</div>}
        <span className="contents max-sm:hidden">
          <Button onClick={onCancel} type="button" variant="ghost-hover">
            {m.action_cancel()}
          </Button>
        </span>
      </>
    ),
    onBack: onChangeFiles,
    title:
      kind === 'whole'
        ? m.make_quiz_whole_title()
        : kind === 'unread'
          ? m.make_quiz_unread_title()
          : current && current.id !== paper
            ? m.make_quiz_answers_title()
            : m.make_quiz_pages_title(),
    width: 1040,
  };
}
