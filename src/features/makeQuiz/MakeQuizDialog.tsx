import { type RefObject, useEffect, useRef, useState } from 'react';
import { useFiles } from '@/api/hooks';
import {
  EXTRACTION_ANSWER_FILES_MAX,
  EXTRACTION_PAPER_FILES_MAX,
} from '@/api/limits.generated';
import type {
  AssignmentFormReq,
  Extraction,
  SourceFile,
  SourceUploadPolicy,
} from '@/api/types';
import { Button } from '@/components/ui/Button';
import { DialogCancel, SimpleDialog } from '@/components/ui/Dialog';
import { FileIcon } from '@/components/ui/FileIcon';
import { FormAlert } from '@/components/ui/FormAlert';
import { Icon } from '@/components/ui/Icon';
import { InputTitle } from '@/components/ui/Input';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Switch } from '@/components/ui/Switch';
import {
  ChooseFileButton,
  FileMenuNote,
  FileMenuRow,
  FileSearchMenu,
  RemoveFileButton,
} from '@/features/files/FileSearchMenu';
import { matchesSearch } from '@/features/workspace/PanelSearch';
import {
  type SourceTransfer,
  useSourceTransfers,
} from '@/features/workspace/sourceTransfers';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName } from '@/lib/fileIcons';
import { useRunStep } from './ExtractionProgress';
import {
  hasAnswerRoom,
  hasPaperRoom,
  isOfferable,
  isQuizFile,
  isReadingFile,
  isUnreadable,
} from './makeQuiz';
import { type DialogStep, usePageStep } from './PagePicker';
import { addQuizWait, clearQuizNotice, useQuizNotice } from './quizWaits';
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

/** A picked file as the upload panel follows it (quizWaits). */
const waitingFile = ({ fileId, key, name }: Picked) => ({ fileId, key, name });

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
  | { kind: 'ready' }
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
      ? { kind: 'ready' }
      : { detail: m.make_quiz_not_readable(), kind: 'failed' };
  return { file, kind: 'reading', pct: readingPct(transfer, file) };
}

/** A chosen file's row (X0b): icon, name, then how its reading goes, then its
 * action. */
