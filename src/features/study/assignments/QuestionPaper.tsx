import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useChangePaperFile, useFile, useFiles } from '@/api/hooks';
import type { AssignmentFile, SourceFile } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { FileIcon } from '@/components/ui/FileIcon';
import { Spinner } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { SearchInput } from '@/components/ui/SearchInput';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { userToast } from '@/components/ui/userToast';
import { downloadFile } from '@/features/files/downloadItem';
import { FileError, FileLoading } from '@/features/files/FileStates';
import { FileViewer } from '@/features/files/FileViewer';
import { FileHeaderTarget } from '@/features/files/fileModeContext';
import {
  clampImageZoom,
  IMAGE_MAX_ZOOM,
  IMAGE_MIN_ZOOM,
  IMAGE_ZOOM_STEP,
  isImageFile,
} from '@/features/files/fileUtils';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy, unexpectedErrorId } from '@/lib/errors';
import { PickList, paperFileRows } from './ExistingQuizPicker';
import { assignmentFileIcon, SectionLabel } from './todoParts';

/** Who may change the question paper: its graded quiz's staff. */
type PaperChange = { assignmentId: string; workspaceId: string };

/** The question paper's card beside Your answers (mock Attempt): its name and
 * Download, the latest saved state as the Files page's download gives it.
 * With `onOpen`, one row holding Open and Download (the results' Question
 * paper, mock QEetGvcmf2vvkVfqcYAKLz), Download's word dropped on phones. */
export function QuestionPaperCard({
  className,
  file,
  onOpen,
}: {
  className?: string;
  file: AssignmentFile | null;
  onOpen?: () => void;
}) {
  const { data } = useFile(file?.fileId ?? null, { errorBoundary: false });
  const download = useDownload();
  const downloadButton = (
    <Button
      className={cn(!onOpen && 'self-start')}
      disabled={!data}
      iconLeft="download"
      onClick={() => data && download(data)}
      size="sm"
      variant="outline"
    >
      {onOpen ? (
        <span className="max-sm:sr-only">{m.action_download()}</span>
      ) : (
        m.action_download()
      )}
    </Button>
  );
  return (
    <section
      aria-label={m.assignment_question_paper()}
      className={cn('flex flex-col gap-2', className)}
    >
      <SectionLabel>{m.assignment_question_paper()}</SectionLabel>
      {file ? (
        <>
          <div className="flex min-h-8 items-center gap-2">
            <FileIcon
              className="size-4 shrink-0"
              name={assignmentFileIcon(file)}
            />
            <span className="min-w-0 flex-1 truncate font-semibold">
              {file.name}
            </span>
            {onOpen && (
              <>
                <Button
                  aria-label={m.assignment_open_named({ name: file.name })}
                  onClick={onOpen}
                  size="sm"
                  variant="outline"
                >
                  {m.assignment_open()}
                </Button>
                {downloadButton}
              </>
            )}
          </div>
          {!onOpen && downloadButton}
        </>
      ) : (
        <p className="t-meta text-fg-secondary">
          {m.assignment_question_paper_gone()}
        </p>
      )}
    </section>
  );
}

function useDownload() {
  const queryClient = useQueryClient();
  return (file: SourceFile) => void downloadFile(file, queryClient);
}

/** The question paper in the workspace's own viewer, read live, under the
 * workspace file header's row: the viewer's page count and zoom, and on a
 * phone (or with `named`) the file's name and Download, which the card holds
 * from a tablet up. A member reads it in View: no room joins, and its saved
 * edits are read once. Staff who may edit the file may do so here. */
