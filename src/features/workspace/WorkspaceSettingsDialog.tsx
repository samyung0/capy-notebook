import { useState } from 'react';
import {
  useUpdateWorkspace,
  useUpdateWorkspaceSharing,
  useWorkspaceStats,
} from '@/api/hooks';
import type { Workspace } from '@/api/types';
import { SimpleDialog } from '@/components/ui/Dialog';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Switch } from '@/components/ui/Switch';
import { Tabs } from '@/components/ui/Tabs';
import { m } from '@/i18n';
import { ShareDialog } from './ShareDialog';
import { WorkspaceFormEditDialog } from './WorkspaceFormEditDialog';

// Largest remainders keep the displayed disjoint shares at exactly 100%.
export function sourcePercentages(counts: readonly number[]): number[] {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (!total) return counts.map(() => 0);
  const exact = counts.map((count) => (count * 100) / total);
  const result = exact.map(Math.floor);
  const order = exact
    .map((value, index) => ({ fraction: value - result[index], index }))
    .sort((a, b) => b.fraction - a.fraction);
  const remainder = 100 - result.reduce((sum, value) => sum + value, 0);
  for (let i = 0; i < remainder; i++) result[order[i].index]++;
  return result;
}

export function WorkspaceSettingsDialog({
  workspace,
  open,
  onClose,
}: {
  workspace: Workspace;
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState('general');
  const { mutateAsync: update, isPending: saving } = useUpdateWorkspace();
  const { mutateAsync: updateSharing, isPending: sharing } =
    useUpdateWorkspaceSharing();
  const {
    data: stats,
    isPending,
    isError,
    refetch,
  } = useWorkspaceStats(open ? workspace.id : '', { errorBoundary: false });
  const counts = stats
    ? [stats.indexed, stats.notIndexed, stats.notIndexable]
    : [];
  const percentages = sourcePercentages(counts);
  const labels = [
    m.workspace_indexed(),
    m.workspace_not_indexed(),
    m.workspace_not_indexable(),
  ];
  const tones = ['green', 'amber', 'graphite'] as const;
  return (
    <SimpleDialog onClose={onClose} open={open} title={m.workspace_settings()}>
      <Tabs
        className="mt-4"
        onChange={setTab}
        tabs={[
          { label: m.workspace_general(), value: 'general' },
          { label: m.workspace_sharing(), value: 'sharing' },
          { label: m.workspace_indexing(), value: 'indexing' },
        ]}
        value={tab}
      />
      <div className="min-h-[360px] py-5">
        {tab === 'general' && (
          <WorkspaceFormEditDialog
            embedded
            onSubmit={(values) => update({ ...values, id: workspace.id })}
            open={open}
            setOpen={onClose}
            workspace={workspace}
          />
        )}
        {tab === 'sharing' && (
          <ShareDialog
            embedded
            link={`/w/${workspace.id}`}
            onClose={onClose}
            onPrivacyChange={(privacy) =>
              updateSharing({ id: workspace.id, privacy })
            }
            onShareRoleChange={(shareRole) =>
              updateSharing({ id: workspace.id, shareRole })
            }
            open={open}
            privacy={workspace.privacy}
            saving={sharing}
            shareRole={workspace.shareRole}
            workspaceId={workspace.id}
          />
        )}
        {tab === 'indexing' && (
          <div className="flex flex-col gap-6">
            {isError ? (
              <button onClick={() => void refetch()} type="button">
                {m.action_retry()}
              </button>
            ) : isPending ? (
              <p>{m.common_loading()}</p>
            ) : (
              stats && (
                <>
                  {counts.some(Boolean) ? (
                    <>
                      <ProgressBar
                        height={10}
                        segments={counts.map((_, index) => ({
                          label: labels[index],
                          tone: tones[index],
                          value: percentages[index],
                        }))}
                      />
                      <div className="grid grid-cols-3 gap-4">
                        {counts.map((count, index) => (
                          <div
                            className="flex flex-col gap-1"
                            key={labels[index]}
                          >
                            <span className="t-meta text-fg-muted">
                              {labels[index]}
                            </span>
                            <span className="text-xl tabular-nums">
                              {count}
                            </span>
                            <span className="t-meta text-fg-muted">
                              {percentages[index]}%
                            </span>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p className="text-fg-muted">{m.workspace_no_sources()}</p>
                  )}
                  <div className="flex flex-col gap-3 border-line border-y py-4">
                    <div className="flex justify-between">
                      <span>{m.workspace_pending_reparse()}</span>
                      <span className="tabular-nums">
                        {stats.pendingReparse}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>{m.workspace_pending_reindex()}</span>
                      <span className="tabular-nums">
                        {stats.pendingReindex}
                      </span>
                    </div>
                  </div>
                </>
              )
            )}
            <label className="flex items-center justify-between gap-5">
              <span>
                <span className="block font-medium">
                  {m.workspace_auto_reparse()}
                </span>
                <span className="t-meta text-fg-muted">
                  {m.workspace_auto_reparse_hint()}
                </span>
              </span>
              <Switch
                checked={workspace.autoReparse}
                disabled={saving}
                onCheckedChange={(autoReparse) => {
                  void update({ autoReparse, id: workspace.id }).catch(
                    () => {}
                  );
                }}
              />
            </label>
            <label className="flex items-center justify-between gap-5">
              <span>
                <span className="block font-medium">
                  {m.workspace_auto_reindex()}
                </span>
                <span className="t-meta text-fg-muted">
                  {m.workspace_auto_reindex_hint()}
                </span>
              </span>
              <Switch
                checked={workspace.autoReindex}
                disabled={saving}
                onCheckedChange={(autoReindex) => {
                  void update({ autoReindex, id: workspace.id }).catch(
                    () => {}
                  );
                }}
              />
            </label>
          </div>
        )}
      </div>
    </SimpleDialog>
  );
}
