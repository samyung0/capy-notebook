import type { ReactNode } from 'react';
import { useUpdateWorkspace } from '@/api/hooks';
import type { FileChange, Workspace, WorkspaceStats } from '@/api/types';
import {
  type Segment,
  UsageBar,
  UsageHead,
  UsageLegend,
} from '@/components/app/UsageMeter';
import { Button } from '@/components/ui/Button';
import { FileIcon } from '@/components/ui/FileIcon';
import { Spinner } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Switch } from '@/components/ui/Switch';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { m } from '@/i18n';
import { fileIconName } from '@/lib/fileIcons';
import { userColorPair } from '@/lib/userColor';
import {
  useCancelFileChanges,
  useProcessFileChanges,
} from './useProcessFileChanges';

// Work in flight first, then what needs the owner.
const STATE_ORDER: Record<FileChange['state'], number> = {
  failed: 2,
  processing: 0,
  queued: 1,
  waiting: 3,
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
              className="flex min-h-11 items-center gap-3 py-1.5"
              data-state={change.state}
              key={change.fileId}
            >
              <FileIcon className="size-3.75" name={fileIconName(change)} />
              <span className="min-w-0 flex-1 truncate">{change.name}</span>
              <span className="t-meta flex shrink-0 items-center gap-1.5 text-fg-muted">
                <ChangeStatus change={change} />
              </span>
              {owner && change.state === 'queued' && (
                <Button
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
                    disabled={busy}
                    onClick={() => process([change.fileId])}
                    size="sm"
                    variant="outline"
                  >
                    {change.state === 'failed'
                      ? m.workspace_change_retry()
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

/** The workspace settings Indexing tab: what is searchable, the file changes
 * still to process, and the automatic processing switch. */
export function IndexingTab({
  fallback,
  stats,
  workspace,
}: {
  /** Shown instead of the stats while they load or failed to. */
  fallback: ReactNode;
  stats: WorkspaceStats | undefined;
  workspace: Workspace;
}) {
  const { mutateAsync: update, isPending: saving } = useUpdateWorkspace();
  const total = stats
    ? stats.indexed + stats.notIndexed + stats.notIndexable
    : 0;
  const sources: (Segment & { value: string })[] = stats
    ? [
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
      }))
    : [];
  return (
    <div className="flex flex-col gap-10">
      {stats ? (
        <>
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
        </>
      ) : (
        fallback
      )}
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
