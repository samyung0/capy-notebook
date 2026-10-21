import { type ReactNode, useState } from 'react';
import {
  useFiles,
  useRetryFileProcessing,
  useRetryingFileIds,
  useUpdateWorkspace,
} from '@/api/hooks';
import type {
  FileChange,
  NoteChange,
  SourceFile,
  Workspace,
  WorkspaceStats,
} from '@/api/types';
import {
  type Segment,
  UsageBar,
  UsageHead,
  UsageLegend,
} from '@/components/app/UsageMeter';
import { Button } from '@/components/ui/Button';
import { ErrorId } from '@/components/ui/ErrorId';
import { FileIcon } from '@/components/ui/FileIcon';
import { Skeleton, SkeletonList, Spinner } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Switch } from '@/components/ui/Switch';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { m } from '@/i18n';
import {
  type FileIconName,
  fileIconName,
  materialIconName,
} from '@/lib/fileIcons';
import { userColorPair } from '@/lib/userColor';
import { AddSourceDialog } from './AddSourceDialog';
import { retryFailedFile } from './retryProcessing';
import {
  useCancelFileChanges,
  useProcessFileChanges,
} from './useProcessFileChanges';

// Work in flight first, then what needs the owner.
const STATE_ORDER: Record<FileChange['state'], number> = {
  failed: 3,
  processing: 0,
  queued: 1,
  waiting: 2,
};

function ChangeStatus({
  change,
}: {
  change: Pick<FileChange, 'lastEditedAt' | 'state'>;
}) {
  switch (change.state) {
    case 'processing':
      return (
        <>
          <Spinner className="size-3.5" />
          {m.workspace_change_processing()}
        </>
      );
    case 'queued':
      return (
        <>
          <Icon name="clock" size={14} />
          {m.workspace_change_queued()}
        </>
      );
    case 'failed':
      return (
        <span className="flex items-center gap-1.5 text-tint-error-fg">
          <Icon name="alert" size={14} />
          {m.workspace_change_failed()}
        </span>
      );
    default:
      return (
        <>
          <Icon name="pencil" size={14} />
          {m.workspace_change_edited({
            time: relativeTime(change.lastEditedAt),
          })}
        </>
      );
  }
}

/** One file or note in the changes list. */
type ChangeRow = Pick<FileChange, 'errorId' | 'lastEditedAt' | 'state'> & {
  icon: FileIconName;
  id: string;
  name: string;
  note: boolean;
};

