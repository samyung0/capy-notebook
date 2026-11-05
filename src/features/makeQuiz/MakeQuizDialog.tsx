import { type RefObject, useEffect, useRef, useState } from 'react';
import { useFiles } from '@/api/hooks';
import {
  EXTRACTION_ANSWER_FILES_MAX,
  EXTRACTION_PAPER_FILES_MAX,
} from '@/api/limits.generated';
import type { Extraction, SourceFile, SourceUploadPolicy } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { DialogCancel, SimpleDialog } from '@/components/ui/Dialog';
import { FileIcon } from '@/components/ui/FileIcon';
import { Icon } from '@/components/ui/Icon';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { selectTriggerVariants } from '@/components/ui/Select';
import {
  matchesSearch,
  PanelSearchField,
} from '@/features/workspace/PanelSearch';
import {
  type SourceTransfer,
  useSourceTransfers,
} from '@/features/workspace/sourceTransfers';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName } from '@/lib/fileIcons';
import { useRunStep } from './ExtractionProgress';
import { useFilePages, useSeen } from './filePages';
import {
  hasAnswerRoom,
  hasPaperRoom,
  isOfferable,
  isQuizFile,
  isReadingFile,
  isUnreadable,
} from './makeQuiz';
import { type DialogStep, usePageStep } from './PagePicker';
import { addQuizWait } from './quizWaits';
import { useQuizUpload } from './useQuizUpload';

/** A file on the dialog: from Files, or an upload, whose transfer row `key`
 * names; it has its file id once sent, kept here because the transfer panel
 * lets its finished rows go. */
interface Picked {
  failure?: string;
  fileId?: string;
  key: string;
  kind: SourceFile['kind'];
  name: string;
}

/** A run's files: the question paper and the answer files. */
export interface MakeQuizChoice {
  answers: string[];
  paper: string[];
}

function pickedOf(file: SourceFile): Picked {
  return { fileId: file.id, key: file.id, kind: file.kind, name: file.name };
}

/** Upload and read, the file's whole way in, on one bar ("Reading pages",
 * X0b): the bytes take the first 40%. */
function readingPct(transfer: SourceTransfer | undefined, file?: SourceFile) {
  if (file?.status === 'processing' || file?.status === 'pending')
    return 40 + (file.ingestPct ?? 0) * 0.6;
  return (transfer?.uploadPct ?? 0) * 0.4;
}

type RowState =
  | { kind: 'failed'; detail: string }
  | { kind: 'ready'; file: SourceFile }
  | { kind: 'reading'; file?: SourceFile; pct: number };

function useRowState(
  picked: Picked,
  files: SourceFile[] | undefined
): RowState {
  const transfer = useSourceTransfers((state) =>
    state.transfers.find((row) => row.key === picked.key)
  );
  const file = picked.fileId
    ? files?.find((row) => row.id === picked.fileId)
    : undefined;
  if (picked.failure) return { detail: picked.failure, kind: 'failed' };
  if (file && file.status !== 'pending' && file.status !== 'processing')
    return file.indexed
      ? { file, kind: 'ready' }
      : { detail: m.make_quiz_not_readable(), kind: 'failed' };
  return { file, kind: 'reading', pct: readingPct(transfer, file) };
}

/** "16 pages", once known. */
function PagesMeta({
  className,
  file,
  policy,
}: {
  className?: string;
  file: SourceFile;
  policy: SourceUploadPolicy | undefined;
}) {
  const pages = useFilePages(file, policy);
  if (!pages) return null;
  return (
    <span className={cn('t-meta shrink-0 text-fg-muted', className)}>
      {pages === 1 ? m.make_quiz_one_page() : m.source_pages({ count: pages })}
    </span>
  );
}

/** A chosen file's row (X0b): icon, name, then its pages or how its reading
 * goes, then its action. */