export function QuestionPaperView({
  change,
  file,
  named = false,
}: {
  /** Staff's Change file, here and when the file is gone. */
  change?: PaperChange;
  file: AssignmentFile | null;
  /** Name and Download at every width: no card beside it. */
  named?: boolean;
}) {
  const [header, setHeader] = useState<HTMLElement | null>(null);
  const [zoom, setZoom] = useState(IMAGE_MIN_ZOOM);
  const [changing, setChanging] = useState(false);
  const { data, error, isError, isPending, refetch } = useFile(
    file?.fileId ?? null,
    { errorBoundary: false }
  );
  const download = useDownload();
  const changeDialog = change && changing && (
    <ChangePaperDialog
      {...change}
      current={file?.fileId}
      onClose={() => setChanging(false)}
    />
  );
  const changeButton = change && (
    <Button
      className="shrink-0"
      onClick={() => setChanging(true)}
      size="sm"
      type="button"
      variant="outline"
    >
      {m.assignment_change_file()}
    </Button>
  );
  if (!file)
    return (
      <div className="grid h-full place-items-center px-4">
        <div className="flex max-w-sm flex-col items-center gap-3.5 text-center">
          <p className="text-fg-secondary">
            {/* Staff (the report's, `named`) are the ones to ask. */}
            {named
              ? m.assignment_question_paper_gone_staff()
              : m.assignment_question_paper_gone()}
          </p>
          {changeButton}
        </div>
        {changeDialog}
      </div>
    );
  const image = !!data && isImageFile(data);
  const nameClass = cn(!named && 'md:hidden');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-divider border-b pr-2 pl-4 sm:gap-2">
        {/* The name and Download sit on the card from a tablet up. */}
        <span
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2',
            !named && 'md:invisible'
          )}
        >
          <FileIcon
            className="size-4.5 shrink-0 -translate-y-px"
            name={assignmentFileIcon(file)}
          />
          <h2 className="t-subtitle min-w-0 flex-1 truncate">{file.name}</h2>
        </span>
        {changeButton}
        <div className="flex items-center gap-0">
          <div className="contents" ref={setHeader}>
            {image && (
              <>
                <ToolbarButton
                  disabled={zoom <= IMAGE_MIN_ZOOM}
                  label={m.material_zoom_out()}
                  onClick={() =>
                    setZoom(clampImageZoom(zoom - IMAGE_ZOOM_STEP))
                  }
                >
                  <Icon name="zoomOut" />
                </ToolbarButton>
                <ToolbarButton
                  disabled={zoom >= IMAGE_MAX_ZOOM}
                  label={m.material_zoom_in()}
                  onClick={() =>
                    setZoom(clampImageZoom(zoom + IMAGE_ZOOM_STEP))
                  }
                >
                  <Icon name="zoomIn" />
                </ToolbarButton>
              </>
            )}
          </div>
          <ToolbarButton
            className={nameClass}
            disabled={!data}
            label={m.action_download()}
            onClick={() => data && download(data)}
          >
            <Icon name="download" />
          </ToolbarButton>
        </div>
      </div>
      {/* The workspace's own box for its viewers (CenterContent). */}
      <div className="relative min-h-0 flex-1 overflow-auto">
        {isPending ? (
          <FileLoading />
        ) : isError || !data ? (
          <FileError
            errorId={unexpectedErrorId(error)}
            onRetry={() => void refetch()}
          />
        ) : (
          <FileHeaderTarget.Provider value={header}>
            <FileViewer
              file={data}
              imageZoom={zoom}
              onImageZoomChange={setZoom}
            />
          </FileHeaderTarget.Provider>
        )}
      </div>
      {changeDialog}
    </div>
  );
}

/** Change file (Epo 2026-11-20, mock QEetGvcmf2vvkVfqcYAKLz, as Gradescope
 * replaces a template PDF): another file of the workspace becomes the
 * question paper, its rows the Existing file tab's; answers and marks stay. */
function ChangePaperDialog({
  assignmentId,
  current,
  onClose,
  workspaceId,
}: PaperChange & { current: string | undefined; onClose: () => void }) {
  const {
    data: files,
    error,
    isError,
    refetch,
  } = useFiles(workspaceId, { errorBoundary: false });
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState(current);
  const { isPending, mutate: change } = useChangePaperFile(
    workspaceId,
    assignmentId
  );
  const rows =
    files &&
    paperFileRows(files, (file) =>
      file.id === current ? m.assignment_paper_current() : undefined
    );
  return (
    <SimpleDialog
      action={
        <Button
          disabled={isPending || !picked || picked === current}
          onClick={() =>
            picked &&
            change(picked, {
              onError: (failure) =>
                userToast({
                  title: errorCopy(failure, m.assignment_change_file_failed()),
                  variant: 'error',
                }),
              onSuccess: onClose,
            })
          }
          type="button"
        >
          {isPending ? <Spinner /> : m.assignment_change()}
        </Button>
      }
      onClose={onClose}
      open
      title={m.assignment_change_file()}
      width={560}
    >
      <div className="flex h-[min(56dvh,420px)] flex-col">
        <SearchInput
          aria-label={m.assignment_search_files()}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={m.assignment_search_files()}
          value={query}
          wrapperClassName="h-8 min-w-0 shrink-0"
        />
        <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
          <PickList
            failed={
              isError ? { error, retry: () => void refetch() } : undefined
            }
            label={m.assignment_change_file()}
            onPick={setPicked}
            picked={picked}
            query={query}
            rows={rows}
          />
        </div>
        <p className="t-meta mt-3 text-fg-secondary">
          {m.assignment_change_file_note()}
        </p>
      </div>
    </SimpleDialog>
  );
}
