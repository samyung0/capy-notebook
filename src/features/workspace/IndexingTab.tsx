import { type ReactNode, useState } from 'react';
import { useFiles, useUpdateWorkspace } from '@/api/hooks';
import type {
  FileChange,
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
import { FileIcon } from '@/components/ui/FileIcon';
import { Skeleton, SkeletonList, Spinner } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Switch } from '@/components/ui/Switch';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { m } from '@/i18n';
import { fileIconName } from '@/lib/fileIcons';
import { userColorPair } from '@/lib/userColor';
import { AddSourceDialog } from './AddSourceDialog';
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

function ChangeStatus({ change }: { change: FileChange }) {
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

function FileChanges({
  changes,
  owner,
  pendingNotes,
  workspaceId,
}: {
  changes: FileChange[];
  /** Only the owner processes or cancels; editors see the list. */
  owner: boolean;
  pendingNotes: number;
  workspaceId: string;
}) {
  const { mutate: process, isPending: processing } =
    useProcessFileChanges(workspaceId);
  const { mutate: cancel, isPending: cancelling } =
    useCancelFileChanges(workspaceId);
  const busy = processing || cancelling;
  const sorted = [...changes].sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]
  );
  const processable = sorted
    .filter((change) => change.state === 'waiting' || change.state === 'failed')
    .map((change) => change.fileId);
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="t-subtitle font-bold">{m.workspace_file_changes()}</p>
        {owner && processable.length > 0 && (
          <Button
            disabled={busy}
            onClick={() => process(processable)}
            size="sm"
          >
            {m.workspace_change_process_all()}
          </Button>
        )}
      </div>
      <p className="t-meta mt-1 text-fg-muted">
        {m.workspace_file_changes_hint()}
      </p>
      {sorted.length ? (
        <ul className="m-0 mt-3 flex list-none flex-col p-0">
          {sorted.map((change) => (
            <li
              className="grid min-h-11 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 py-1.5 sm:flex"
              data-state={change.state}
              key={change.fileId}
            >
              <FileIcon className="size-3.75" name={fileIconName(change)} />
              <span className="min-w-0 truncate sm:flex-1">{change.name}</span>
              <span className="t-meta col-start-2 flex shrink-0 -translate-x-0.5 items-center gap-1.5 text-fg-muted">
                <ChangeStatus change={change} />
              </span>
              {owner && change.state === 'queued' && (
                <Button
                  className="col-start-3 row-span-2 row-start-1"
                  disabled={busy}
                  onClick={() => cancel(change.fileId)}
                  size="sm"
                  variant="outline"
                >
                  {m.action_cancel()}
                </Button>
              )}
              {owner &&
                (change.state === 'waiting' || change.state === 'failed') && (
                  <Button
                    className="col-start-3 row-span-2 row-start-1"
                    disabled={busy}
                    onClick={() => process([change.fileId])}
                    size="sm"
                    variant="outline"
                  >
                    {change.state === 'failed'
                      ? m.error_action_retry()
                      : m.workspace_change_process()}
                  </Button>
                )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-fg-muted">{m.workspace_file_changes_empty()}</p>
      )}
      <div className="mt-3 flex justify-between border-line border-t pt-3">
        <span>{m.workspace_pending_notes()}</span>
        <span className="tabular-nums">{pendingNotes}</span>
      </div>
    </div>
  );
}

/** Files whose processing failed. Automatic processing skips them; the owner
 * retries one through the upload dialog's Retry processing. */
function FailedFiles({
  owner,
  workspaceId,
}: {
  owner: boolean;
  workspaceId: string;
}) {
  const { data: files } = useFiles(workspaceId, { errorBoundary: false });
  const [retrying, setRetrying] = useState<SourceFile | null>(null);
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
            className="grid min-h-11 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 py-1.5 sm:flex"
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
                onClick={() => setRetrying(file)}
                size="sm"
                variant="outline"
              >
                {m.error_action_retry()}
              </Button>
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

/** The workspace settings Indexing tab: what is searchable, the file changes
 * still to process, and the automatic processing switch. */
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
        owner={workspace.isOwner}
        pendingNotes={stats.pendingNotes}
        workspaceId={workspace.id}
      />
      <FailedFiles owner={workspace.isOwner} workspaceId={workspace.id} />
      <label className="flex items-center justify-between gap-5">
        <span className="font-medium">{m.workspace_auto_process()}</span>
        <Switch
          checked={workspace.autoProcess}
          disabled={saving}
          onCheckedChange={(autoProcess) => {
            void update({ autoProcess, id: workspace.id }).catch(() => {});
          }}
        />
      </label>
    </div>
  );
}