function FileRow({
  end,
  files,
  picked,
}: {
  end: React.ReactNode;
  files: SourceFile[] | undefined;
  picked: Picked;
}) {
  const state = useRowState(picked, files);
  return (
    <div className="flex min-h-8 min-w-0 items-center gap-2 pl-2">
      <FileIcon
        className="size-4 shrink-0"
        name={fileIconName({ kind: picked.kind, name: picked.name })}
      />
      <span className="min-w-0 truncate font-semibold">{picked.name}</span>
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

/** A file in the menu (X0a), ticked once chosen. One still being read is
 * greyed out until it is read (Epo 2026-11-12): picking it would leave the
 * dialog waiting on it. */
function MenuFileRow({
  file,
  full,
  onPick,
  selected,
}: {
  file: SourceFile;
  /** The field holds as many as it takes: only a ticked row can be pressed. */
  full: boolean;
  onPick: () => void;
  selected: boolean;
}) {
  const reading = isReadingFile(file) && !file.indexed;
  const off = reading || (full && !selected);
  return (
    <FileMenuRow
      aria-disabled={off}
      className={cn(full && !selected && 'disabled:cursor-default')}
      disabled={off}
      onClick={onPick}
      role="option"
      selected={selected}
    >
      <FileIcon
        className="size-4 shrink-0"
        name={fileIconName({ kind: file.kind, name: file.name })}
      />
      <span className="min-w-0 flex-1 truncate">{file.name}</span>
      {reading && (
        <span className="t-meta shrink-0 font-medium text-fg-muted">
          {m.make_quiz_reading_pages()}
        </span>
      )}
    </FileMenuRow>
  );
}

/** The file menu (X0a): search, Upload a file, then the workspace's files,
 * the field's chosen ones ticked; a ticked one's row takes it off. */
function FileMenu({
  chosen,
  files,
  full,
  label,
  onOpenChange,
  onPick,
  onUpload,
  open,
  policy,
  trigger,
  workspaceName,
}: {
  /** The field's files' ids. */
  chosen: Set<string>;
  files: SourceFile[];
  full: boolean;
  label: string;
  onOpenChange: (open: boolean) => void;
  onPick: (file: SourceFile) => void;
  onUpload: () => void;
  open: boolean;
  policy: SourceUploadPolicy | undefined;
  trigger: React.ReactNode;
  workspaceName: string;
}) {
  return (
    <FileSearchMenu
      label={label}
      onOpenChange={onOpenChange}
      open={open}
      searchLabel={m.make_quiz_search_files()}
      top={
        <>
          <FileMenuRow disabled={!policy || full} onClick={onUpload}>
            <Icon name="upload" size={16} />
            {m.make_quiz_upload_file()}
          </FileMenuRow>
          <hr className="my-1 border-divider" />
          <p className="px-2.5 pt-2 pb-1.5 font-bold text-[11px] text-fg-muted uppercase leading-none tracking-[.06rem]">
            {m.make_quiz_in_workspace({ workspace: workspaceName })}
          </p>
        </>
      }
      trigger={trigger}
    >
      {(query) => {
        const shown = files.filter((file) => matchesSearch(file.name, query));
        return (
          <>
            {shown.map((file) => (
              <MenuFileRow
                file={file}
                full={full}
                key={file.id}
                onPick={() => onPick(file)}
                selected={chosen.has(file.id)}
              />
            ))}
            {shown.length === 0 && (
              <FileMenuNote>{m.common_no_matches()}</FileMenuNote>
            )}
          </>
        );
      }}
    </FileSearchMenu>
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
  graded,
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
  tabs,
  workspaceId,
  workspaceName,
}: {
  /** The file whose pages are on show. */
  file: string | undefined;
  /** A graded quiz's settings (Epo 2026-11-16): the run makes the graded
   * quiz with its quiz, so there is no Hide the quiz switch, and the dialog
   * stays open while its files upload and read and the run goes on. */
  graded?: AssignmentFormReq;
  /** From the address, for a link or a reload. */
  initial: MakeQuizChoice;
  onClose: () => void;
  /** The questions are confirmed: the dialog gives way to the upload panel. */
  onConfirmed: (run: Extraction, choice: MakeQuizChoice) => void;
  onDone: (quizId: string, assignmentId?: string) => void;
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
  /** Add quiz: the files step is one tab of a dialog under this title.
   * `strip` is its tab row and `other` the tab on show when it isn't this one,
   * in place of the files and their footer. */
  tabs?: {
    /** A graded quiz's Back to its Settings: the footer's on wider screens,
     * the header's arrow on phones. */
    onBack?: () => void;
    other?: { body: React.ReactNode; footer: React.ReactNode };
    strip: React.ReactNode;
    title: React.ReactNode;
  };
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
  // Hidden unless switched off (Epo 2026-11-03, the switch 2026-11-11). A
  // reload on a later step starts from the default again.
  // Hide the quiz starts on wherever the dialog opens, Practice's Add
  // practice too (Epo 2026-11-16, every quiz an editor makes starts hidden).
  const [hidden, setHidden] = useState(true);
  // A link opens before the files arrive.
  const seeded = useRef(!!files);
  useEffect(() => {
    if (seeded.current || !files) return;
    seeded.current = true;
    setPaper(fromFiles(initial.paper));
    setAnswers(fromFiles(initial.answers));
  });
  // Files a wait lost before this dialog opened again (openQuizWait): read once as
  // the dialog opens and said while it stays open.
  const [lost] = useState(() => useQuizNotice.getState().failures);
  useEffect(() => {
    clearQuizNotice();
  }, []);
  // Which field's menu is open.
  const [menu, setMenu] = useState<'answers' | 'paper' | null>(null);
  const paperInput = useRef<HTMLInputElement>(null);
  const answersInput = useRef<HTMLInputElement>(null);

  const ids = (rows: Picked[]) =>
    new Set(rows.flatMap((row) => row.fileId ?? []));
  const paperIds = ids(paper);
  const answerIds = ids(answers);
  // Each field's menu: the files the other field hasn't taken, its own ticked.
  const quizFiles = (files ?? []).filter(
    (file) => isOfferable(file) && isQuizFile(file)
  );
  const paperFiles = quizFiles.filter((file) => !answerIds.has(file.id));
  const answerFiles = quizFiles.filter((file) => !paperIds.has(file.id));
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
  // The upload panel sits under the dialog, so an upload from here closes the dialog
  // and the panel follows it, offering Make quiz once it is read (Epo 2026-11-09). The
  // browser counts a file's pages in the dialog first, so it closes once every file
  // picked has started, or been refused.
  const [uploading, setUploading] = useState<string[]>([]);
  useEffect(() => {
    if (uploading.length === 0) return;
    const picked = [...paper, ...answers];
    const started = uploading.every(
      (key) =>
        transfers.some((item) => item.key === key) ||
        !picked.some((row) => row.key === key)
    );
    if (!started) return;
    setUploading([]);
    if (!picked.some((row) => uploading.includes(row.key))) return;
    addQuizWait({
      answers: answers.map(waitingFile),
      paper: paper.map(waitingFile),
      title: paper[0]?.name ?? answers[0]?.name ?? '',
      workspaceId,
    });
    onClose();
  }, [answers, onClose, paper, transfers, uploading, workspaceId]);

  // The menus offer only files read (one still being read is greyed out, Epo
  // 2026-11-12), so a pick stays in the dialog until Continue.
  const remove = (set: typeof setPaper, row: Picked) => {
    cancel(row.key);
    set((current) => current.filter((item) => item.key !== row.key));
  };
  /** A menu row adds its file to the field, or takes a ticked one off; the
   * menu stays open for more (Epo 2026-11-12). */
  const toggleFile = (
    rows: Picked[],
    set: typeof setPaper,
    file: SourceFile
  ) => {
    const held = rows.find((row) => row.fileId === file.id);
    if (held) remove(set, held);
    else set([...rows, pickedOf(file)]);
  };

  const addPaperFiles = (list: File[]) => {
    const rows = add(list.slice(0, EXTRACTION_PAPER_FILES_MAX - paper.length));
    if (rows.length === 0) return;
    setPaper((current) => [...current, ...rows]);
    if (!graded)
      setUploading((current) => [...current, ...rows.map((row) => row.key)]);
  };
  const startUpload = (target: 'answers' | 'paper') => {
    setMenu(null);
    (target === 'answers' ? answersInput : paperInput).current?.click();
  };
  const removeButton = (set: typeof setPaper, row: Picked) => (
    <RemoveFileButton
      label={m.make_quiz_remove_file({ name: row.name })}
      onClick={() => remove(set, row)}
    />
  );

  const choice = {
    answers: answers.flatMap((row) => row.fileId ?? []),
    paper: paper.flatMap((row) => row.fileId ?? []),
  };
  const pages = usePageStep({
    active: onPages,
    answers: choice.answers,
    file,
    graded,
    hidden,
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
          if (rows.length === 0) return;
          setAnswers((current) => [...current, ...rows]);
          if (!graded)
            setUploading((current) => [
              ...current,
              ...rows.map((row) => row.key),
            ]);
        }}
      />
      {/* 16px between sections, as Workspace settings. Each field keeps Choose a file above the files
          chosen, whose rows end in × (Epo 2026-11-12). */}
      <div className="flex flex-col gap-4 pb-1">
        <div>
          <p className="t-meta text-fg-muted">
            {m.make_quiz_no_spreadsheets()} {m.make_quiz_uploads_hidden()}
          </p>
          {lost.length > 0 && (
            <FormAlert
              message={m.make_quiz_some_files_failed({
                names: lost
                  .map(({ name, reason }) => `${name} (${reason})`)
                  .join(', '),
              })}
            />
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <InputTitle>
            {m.make_quiz_question_paper()}{' '}
            <span className="t-meta font-normal text-fg-muted">
              · {m.make_quiz_up_to({ count: EXTRACTION_PAPER_FILES_MAX })}
            </span>
          </InputTitle>
          <FileMenu
            chosen={paperIds}
            files={paperFiles}
            full={!paperRoom}
            label={m.make_quiz_question_paper()}
            onOpenChange={(open) => setMenu(open ? 'paper' : null)}
            onPick={(file) => toggleFile(paper, setPaper, file)}
            onUpload={() => startUpload('paper')}
            open={menu === 'paper'}
            policy={policy}
            trigger={<ChooseFileButton />}
            workspaceName={workspaceName}
          />
          {paper.length > 0 && (
            <div>
              {paper.map((row) => (
                <FileRow
                  end={removeButton(setPaper, row)}
                  files={files}
                  key={row.key}
                  picked={row}
                />
              ))}
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <InputTitle>
            {m.make_quiz_answers()}{' '}
            <span className="t-meta font-normal text-fg-muted">
              · {m.make_quiz_optional()},{' '}
              {m.make_quiz_up_to({ count: EXTRACTION_ANSWER_FILES_MAX })}
            </span>
          </InputTitle>
          <FileMenu
            chosen={answerIds}
            files={answerFiles}
            full={!room}
            label={m.make_quiz_answers()}
            onOpenChange={(open) => setMenu(open ? 'answers' : null)}
            onPick={(file) => toggleFile(answers, setAnswers, file)}
            onUpload={() => startUpload('answers')}
            open={menu === 'answers'}
            policy={policy}
            trigger={<ChooseFileButton />}
            workspaceName={workspaceName}
          />
          {answers.length > 0 && (
            <div>
              {answers.map((row) => (
                <FileRow
                  end={removeButton(setAnswers, row)}
                  files={files}
                  key={row.key}
                  picked={row}
                />
              ))}
            </div>
          )}
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
            // Continue is the primary: the header's right on phones, the
            // footer's end elsewhere.
            action: !tabs?.other && (
              <Button
                // A graded quiz's files read here, not in the upload panel.
                disabled={!canContinue || (graded && !allRead)}
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
                variant="accent"
              >
                {m.action_continue()}
              </Button>
            ),
            body: null,
            closable: !!tabs,
            footer: tabs?.other ? (
              tabs.other.footer
            ) : graded ? (
              tabs?.onBack && (
                <Button
                  className="max-sm:hidden"
                  onClick={tabs.onBack}
                  size="md"
                  type="button"
                  variant="outline"
                >
                  {m.action_back()}
                </Button>
              )
            ) : (
              <>
                <label className="mr-auto flex min-w-0 items-center gap-2 self-center text-sm max-sm:w-full">
                  <Switch checked={hidden} onCheckedChange={setHidden} />
                  {m.make_quiz_hide_quiz()}
                </label>
                {/* Not closable without tabs, so the dialog adds no Cancel. */}
                {!tabs && (
                  <span className="contents max-sm:hidden">
                    <DialogCancel />
                  </span>
                )}
              </>
            ),
            onBack: tabs?.onBack,
            onCloseClick: onClose,
            title: tabs?.title ?? m.make_quiz_title(),
            width: tabs ? 600 : 720,
          };
  // The tabs share one height, so switching tabs or adding files never
  // resizes the dialog; a tab's own body scrolls (Epo 2026-11-16).
  const tabbed = !!tabs && stepName === 'files';
  return (
    <SimpleDialog
      action={step.action}
      cardClassName={cn((step.framed || tabbed) && 'h-full')}
      cardScrollContainerClassName={cn(
        step.framed && 'max-sm:pb-0 sm:overflow-hidden'
      )}
      className={cn(
        step.framed && 'flex h-[88dvh] flex-col gap-0',
        tabbed && 'flex flex-col gap-0 sm:h-[min(680px,88dvh)]'
      )}
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
      <div
        className={cn(tabbed && 'flex min-h-0 flex-1 flex-col')}
        hidden={stepName !== 'files'}
      >
        {tabs?.strip}
        <div
          className={cn(tabbed && 'min-h-0 flex-1 overflow-y-auto')}
          hidden={!!tabs?.other}
        >
          {filesBody}
        </div>
        {tabs?.other?.body}
      </div>
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