function FileChanges({
  changes,
  moreNotes,
  noteChanges,
  owner,
  workspaceId,
}: {
  changes: FileChange[];
  /** Notes past the list's cap, not listed. */
  moreNotes: number;
  noteChanges: NoteChange[];
  /** Only the owner processes or cancels; editors see the same rows and
   * status without any action (Epo 2026-10-21). */
  owner: boolean;
  workspaceId: string;
}) {
  const { mutate: process, isPending: processing } =
    useProcessFileChanges(workspaceId);
  const { mutate: cancel, isPending: cancelling } =
    useCancelFileChanges(workspaceId);
  const busy = processing || cancelling;
  // Notes are listed like files and processed now the same way (Epo
  // 2026-10-21); a queued note job has no Cancel.
  const rows: ChangeRow[] = [
    ...changes.map((change) => ({
      errorId: change.errorId,
      icon: fileIconName(change),
      id: change.fileId,
      lastEditedAt: change.lastEditedAt,
      name: change.name,
      note: false,
      state: change.state,
    })),
    ...noteChanges.map((change) => ({
      errorId: change.errorId,
      icon: materialIconName('note'),
      id: change.materialId,
      lastEditedAt: change.lastEditedAt,
      name: change.title,
      note: true,
      state: change.state,
    })),
  ].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
  const processable = rows.filter(
    (row) => row.state === 'waiting' || row.state === 'failed'
  );
  const processRows = (targets: ChangeRow[]) =>
    process({
      fileIds: targets.filter((row) => !row.note).map((row) => row.id),
      noteIds: targets.filter((row) => row.note).map((row) => row.id),
    });
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="t-subtitle font-bold">{m.workspace_file_changes()}</p>
        {owner && processable.length > 0 && (
          <Button
            disabled={busy}
            onClick={() => processRows(processable)}
            size="sm"
          >
            {m.workspace_change_process_all()}
          </Button>
        )}
      </div>
      <p className="t-meta mt-1 text-fg-muted">
        {m.workspace_file_changes_hint()}
      </p>
      {rows.length ? (
        <ul className="m-0 mt-3 flex list-none flex-col p-0">
          {rows.map((row) => (
            <li
              className="grid min-h-11 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 py-1.5 sm:flex sm:flex-wrap"
              data-state={row.state}
              key={row.id}
            >
              <FileIcon className="size-3.75" name={row.icon} />
              <span className="min-w-0 truncate sm:flex-1">{row.name}</span>
              <span className="t-meta col-start-2 flex shrink-0 -translate-x-0.5 items-center gap-1.5 text-fg-muted">
                <ChangeStatus change={row} />
              </span>
              {owner && !row.note && row.state === 'queued' && (
                <Button
                  className="col-start-3 row-span-2 row-start-1"
                  disabled={busy}
                  onClick={() => cancel(row.id)}
                  size="sm"
                  variant="outline"
                >
                  {m.action_cancel()}
                </Button>
              )}
              {owner && (row.state === 'waiting' || row.state === 'failed') && (
                <Button
                  className="col-start-3 row-span-2 row-start-1"
                  disabled={busy}
                  onClick={() => processRows([row])}
                  size="sm"
                  variant="outline"
                >
                  {row.state === 'failed'
                    ? m.error_action_retry()
                    : m.workspace_change_process()}
                </Button>
              )}
              {/* A failed row's error id, on its own line under the row and
                  aligned with the name; the failure's text stays hidden. */}
              {row.errorId && (
                <ErrorId
                  className="col-start-2 mt-1 text-fg-muted sm:basis-full sm:pl-6.75"
                  id={row.errorId}
                />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-fg-muted">{m.workspace_file_changes_empty()}</p>
      )}
      {moreNotes > 0 && (
        <p className="t-meta mt-2 text-fg-muted">
          {m.workspace_note_changes_more({ count: String(moreNotes) })}
        </p>
      )}
    </div>
  );
}

/** Files whose processing failed, each with its error id. Automatic
 * processing skips them; the owner retries one through the upload dialog's
 * Retry processing, or in one click when it is still indexed (a part missing,
 * parts design Q8). */
function FailedFiles({
  owner,
  workspaceId,
}: {
  owner: boolean;
  workspaceId: string;
}) {
  const { data: files } = useFiles(workspaceId, { errorBoundary: false });
  const [retrying, setRetrying] = useState<SourceFile | null>(null);
  const { mutateAsync: retryProcessing } = useRetryFileProcessing(workspaceId);
  const retryingIds = useRetryingFileIds(workspaceId);
  const failed = files?.filter((file) => file.status === 'failed') ?? [];
  if (!failed.length) return null;
  return (
    <div>
      <p className="t-subtitle font-bold">{m.workspace_failed_files()}</p>
      <p className="t-meta mt-1 text-fg-muted">
        {m.workspace_failed_files_hint()}
      </p>
      <ul className="m-0 mt-3 flex list-none flex-col p-0">
        {failed.map((file) => (
          <li
            className="grid min-h-11 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 py-1.5 sm:flex sm:flex-wrap"
            key={file.id}
          >
            <FileIcon className="size-3.75" name={fileIconName(file)} />
            <span className="min-w-0 truncate sm:flex-1">{file.name}</span>
            <span className="t-meta col-start-2 flex shrink-0 items-center gap-1.5 text-tint-error-fg">
              <Icon name="alert" size={14} />
              {m.workspace_change_failed()}
            </span>
            {owner && (
              <Button
                className="col-start-3 row-span-2 row-start-1"
                disabled={retryingIds.includes(file.id)}
                onClick={() =>
                  retryFailedFile(file, retryProcessing, () =>
                    setRetrying(file)
                  )
                }
                size="sm"
                variant="outline"
              >
                {m.error_action_retry()}
              </Button>
            )}
            {file.errorId && (
              <ErrorId
                className="col-start-2 mt-1 text-fg-muted sm:basis-full sm:pl-6.75"
                id={file.errorId}
              />
            )}
          </li>
        ))}
      </ul>
      {retrying && (
        <AddSourceDialog
          onClose={() => setRetrying(null)}
          open
          retryFile={retrying}
          workspaceId={workspaceId}
        />
      )}
    </div>
  );
}

/** The tab's shape while the stats load: meter, legend, change list. */
function IndexingSkeleton() {
  return (
    <div
      aria-label={m.a11y_loading()}
      className="flex flex-col gap-10"
      role="status"
    >
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-2/5" />
        <Skeleton className="h-2.5 rounded-full" />
        <SkeletonList count={3} rowHeight={24} />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-1/3" />
        <SkeletonList count={3} />
      </div>
    </div>
  );
}

/** The workspace settings Indexing tab: which sources are searchable, the file
 * and note changes still to process, and the automatic processing switch. */
export function IndexingTab({
  error,
  stats,
  workspace,
}: {
  /** Replaces the whole tab when the stats failed to load. */
  error: ReactNode;
  stats: WorkspaceStats | undefined;
  workspace: Workspace;
}) {
  const { mutateAsync: update, isPending: saving } = useUpdateWorkspace();
  if (error) return error;
  if (!stats) return <IndexingSkeleton />;
  const total = stats.indexed + stats.notIndexed + stats.notIndexable;
  const sources: (Segment & { value: string })[] = [
    ['indexed', m.workspace_indexed(), 'green', stats.indexed] as const,
    [
      'notIndexed',
      m.workspace_not_indexed(),
      'amber',
      stats.notIndexed,
    ] as const,
    [
      'notIndexable',
      m.workspace_not_indexable(),
      'blue',
      stats.notIndexable,
    ] as const,
  ].map(([key, label, tone, amount]) => ({
    amount,
    color: userColorPair(tone).bg,
    key,
    label,
    value: String(amount),
  }));
  return (
    <div className="flex flex-col gap-10">
      <div>
        <UsageHead
          title={m.workspace_sources_title()}
          value={m.workspace_sources_indexed_of({
            indexed: String(stats.indexed),
            total: String(total),
          })}
        />
        {total ? (
          <>
            <UsageBar limit={total} segments={sources} />
            <div className="mt-4">
              <UsageLegend segments={sources} />
            </div>
          </>
        ) : (
          <p className="mt-2 text-fg-muted">{m.workspace_no_sources()}</p>
        )}
      </div>
      <FileChanges
        changes={stats.fileChanges}
        moreNotes={stats.moreNoteChanges}
        noteChanges={stats.noteChanges}
        owner={workspace.isOwner}
        workspaceId={workspace.id}
      />
      <FailedFiles owner={workspace.isOwner} workspaceId={workspace.id} />
      <label className="flex items-center justify-between gap-5">
        <span className="font-medium">{m.workspace_auto_process()}</span>
        {/* Owner-only, like the actions above; the server refuses editors. */}
        <Switch
          checked={workspace.autoProcess}
          disabled={saving || !workspace.isOwner}
          onCheckedChange={(autoProcess) => {
            void update({ autoProcess, id: workspace.id }).catch(() => {});
          }}
        />
      </label>
    </div>
  );
}