function FileRow({
  end,
  files,
  last,
  metaAtEnd,
  picked,
  policy,
}: {
  end: React.ReactNode;
  files: SourceFile[] | undefined;
  /** The list's last row has no line under it. */
  last: boolean;
  /** The count beside the action rather than the name (the answers' rows). */
  metaAtEnd?: boolean;
  picked: Picked;
  policy: SourceUploadPolicy | undefined;
}) {
  const state = useRowState(picked, files);
  return (
    <div
      className={cn(
        'flex min-h-10 min-w-0 items-center gap-2 py-1',
        !last && 'border-divider border-b'
      )}
    >
      <FileIcon
        className="size-4 shrink-0"
        name={fileIconName({ kind: picked.kind, name: picked.name })}
      />
      <span className="min-w-0 truncate font-semibold">{picked.name}</span>
      {state.kind === 'ready' && !metaAtEnd && (
        <PagesMeta file={state.file} policy={policy} />
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {state.kind === 'reading' && (
          <>
            <span className="t-meta text-fg-muted max-sm:hidden">
              {m.make_quiz_reading_pages()}
            </span>
            <ProgressBar
              className="w-16"
              height={4}
              tone="purple"
              value={state.pct}
            />
          </>
        )}
        {state.kind === 'ready' && metaAtEnd && (
          <PagesMeta file={state.file} policy={policy} />
        )}
        {state.kind === 'failed' && (
          <span className="t-meta max-w-52 truncate text-tint-error-fg">
            {state.detail}
          </span>
        )}
        {end}
      </span>
    </div>
  );
}

/** A row of the file menu. */
function MenuRow({ className, ...props }: React.ComponentProps<'button'>) {
  return (
    <button
      className={cn(
        'flex min-h-9 w-full shrink-0 cursor-pointer items-center gap-2.5 rounded-button px-2.5 text-left font-semibold outline-none hover:bg-surface-hover-bg focus-visible:bg-surface-hover-bg disabled:cursor-progress disabled:opacity-50',
        className
      )}
      type="button"
      {...props}
    />
  );
}

/** A file in the menu (X0a): its count is read once it scrolls into view. */
function MenuFileRow({
  file,
  onPick,
  policy,
}: {
  file: SourceFile;
  onPick: () => void;
  policy: SourceUploadPolicy | undefined;
}) {
  const [ref, seen] = useSeen<HTMLButtonElement>();
  const pages = useFilePages(file, policy, seen);
  return (
    <MenuRow aria-selected={false} onClick={onPick} ref={ref} role="option">
      <FileIcon
        className="size-4 shrink-0"
        name={fileIconName({ kind: file.kind, name: file.name })}
      />
      <span className="min-w-0 truncate">{file.name}</span>
      <span className="t-meta ml-auto shrink-0 font-medium text-fg-muted">
        {file.status === 'pending' || file.status === 'processing'
          ? m.make_quiz_reading_pages()
          : pages === 1
            ? m.make_quiz_one_page()
            : pages
              ? m.source_pages({ count: pages })
              : null}
      </span>
    </MenuRow>
  );
}

/** The file menu (X0a): search, Upload a file, then the workspace's files. */
function FileMenu({
  files,
  label,
  onOpenChange,
  onPick,
  onUpload,
  open,
  policy,
  trigger,
  workspaceName,
  wide,
}: {
  files: SourceFile[];
  label: string;
  onOpenChange: (open: boolean) => void;
  onPick: (file: SourceFile) => void;
  onUpload: () => void;
  open: boolean;
  policy: SourceUploadPolicy | undefined;
  trigger: React.ReactNode;
  workspaceName: string;
  /** Under a small button: as wide as the dialog's fields, not the button. */
  wide?: boolean;
}) {
  const [query, setQuery] = useState('');
  const shown = files.filter((file) => matchesSearch(file.name, query));
  return (
    <Popover
      onOpenChange={(next) => {
        if (!next) setQuery('');
        onOpenChange(next);
      }}
      open={open}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        alignWidthToTrigger={!wide}
        className={cn(
          'max-h-[min(420px,70dvh)] gap-0 overflow-hidden p-1.5',
          wide && 'w-[550px] max-w-[calc(100vw-2rem)]'
        )}
      >
        <div className="mb-1 shrink-0">
          <PanelSearchField
            label={m.make_quiz_search_files()}
            onChange={setQuery}
            value={query}
          />
        </div>
        <MenuRow disabled={!policy} onClick={onUpload}>
          <Icon name="upload" size={16} />
          {m.make_quiz_upload_file()}
        </MenuRow>
        <hr className="my-1 border-divider" />
        <p className="px-2.5 pt-2 pb-1.5 font-bold text-[11px] text-fg-muted uppercase leading-none tracking-[.06rem]">
          {m.make_quiz_in_workspace({ workspace: workspaceName })}
        </p>
        <div
          aria-label={label}
          className="min-h-0 overflow-y-auto"
          role="listbox"
        >
          {shown.map((file) => (
            <MenuFileRow
              file={file}
              key={file.id}
              onPick={() => onPick(file)}
              policy={policy}
            />
          ))}
          {shown.length === 0 && (
            <p className="t-meta px-2.5 py-2 text-fg-muted">
              {m.make_quiz_no_files()}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The hidden file picker behind Upload a file. */
function UploadInput({
  accept,
  inputRef,
  multiple,
  onFiles,
}: {
  accept?: string;
  inputRef: RefObject<HTMLInputElement | null>;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
}) {
  return (
    <input
      accept={accept}
      className="hidden"
      multiple={multiple}
      onChange={(event) => {
        const list = Array.from(event.target.files ?? []);
        event.target.value = '';
        if (list.length > 0) onFiles(list);
      }}
      ref={inputRef}
      type="file"
    />
  );
}

/**
 * Make a quiz from a file (Epo 2026-11-03, boards X0a, X0b; 2026-11-05, "make the select
 * pages from files the same dialog rather than inside a page"): one dialog, from the
 * files through their pages and the run's map to the questions found, then the upload
 * panel. The question paper and any mark scheme or answer files come from Files or a new
 * upload. Continue goes on to the pages once the paper's are ready; an answer file may
 * still be reading then.
 */
export function MakeQuizDialog({
  file,
  initial,
  onClose,
  onConfirmed,
  onDone,
  onFile,
  onRunBack,
  onShowFiles,
  onShowPages,
  onStarted,
  runId,
  step: stepName,
  workspaceId,
  workspaceName,
}: {
  /** The file whose pages are on show. */
  file: string | undefined;
  /** From the address, for a link or a reload. */
  initial: MakeQuizChoice;
  onClose: () => void;
  /** The questions are confirmed: the dialog gives way to the upload panel. */
  onConfirmed: (run: Extraction, choice: MakeQuizChoice) => void;
  onDone: (quizId: string) => void;
  onFile: (fileId: string | undefined) => void;
  /** A run failed or was cancelled: back to its pages, picks and all. */
  onRunBack: () => void;
  onShowFiles: (choice: MakeQuizChoice) => void;
  onShowPages: (choice: MakeQuizChoice) => void;
  onStarted: (runId: string, choice: MakeQuizChoice) => void;
  /** The run this dialog is on, from the address. */
  runId?: string;
  /** Each step is an address, so the browser's Back walks them. */
  step: 'files' | 'pages' | 'run';
  workspaceId: string;
  workspaceName: string;
}) {
  const { data: files } = useFiles(workspaceId, { errorBoundary: false });
  const { add, cancel, policy } = useQuizUpload(workspaceId, (key) => {
    const others = (rows: Picked[]) => rows.filter((row) => row.key !== key);
    setPaper(others);
    setAnswers(others);
  });
  const fromFiles = (ids: string[]): Picked[] =>
    ids.flatMap((id) => {
      const file = files?.find((row) => row.id === id);
      return file ? [pickedOf(file)] : [];
    });
  const [paper, setPaper] = useState<Picked[]>(() => fromFiles(initial.paper));
  const [answers, setAnswers] = useState<Picked[]>(() =>
    fromFiles(initial.answers)
  );
  const onPages = stepName === 'pages';
  // A link opens before the files arrive.
  const seeded = useRef(!!files);
  useEffect(() => {
    if (seeded.current || !files) return;
    seeded.current = true;
    setPaper(fromFiles(initial.paper));
    setAnswers(fromFiles(initial.answers));
  });
  // Which menu is open: the paper's, or Add a file under either list.
  const [menu, setMenu] = useState<'answers' | 'more' | 'paper' | null>(null);
  const paperInput = useRef<HTMLInputElement>(null);
  const answersInput = useRef<HTMLInputElement>(null);

  const usedIds = new Set(
    [...paper, ...answers].flatMap((row) => row.fileId ?? [])
  );
  const offered = (files ?? []).filter(
    (file) => isOfferable(file) && !usedIds.has(file.id)
  );
  const quizFiles = offered.filter(isQuizFile);
  const paperRoom = hasPaperRoom(paper.length);
  const room = hasAnswerRoom(answers.length);

  // An upload's file id or failure, as its transfer learns them.
  const transfers = useSourceTransfers((state) => state.transfers);
  useEffect(() => {
    const settle = (rows: Picked[]) => {
      let changed = false;
      const next = rows.map((row) => {
        const transfer = transfers.find((item) => item.key === row.key);
        if (!transfer) return row;
        const failure =
          transfer.stage === 'failed'
            ? (transfer.error ?? m.make_quiz_not_readable())
            : undefined;
        if (transfer.fileId === row.fileId && failure === row.failure)
          return row;
        changed = true;
        return { ...row, failure, fileId: transfer.fileId ?? row.fileId };
      });
      return changed ? next : rows;
    };
    setPaper(settle);
    setAnswers(settle);
  }, [transfers]);
  // An upload goes on without the dialog once it has started: before that the browser
  // is still reading its page count, here.
  const usable = (row: Picked) => {
    const file = files?.find((item) => item.id === row.fileId);
    return (
      !row.failure &&
      !(file && isUnreadable(file)) &&
      (!!row.fileId || transfers.some((item) => item.key === row.key))
    );
  };
  const allRead = [...paper, ...answers].every((row) => {
    const file = files?.find((item) => item.id === row.fileId);
    return !!file && !(isReadingFile(file) && !file.indexed);
  });
  const canContinue =
    paper.length > 0 && paper.every(usable) && answers.every(usable);
  const waitingFile = ({ fileId, key }: Picked) => ({ fileId, key });

  // Which menu asked for the upload, kept past the menu closing.
  const uploadFor = useRef<'more' | 'paper'>('paper');
  const addPaperFiles = (list: File[]) => {
    const more = uploadFor.current === 'more';
    const rows = add(
      list.slice(0, EXTRACTION_PAPER_FILES_MAX - (more ? paper.length : 0))
    );
    if (rows.length > 0)
      setPaper((current) => (more ? [...current, ...rows] : rows));
  };
  const startUpload = (target: 'answers' | 'more' | 'paper') => {
    setMenu(null);
    if (target === 'answers') answersInput.current?.click();
    else {
      uploadFor.current = target;
      paperInput.current?.click();
    }
  };
  const removeButton = (set: typeof setPaper, row: Picked) => (
    <Button
      aria-label={m.make_quiz_remove_file({ name: row.name })}
      onClick={() => {
        cancel(row.key);
        set((current) => current.filter((item) => item.key !== row.key));
      }}
      size="sm"
      type="button"
      variant="outline"
    >
      {m.make_quiz_remove()}
    </Button>
  );

  const choice = {
    answers: answers.flatMap((row) => row.fileId ?? []),
    paper: paper.flatMap((row) => row.fileId ?? []),
  };
  const pages = usePageStep({
    active: onPages,
    answers: choice.answers,
    file,
    onCancel: onClose,
    onChangeFiles: () => onShowFiles(choice),
    onFile,
    onStarted: (id) => onStarted(id, choice),
    paper: choice.paper,
    workspaceId,
  });
  const run = useRunStep({
    onBack: choice.paper.length > 0 ? onRunBack : onClose,
    onConfirmed: (next) => onConfirmed(next, choice),
    onDone,
    onLeave: onClose,
    runId,
  });
  const filesBody = (
    <>
      <UploadInput inputRef={paperInput} multiple onFiles={addPaperFiles} />
      <UploadInput
        inputRef={answersInput}
        multiple
        onFiles={(list) => {
          const rows = add(
            list.slice(0, EXTRACTION_ANSWER_FILES_MAX - answers.length)
          );
          setAnswers((current) => [...current, ...rows]);
        }}
      />
      <div className="flex flex-col gap-7 pb-1">
        <p className="t-meta text-fg-muted">{m.make_quiz_no_spreadsheets()}</p>
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="t-meta font-semibold text-fg-secondary">
            {m.make_quiz_question_paper()}{' '}
            <span className="font-medium text-fg-muted">
              · {m.make_quiz_up_to({ count: EXTRACTION_PAPER_FILES_MAX })}
            </span>
          </p>
          {paper.length === 0 ? (
            <FileMenu
              files={quizFiles}
              label={m.make_quiz_question_paper()}
              onOpenChange={(open) => setMenu(open ? 'paper' : null)}
              onPick={(file) => {
                setPaper([pickedOf(file)]);
                setMenu(null);
              }}
              onUpload={() => startUpload('paper')}
              open={menu === 'paper'}
              policy={policy}
              trigger={
                <button
                  aria-expanded={menu === 'paper'}
                  className={cn(
                    selectTriggerVariants(),
                    'w-full justify-between text-fg-muted'
                  )}
                  type="button"
                >
                  {m.make_quiz_choose_file()}
                  <Icon name="chevronDown" size={16} />
                </button>
              }
              workspaceName={workspaceName}
            />
          ) : (
            <>
              {paper.map((row, i) => (
                <FileRow
                  end={
                    paper.length > 1 ? (
                      removeButton(setPaper, row)
                    ) : (
                      <FileMenu
                        files={quizFiles}
                        label={m.make_quiz_question_paper()}
                        onOpenChange={(open) => setMenu(open ? 'paper' : null)}
                        onPick={(file) => {
                          setPaper([pickedOf(file)]);
                          setMenu(null);
                        }}
                        onUpload={() => startUpload('paper')}
                        open={menu === 'paper'}
                        policy={policy}
                        trigger={
                          <Button size="sm" type="button" variant="outline">
                            {m.make_quiz_change()}
                          </Button>
                        }
                        wide
                        workspaceName={workspaceName}
                      />
                    )
                  }
                  files={files}
                  key={row.key}
                  last={i === paper.length - 1}
                  picked={row}
                  policy={policy}
                />
              ))}
              <div className="mt-2">
                <FileMenu
                  files={quizFiles}
                  label={m.make_quiz_question_paper()}
                  onOpenChange={(open) => setMenu(open ? 'more' : null)}
                  onPick={(file) => {
                    setPaper((current) => [...current, pickedOf(file)]);
                    setMenu(null);
                  }}
                  onUpload={() => startUpload('more')}
                  open={menu === 'more'}
                  policy={policy}
                  trigger={
                    <Button
                      disabled={!paperRoom}
                      iconLeft="plus"
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {m.make_quiz_add_file()}
                    </Button>
                  }
                  wide
                  workspaceName={workspaceName}
                />
              </div>
            </>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="t-meta font-semibold text-fg-secondary">
            {m.make_quiz_answers()}{' '}
            <span className="font-medium text-fg-muted">
              · {m.make_quiz_optional()},{' '}
              {m.make_quiz_up_to({ count: EXTRACTION_ANSWER_FILES_MAX })}
            </span>
          </p>
          {answers.map((row, i) => (
            <FileRow
              end={removeButton(setAnswers, row)}
              files={files}
              key={row.key}
              last={i === answers.length - 1}
              metaAtEnd
              picked={row}
              policy={policy}
            />
          ))}
          <div className={cn(answers.length > 0 && 'mt-2')}>
            <FileMenu
              files={quizFiles}
              label={m.make_quiz_answers()}
              onOpenChange={(open) => setMenu(open ? 'answers' : null)}
              onPick={(file) => {
                setAnswers((current) => [...current, pickedOf(file)]);
                setMenu(null);
              }}
              onUpload={() => startUpload('answers')}
              open={menu === 'answers'}
              policy={policy}
              trigger={
                <Button
                  disabled={!room}
                  iconLeft="plus"
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {m.make_quiz_add_file()}
                </Button>
              }
              wide
              workspaceName={workspaceName}
            />
          </div>
        </div>
      </div>
    </>
  );
  const step: DialogStep =
    stepName === 'run'
      ? run
      : onPages
        ? pages
        : {
            body: null,
            closable: false,
            footer: (
              <>
                <p className="t-meta mr-auto flex min-w-0 items-center gap-2 self-center text-fg-muted max-sm:w-full">
                  <Icon className="shrink-0" name="viewOffSlash" size={16} />
                  {m.make_quiz_hidden_note()}
                </p>
                <span className="contents max-sm:hidden">
                  <DialogCancel />
                </span>
                <Button
                  className="max-sm:ml-auto"
                  disabled={!canContinue}
                  onClick={() => {
                    if (allRead) {
                      onShowPages(choice);
                      return;
                    }
                    // Still reading, which may take a while: the panel follows it, and
                    // the pages open once it is done.
                    addQuizWait({
                      answers: answers.map(waitingFile),
                      paper: paper.map(waitingFile),
                      title: paper[0]?.name ?? '',
                      workspaceId,
                    });
                    onClose();
                  }}
                  type="button"
                >
                  {m.action_continue()}
                </Button>
              </>
            ),
            onCloseClick: onClose,
            title: m.make_quiz_title(),
            width: 720,
          };
  return (
    <SimpleDialog
      action={step.action}
      cardClassName={cn(step.framed && 'h-full')}
      cardScrollContainerClassName={cn(
        step.framed && 'max-sm:pb-0 sm:overflow-hidden'
      )}
      className={cn(step.framed && 'flex h-[88dvh] flex-col gap-0')}
      footer={step.footer}
      onBack={step.onBack}
      onClose={step.guarded ? () => undefined : onClose}
      onCloseClick={step.onCloseClick}
      onEscapeKeyDown={
        step.guarded ? (event) => event.preventDefault() : undefined
      }
      onInteractOutside={
        step.guarded ? (event) => event.preventDefault() : undefined
      }
      // The dialog takes focus, not its first button.
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        (event.currentTarget as HTMLElement).focus();
      }}
      open
      showCloseButton={step.closable ?? true}
      title={step.title}
      width={step.width}
    >
      {/* Kept mounted, so a step's pages aren't read or drawn again on return. */}
      <div hidden={stepName !== 'files'}>{filesBody}</div>
      <div
        className={cn(onPages && 'flex min-h-0 flex-1 flex-col')}
        hidden={!onPages}
      >
        {pages.body}
      </div>
      {stepName === 'run' && run.body}
    </SimpleDialog>
  );
}
