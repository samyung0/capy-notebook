import { useState } from 'react';
import {
  useUpdateWorkspace,
  useUpdateWorkspaceSharing,
  useWorkspaceStats,
} from '@/api/hooks';
import type { Workspace } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { NumberPopIn } from '@/components/ui/NumberPopIn';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Switch } from '@/components/ui/Switch';
import { Tabs } from '@/components/ui/Tabs';
import { m } from '@/i18n';
import { ShareDialog } from './ShareDialog';
import { sourcePercentages } from './sourcePercentages';
import { WorkspaceFormEditDialog } from './WorkspaceFormEditDialog';

export function WorkspaceSettingsDialog({
  workspace,
  open,
  onClose,
  initialTab = 'general',
}: {
  initialTab?: 'general' | 'sharing' | 'indexing' | 'statistics';
  workspace: Workspace;
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<string>(initialTab);
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
    <SimpleDialog
      cardClassName="h-full"
      className="flex h-[88dvh] flex-col gap-0"
      onClose={onClose}
      open={open}
      title={m.workspace_settings()}
    >
      <Tabs
        className="mt-2.5 whitespace-nowrap"
        onChange={setTab}
        tabs={[
          { label: m.workspace_general(), value: 'general' },
          { label: m.workspace_sharing(), value: 'sharing' },
          { label: m.workspace_indexing(), value: 'indexing' },
          { label: m.workspace_stats_title(), value: 'statistics' },
        ]}
        value={tab}
      />
      <div className="h-full flex-1 px-1 py-5">
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
            canManageMembers={workspace.capabilities.canManageMembers}
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
        {tab === 'statistics' &&
          (isError ? (
            <Button onClick={() => void refetch()} variant="ghost">
              {m.action_retry()}
            </Button>
          ) : isPending ? (
            <p role="status">{m.common_loading()}</p>
          ) : (
            stats && (
              <div className="grid grid-cols-2 gap-3">
                {[
                  [m.quiz_col_chapters(), stats.chapters],
                  [m.nav_files(), stats.files],
                  [m.nav_quizzes(), stats.quizzes],
                  [m.stats_attempts(), stats.attempts],
                  [m.stats_average_score(), `${stats.avgScore}%`],
                ].map(([label, value]) => (
                  <div
                    className="rounded-card border border-line bg-surface-hover-bg px-4 py-3"
                    key={label}
                  >
                    <p className="t-label text-fg-muted">{label}</p>
                    <p className="t-large-card-title mt-1">
                      <NumberPopIn value={String(value)} />
                    </p>
                  </div>
                ))}
              </div>
            )
          ))}
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
