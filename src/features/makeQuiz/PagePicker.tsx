import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
      {/* On the body: a hidden tab or step would leave the frame no layout to draw in. */}
      {!stopped &&
        !pages &&
        createPortal(
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
          />,
          document.body
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
  /** A tall frame of its own columns and bottom bar, as Workspace settings has. */
  framed?: boolean;
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
  file,
  onCancel,
  onChangeFiles,
  onFile,
  onStarted,
  paper,
  workspaceId,
}: {
  active: boolean;
  answers: string[];
  /** The file on show, from the address; a phone's list when there is none. */
  file: string | undefined;
  onCancel: () => void;
  /** Back to the files, with what was chosen and picked. */
  onChangeFiles: () => void;
  onFile: (fileId: string | undefined) => void;
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
  // A file's sheets stay mounted once opened, so it isn't drawn twice.
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
  // A lone file needs no list, and a phone's list is the whole page until a file is
  // picked, as in Workspace settings.
  const listed = rows.length > 1;
  const onList = phone && listed && !rows.some((row) => row.id === file);
  const current = onList
    ? undefined
    : (rows.find((row) => row.id === file) ?? first);
  const kind = current && tabKind(current);
  const activeCount = current ? counts[current.id] : undefined;
  const activePicked = current ? pickedPages(selected, current.id).length : 0;
  const allPicked = !!activeCount && activePicked === activeCount;
  // Nothing opens, or draws, before the pages first show.
  const pagesShown = useRef(false);
  pagesShown.current ||= active;
  const shown = new Set(pagesShown.current ? opened : []);
  if (current && pagesShown.current) shown.add(current.id);
  const fileCount = (file: SourceFile) => {
    const tab = tabKind(file);
    if (tab === 'whole') return m.make_quiz_tab_whole();
    if (tab === 'unread') return m.make_quiz_tab_unread();
    if (tab === 'reading') return m.make_quiz_reading_pages();
    const count = pickedPages(selected, file.id).length;
    return count === 1 ? m.make_quiz_one_page() : m.source_pages({ count });
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
  const rowLabel = (row: SourceFile) =>
    row.id === paper ? m.make_quiz_tab_questions() : fileTitle(row.name);
  return {
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
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col sm:mt-1 sm:flex-row">
          {listed && (!phone || onList) && (
            <nav
              aria-label={m.make_quiz_title()}
              className="flex shrink-0 flex-col gap-1 sm:w-56 sm:overflow-y-auto sm:border-divider sm:border-r sm:pr-3"
            >
              {rows.map((row) => (
                <button
                  aria-current={row.id === current?.id ? 'page' : undefined}
                  className={cn(
                    'flex cursor-pointer items-center gap-2.5 rounded-button border-divider px-2 py-2.5 text-left outline-none hover:bg-surface-hover-bg focus-visible:bg-surface-hover-bg max-sm:border-b',
                    row.id === current?.id && 'bg-surface-hover-bg'
                  )}
                  key={row.id}
                  onClick={() => {
                    setOpened((was) => new Set(was).add(row.id));
                    onFile(row.id);
                  }}
                  type="button"
                >
                  <FileIcon
                    className="size-4 shrink-0"
                    name={fileIconName(row)}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium text-sm">
                      {rowLabel(row)}
                    </span>
                    <span className="t-meta truncate text-fg-muted">
                      {fileCount(row)}
                    </span>
                  </span>
                  <span className="shrink-0 text-fg-muted sm:hidden">
                    <Icon name="navigationForward" />
                  </span>
                </button>
              ))}
            </nav>
          )}
          {(!phone || !onList) && (
            <div
              className={cn(
                'flex min-h-0 min-w-0 flex-1 flex-col sm:-mr-5.5 sm:overflow-y-auto sm:pr-5.5',
                listed && 'sm:pl-4'
              )}
            >
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
              </div>
              {rows
                .filter((row) => shown.has(row.id))
                .map((row) => {
                  const tab = tabKind(row);
                  const format = drawnPaperFormat(row);
                  return (
                    <div
                      aria-label={row.name}
                      className="grid grid-cols-2 gap-x-6 gap-y-6 pt-4 pb-5 sm:grid-cols-[repeat(auto-fill,190px)] sm:justify-center"
                      hidden={row.id !== current?.id}
                      key={row.id}
                      role="group"
                    >
                      {tab === 'whole' ? (
                        <WholeFileTile file={row} />
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
                          file={row}
                          format={format}
                          full={full}
                          onCount={onCount}
                          onDrawn={onDrawn}
                          onToggle={onToggle}
                          selected={selected}
                        />
                      ) : (
                        <PaperSheets
                          file={row}
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
          )}
        </div>
        <div className="border-divider border-t bg-overlay pt-3 max-sm:sticky max-sm:bottom-0 max-sm:-mx-4 max-sm:px-4 max-sm:pb-[max(env(safe-area-inset-bottom),12px)] sm:mt-0 sm:pt-4">
          <FormAlert
            errorId={unexpectedErrorId(error)}
            message={
              error
                ? (extractionRefusal(error) ??
                  errorCopy(error, m.source_try_again()))
                : null
            }
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {counter}
            <div className="ml-auto flex items-center gap-1">
              <Button onClick={onChangeFiles} type="button" variant="outline">
                {m.make_quiz_change_files()}
              </Button>
              <span className="contents max-sm:hidden">
                <Button onClick={onCancel} type="button" variant="ghost-hover">
                  {m.action_cancel()}
                </Button>
              </span>
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
                      answerFiles.map((row) => row.id),
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
            </div>
          </div>
        </div>
      </div>
    ),
    closable: false,
    framed: !gone,
    // Phones: from one file's pages to the list, from the list to the files.
    onBack: onList || !listed ? onChangeFiles : () => onFile(undefined),
    title: onList
      ? m.make_quiz_choose_pages()
      : kind === 'whole'
        ? m.make_quiz_whole_title()
        : kind === 'unread'
          ? m.make_quiz_unread_title()
          : current && current.id !== paper
            ? m.make_quiz_answers_title()
            : m.make_quiz_pages_title(),
    width: 1040,
  };
}
