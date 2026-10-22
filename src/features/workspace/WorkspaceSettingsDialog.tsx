import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { qk } from '@/api/client';
import {
  useDeleteWorkspace,
  useUpdateWorkspace,
  useUpdateWorkspaceSharing,
  useWorkspaceStats,
} from '@/api/hooks';
import type { Workspace } from '@/api/types';
import { InlineErrorState } from '@/components/app/ErrorState';
import { DangerZone, SettingRow } from '@/components/app/tabPanel';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, SimpleDialog } from '@/components/ui/Dialog';
import { Skeleton } from '@/components/ui/feedback';
import { NumberPopIn } from '@/components/ui/NumberPopIn';
import { Tabs } from '@/components/ui/Tabs';
import { m } from '@/i18n';
import { describeError, unexpectedErrorId } from '@/lib/errors';
import { CloneWorkspaceDialog } from './CloneWorkspaceDialog';
import { IndexingTab } from './IndexingTab';
import { ShareDialog } from './ShareDialog';
import type { SettingsTab } from './settingsTabs';
import { WorkspaceFormEditDialog } from './WorkspaceFormEditDialog';

/** Workspace settings. `tab` and `onTabChange` keep the tab in the caller's
 * URL (the workspace page); without them the dialog keeps its own. */
export function WorkspaceSettingsDialog({
  workspace,
  open,
  onClose,
  initialTab = 'general',
  tab: controlledTab,
  onTabChange,
}: {
  initialTab?: SettingsTab;
  tab?: SettingsTab;
  onTabChange?: (tab: SettingsTab) => void;
  workspace: Workspace;
  open: boolean;
  onClose: () => void;
}) {
  // Only managers open settings; Others and Danger show when they hold a row.
  const others = workspace.canClone;
  const danger = workspace.capabilities.canManageMembers;
  const allowed = (value: SettingsTab) =>
    (value !== 'others' || others) && (value !== 'danger' || danger);
  const [ownTab, setOwnTab] = useState<SettingsTab>(
    allowed(initialTab) ? initialTab : 'general'
  );
  const requested = controlledTab ?? ownTab;
  // While it fades out the URL has no tab: keep showing the last one.
  const lastTab = useRef<SettingsTab>('general');
  if (open) lastTab.current = allowed(requested) ? requested : 'general';
  const tab = lastTab.current;
  const setTab = (value: SettingsTab) =>
    onTabChange ? onTabChange(value) : setOwnTab(value);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { mutateAsync: update } = useUpdateWorkspace();
  const [cloneOpen, setCloneOpen] = useState(false);
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
    <InlineErrorState
      className="py-6"
      errorId={unexpectedErrorId(error)}
      message={describeError(error).title}
      onRetry={() => void refetch()}
    />
  ) : null;
  return (
    <SimpleDialog
      cardClassName="h-full"
      className="flex h-[88dvh] flex-col gap-0"
      onClose={onClose}
      open={open}
      title={m.workspace_settings()}
    >
      <Tabs
        className="dialog-tabs-bleed w-auto whitespace-nowrap sm:mt-2.5"
        onChange={(value) => setTab(value as SettingsTab)}
        tabs={[
          { label: m.workspace_general(), value: 'general' },
          { label: m.workspace_sharing(), value: 'sharing' },
          { label: m.workspace_indexing(), value: 'indexing' },
          { label: m.workspace_stats_title(), value: 'statistics' },
          ...(others
            ? [{ label: m.workspace_tab_others(), value: 'others' }]
            : []),
          ...(danger
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
      {/* No bottom padding: the dialog's own sits under the General footer. */}
      <div className="mt-1 flex-1 pt-5">
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
            link={workspace.sharePath}
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
            <div
              aria-label={m.a11y_loading()}
              className="grid grid-cols-2 gap-3"
              role="status"
            >
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton className="h-[73px] rounded-card" key={i} />
              ))}
            </div>
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
          <IndexingTab error={statsError} stats={stats} workspace={workspace} />
        )}
        {tab === 'others' && (
          <div className="flex flex-col gap-6">
            <SettingRow
              hint={m.workspace_clone_hint()}
              title={m.action_clone_workspace()}
            >
              <Button
                iconLeft="clone"
                onClick={() => setCloneOpen(true)}
                rounded="large"
                variant="outline"
              >
                {m.action_clone()}
              </Button>
            </SettingRow>
            <CloneWorkspaceDialog
              open={cloneOpen}
              setOpen={setCloneOpen}
              workspace={workspace}
            />
          </div>
        )}
        {tab === 'danger' && (
          <DangerZone>
            <SettingRow
              hint={m.workspace_delete_hint()}
              title={m.workspace_delete_action()}
            >
              <Button
                disabled={deleting}
                iconLeft="trash"
                onClick={() => setConfirmDelete(true)}
                rounded="large"
                variant="danger"
              >
                {m.action_delete()}
              </Button>
            </SettingRow>
          </DangerZone>
        )}
      </div>
      <ConfirmDialog
        body={m.workspace_delete_confirm_body()}
        confirmLabel={m.trash_delete_forever()}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          deleteWorkspace(workspace.id, {
            // Leave before dropping the cache, or the open page refetches
            // it; Back then fetches the deleted workspace and shows its error.
            // Closing matters on /workspaces, where the page stays.
            onSuccess: () =>
              navigate({ to: '/workspaces' }).then(() => {
                onClose();
                qc.removeQueries({ queryKey: qk.workspace(workspace.id) });
              }),
          });
        }}
        open={confirmDelete}
        title={m.workspace_delete_confirm_title({ name: workspace.name })}
      />
    </SimpleDialog>
  );
}
