import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import {
  useCloneWorkspace,
  useDeleteWorkspace,
  useUpdateWorkspace,
  useUpdateWorkspaceSharing,
  useWorkspaceStats,
} from '@/api/hooks';
import type { Workspace } from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { Button, ErrorAction } from '@/components/ui/Button';
import { ConfirmDialog, SimpleDialog } from '@/components/ui/Dialog';
import { InputTitle } from '@/components/ui/Input';
import { NumberPopIn } from '@/components/ui/NumberPopIn';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Switch } from '@/components/ui/Switch';
import { Tabs } from '@/components/ui/Tabs';
import { m } from '@/i18n';
import { toastCloneError } from '@/lib/authToasts';
import { describeError } from '@/lib/errors';
import { trackItemCloned } from '@/lib/observability';
import { ShareDialog } from './ShareDialog';
import { sourcePercentages } from './sourcePercentages';
import { WorkspaceFormEditDialog } from './WorkspaceFormEditDialog';

/** Title, hint, action. The same shape the Sharing tab's rows use. */
function SettingRow({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex flex-col gap-1">
        <InputTitle>{title}</InputTitle>
        <p className="t-meta text-fg-muted">{hint}</p>
      </div>
      {children}
    </div>
  );
}

export function WorkspaceSettingsDialog({
  workspace,
  open,
  onClose,
  initialTab = 'general',
}: {
  initialTab?:
    | 'general'
    | 'sharing'
    | 'indexing'
    | 'statistics'
    | 'others'
    | 'danger';
  workspace: Workspace;
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<string>(initialTab);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const navigate = useNavigate();
  const { mutateAsync: update, isPending: saving } = useUpdateWorkspace();
  const { mutate: cloneWorkspace, isPending: cloning } = useCloneWorkspace({
    errorToast: false,
  });
  const { mutate: deleteWorkspace, isPending: deleting } = useDeleteWorkspace();
  const { mutateAsync: updateSharing, isPending: sharing } =
    useUpdateWorkspaceSharing();
  const {
    data: stats,
    isPending,
    isError,
    error,
    refetch,
  } = useWorkspaceStats(open ? workspace.id : '', { errorBoundary: false });
  const statsError = isError ? (
    <ErrorState
      {...describeError(error)}
      action={
        <ErrorAction iconLeftClassName="me-1" onClick={() => void refetch()}>
          {m.error_action_retry()}
        </ErrorAction>
      }
      variant="panel"
    />
  ) : null;
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
          ...(workspace.canClone
            ? [{ label: m.workspace_tab_others(), value: 'others' }]
            : []),
          ...(workspace.capabilities.canManageMembers
            ? [
                {
                  label: m.workspace_tab_danger(),
                  tone: 'danger' as const,
                  value: 'danger',
                },
              ]
            : []),
        ]}
        value={tab}
      />
      <div className="mt-1 h-full flex-1 px-3 py-5">
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
            containerClassName="-mt-3"
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
            statsError
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
              statsError
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
                    <div className="flex justify-between">
                      <span>{m.workspace_pending_notes()}</span>
                      <span className="tabular-nums">{stats.pendingNotes}</span>
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
        {tab === 'others' && workspace.canClone && (
          <div className="flex flex-col gap-6">
            <SettingRow
              hint={m.workspace_clone_hint()}
              title={m.action_clone_workspace()}
            >
              <Button
                className="rounded-input"
                disabled={cloning}
                iconLeft="clone"
                onClick={() =>
                  cloneWorkspace(workspace.id, {
                    onError: (err) => toastCloneError(err, 'workspace'),
                    onSuccess: ({ workspace: cloned }) => {
                      trackItemCloned('workspace');
                      onClose();
                      navigate({
                        params: { workspaceId: cloned.id },
                        to: '/workspaces/$workspaceId',
                      });
                    },
                  })
                }
                variant="outline"
              >
                {cloning ? m.action_cloning() : m.action_clone()}
              </Button>
            </SettingRow>
          </div>
        )}
        {tab === 'danger' && workspace.capabilities.canManageMembers && (
          /* Keeps its own padding: the error border is the grouping. */
          <div className="rounded-card border border-solid-error/40 p-4">
            <SettingRow
              hint={m.workspace_delete_hint()}
              title={m.workspace_delete_action()}
            >
              <Button
                className="h-fit rounded-input py-2.5"
                disabled={deleting}
                iconLeft="trash"
                onClick={() => setConfirmDelete(true)}
                variant="danger"
              >
                {m.action_delete()}
              </Button>
            </SettingRow>
          </div>
        )}
      </div>
      <ConfirmDialog
        body={m.workspace_delete_confirm_body()}
        confirmLabel={m.trash_delete_forever()}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          deleteWorkspace(workspace.id, {
            onSuccess: () => {
              onClose();
              navigate({ to: '/workspaces' });
            },
          });
        }}
        open={confirmDelete}
        title={m.workspace_delete_confirm_title({ name: workspace.name })}
      />
    </SimpleDialog>
  );
}
