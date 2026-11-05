import { type RefObject, useEffect, useRef, useState } from 'react';
import { useFiles } from '@/api/hooks';
import type { SourceFile, SourceUploadPolicy } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { DialogCancel, SimpleDialog } from '@/components/ui/Dialog';
import { FileIcon } from '@/components/ui/FileIcon';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { selectTriggerVariants } from '@/components/ui/Select';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { matchesSearch } from '@/features/workspace/PanelSearch';
import {
  type SourceTransfer,
  useSourceTransfers,
} from '@/features/workspace/sourceTransfers';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName } from '@/lib/fileIcons';
import { useFilePages, useSeen } from './filePages';
import {
  hasFileRoom,
  isAnswersFile,
  isOfferable,
  isPaperFile,
} from './makeQuiz';
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

/** What the dialog hands on: the paper's files and the answer files. */
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
  metaAtEnd,
  picked,
  policy,
}: {
  end: React.ReactNode;
  files: SourceFile[] | undefined;
  /** The count beside the action rather than the name (the answers' rows). */
  metaAtEnd?: boolean;
  picked: Picked;
  policy: SourceUploadPolicy | undefined;
}) {
  const state = useRowState(picked, files);
  return (
    <div className="flex min-h-10 min-w-0 items-center gap-2 border-divider border-b py-1">
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
        <Input
          aria-label={m.make_quiz_search_files()}
          leftIcon="search"
          maxLength={120}
          onChange={(event) => setQuery(event.target.value)}
          value={query}
          wrapperClassName="mb-1 shrink-0"
        />
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
 * Make a quiz from a file (Epo 2026-11-03, boards X0a, X0b): the question paper
 * from Files or a new upload, and any mark scheme or answer files. Continue
 * goes on to the page picker once the paper's pages are ready; an answer file
 * may still be reading then. Also the New quiz route of New assignment's quiz
 * picker (A1c): `onContinue` decides where the choice goes.
 */
export function MakeQuizDialog({
  initial,
  onClose,
  onContinue,
  workspaceId,
  workspaceName,
}: {
  /** Back from the page picker with what was chosen. */
  initial?: MakeQuizChoice;
  onClose: () => void;
  onContinue: (choice: MakeQuizChoice) => void;
  workspaceId: string;
  workspaceName: string;
}) {
  const { data: files } = useFiles(workspaceId, { errorBoundary: false });
  const { add, cancel, policy } = useQuizUpload(workspaceId);
  const fromFiles = (ids: string[] | undefined): Picked[] =>
    (ids ?? []).flatMap((id) => {
      const file = files?.find((row) => row.id === id);
      return file ? [pickedOf(file)] : [];
    });
  const [paper, setPaper] = useState<Picked[]>(() => fromFiles(initial?.paper));
  const [answers, setAnswers] = useState<Picked[]>(() =>
    fromFiles(initial?.answers)
  );
  // Which menu is open: the paper's, or Add a file under either list.
  const [menu, setMenu] = useState<'answers' | 'paper' | 'pages' | null>(null);
  const paperInput = useRef<HTMLInputElement>(null);
  const answersInput = useRef<HTMLInputElement>(null);

  const usedIds = new Set(
    [...paper, ...answers].flatMap((row) => row.fileId ?? [])
  );
  const offered = (files ?? []).filter(
    (file) => isOfferable(file) && !usedIds.has(file.id)
  );
  const paperFiles = offered.filter(isPaperFile);
  const answerFiles = offered.filter(isAnswersFile);
  const room = hasFileRoom(paper.length, answers.length);
  // A photographed paper can be several images, one a page (§8).
  const imagePaper =
    paper.length > 0 && paper.every((row) => row.kind === 'image');

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
  const readyFile = (row: Picked) => {
    const file = files?.find((item) => item.id === row.fileId);
    return (
      !!file?.indexed &&
      file.status !== 'pending' &&
      file.status !== 'processing'
    );
  };
  const canContinue =
    paper.length > 0 &&
    paper.every(readyFile) &&
    answers.every((row) => !!row.fileId && !row.failure);

  // Which menu asked for the upload, kept past the menu closing.
  const uploadFor = useRef<'pages' | 'paper'>('paper');
  const addPaperFiles = (list: File[]) => {
    const rows = add(list, true);
    if (rows.length === 0) return;
    setPaper((current) =>
      uploadFor.current === 'pages' ? [...current, ...rows] : rows
    );
  };
  const startUpload = (target: 'answers' | 'pages' | 'paper') => {
    setMenu(null);
    if (target === 'answers') answersInput.current?.click();
    else {
      uploadFor.current = target;
      paperInput.current?.click();
    }
  };
  const removeButton = (set: typeof setPaper, row: Picked) => (
    <ToolbarButton
      className="size-7"
      label={m.make_quiz_remove_file({ name: row.name })}
      onClick={() => {
        cancel(row.key);
        set((current) => current.filter((item) => item.key !== row.key));
      }}
    >
      <Icon name="x" size={16} />
    </ToolbarButton>
  );

  return (
    <SimpleDialog
      action={
        <Button
          disabled={!canContinue}
          onClick={() =>
            onContinue({
              answers: answers.flatMap((row) => row.fileId ?? []),
              paper: paper.flatMap((row) => row.fileId ?? []),
            })
          }
          type="button"
        >
          {m.action_continue()}
        </Button>
      }
      footer={
        <>
          <p className="t-meta mr-auto flex min-w-0 items-center gap-2 self-center text-fg-muted">
            <Icon className="shrink-0" name="viewOffSlash" size={16} />
            {m.make_quiz_hidden_note()}
          </p>
          <span className="contents max-sm:hidden">
            <DialogCancel />
          </span>
        </>
      }
      onClose={onClose}
      onCloseClick={onClose}
      open
      showCloseButton={false}
      title={m.make_quiz_title()}
      width={600}
    >
      <UploadInput
        accept=".pdf,image/*"
        inputRef={paperInput}
        onFiles={addPaperFiles}
      />
      <UploadInput
        inputRef={answersInput}
        multiple
        onFiles={(list) => {
          const rows = add(list);
          setAnswers((current) => [...current, ...rows]);
        }}
      />
      <div className="flex flex-col gap-4 pb-1">
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="t-meta font-semibold text-fg-secondary">
            {m.make_quiz_question_paper()}
          </p>
          <p className="t-meta text-fg-muted">
            {m.make_quiz_no_spreadsheets()}
          </p>
          {paper.length === 0 ? (
            <FileMenu
              files={paperFiles}
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
              {paper.map((row) => (
                <FileRow
                  end={
                    paper.length > 1 ? (
                      removeButton(setPaper, row)
                    ) : (
                      <FileMenu
                        files={paperFiles}
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
                  picked={row}
                  policy={policy}
                />
              ))}
              {imagePaper && room && (
                <div className="mt-2">
                  <FileMenu
                    files={paperFiles.filter((file) => file.kind === 'image')}
                    label={m.make_quiz_question_paper()}
                    onOpenChange={(open) => setMenu(open ? 'pages' : null)}
                    onPick={(file) => {
                      setPaper((current) => [...current, pickedOf(file)]);
                      setMenu(null);
                    }}
                    onUpload={() => startUpload('pages')}
                    open={menu === 'pages'}
                    policy={policy}
                    trigger={
                      <Button
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
              )}
            </>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="t-meta font-semibold text-fg-secondary">
            {m.make_quiz_answers()}{' '}
            <span className="font-medium text-fg-muted">
              · {m.make_quiz_optional()}
            </span>
          </p>
          {answers.map((row) => (
            <FileRow
              end={removeButton(setAnswers, row)}
              files={files}
              key={row.key}
              metaAtEnd
              picked={row}
              policy={policy}
            />
          ))}
          <div className={cn(answers.length > 0 && 'mt-2')}>
            <FileMenu
              files={answerFiles}
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
    </SimpleDialog>
  );
}
