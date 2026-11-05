import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { qk } from '@/api/client';
import {
  useDeleteWorkspace,
  useLeaveWorkspace,
  useMe,
  useSetWorkspaceStudyEnabled,
  useUpdateWorkspace,
  useUpdateWorkspaceSharing,
  useWorkspaceStats,
  useWorkspaceStudy,
} from '@/api/hooks';
import type { Workspace } from '@/api/types';
import { InlineErrorState } from '@/components/app/ErrorState';
import { SettingsNav, type SettingsNavTab } from '@/components/app/SettingsNav';
import { DangerZone, SettingRow } from '@/components/app/tabPanel';
import { Button } from '@/components/ui/Button';
import {
  ConfirmDialog,
  SimpleDialog,
  useIsPhone,
} from '@/components/ui/Dialog';
import { Skeleton } from '@/components/ui/feedback';
import { NumberPopIn } from '@/components/ui/NumberPopIn';
import { Switch } from '@/components/ui/Switch';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { describeError, unexpectedErrorId } from '@/lib/errors';
import { canManageWorkspaceSettings } from './access';
import { CloneWorkspaceDialog } from './CloneWorkspaceDialog';
import { IndexingTab } from './IndexingTab';
import { ShareDialog } from './ShareDialog';
import type { SettingsTab, SettingsView } from './settingsTabs';
import { WorkspaceFormEditDialog } from './WorkspaceFormEditDialog';
import { WorkspaceTransferDialog } from './WorkspaceMemberManager';

/** Workspace settings: the tabs in a column under a search, on phones a list
 * that opens each tab as its own page. `tab`, `query` and their callbacks keep
 * both in the caller's URL (the workspace page); without them the dialog keeps
 * its own. */
export function WorkspaceSettingsDialog({
  workspace,
  open,
  onClose,
  initialTab,
  tab: controlledTab,
  onTabChange,
  query,
  onQueryChange,
}: {
  initialTab?: SettingsTab;
  tab?: SettingsView;
  onTabChange?: (tab: SettingsView) => void;
  query?: string;
  onQueryChange?: (query: string) => void;
  workspace: Workspace;
  open: boolean;
  onClose: () => void;
}) {
  // Everyone with access has Study; the workspace's own tabs are for owner
  // and editor members;
  // Others shows when it holds a row. Danger holds Delete for the owner and
  // Leave for any other member (Epo 2026-10-28), never both.
  const manage = canManageWorkspaceSettings(workspace);
  const others = workspace.canClone;
  const owner = workspace.capabilities.canManageMembers;
  const member = !!workspace.role && workspace.role !== 'owner';
  const danger = owner || member;
  const allowed = (value: SettingsTab) =>
    value === 'study' ||
    (value === 'others' ? others : value === 'danger' ? danger : manage);
  const first: SettingsTab = manage ? 'general' : 'study';
  const [ownTab, setOwnTab] = useState<SettingsView>(initialTab ?? 'menu');
  const requested = controlledTab ?? ownTab;
  // While it fades out the URL has no tab: keep showing the last one.
  const lastPicked = useRef<SettingsTab | null>(null);
  if (open)
    lastPicked.current =
      requested !== 'menu' && allowed(requested) ? requested : null;
  const picked = lastPicked.current;
  const tab = picked ?? first;
  const setTab = (value: SettingsView) =>
    onTabChange ? onTabChange(value) : setOwnTab(value);
  const phone = useIsPhone();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { mutateAsync: update } = useUpdateWorkspace();
  const [cloneOpen, setCloneOpen] = useState(false);
  const { mutate: deleteWorkspace, isPending: deleting } = useDeleteWorkspace();
  const { data: me } = useMe();
  const { mutate: leaveWorkspace, isPending: leaving } = useLeaveWorkspace(
    workspace.id
  );
  // Leave before dropping the cache, or the open page refetches it; Back then
  // fetches the workspace and shows its error. Closing matters on
  // /workspaces, where the page stays.
  const leavePage = () =>
    navigate({ to: '/' }).then(() => {
      onClose();
      qc.removeQueries({ queryKey: qk.workspace(workspace.id) });
    });
  const { mutateAsync: updateSharing, isPending: sharing } =
    useUpdateWorkspaceSharing();
  const {
    data: stats,
    isPending,
    isError,
    error,
    refetch,
  } = useWorkspaceStats(open && manage ? workspace.id : '', {
    errorBoundary: false,
  });
  const statsError = isError ? (
    <InlineErrorState
      className="py-6"
      errorId={unexpectedErrorId(error)}
      message={describeError(error).title}
      onRetry={() => void refetch()}
    />
  ) : null;
  const tabs: SettingsNavTab<SettingsTab>[] = [
    ...(manage
      ? [
          {
            icon: 'settings' as const,
            label: m.workspace_general(),
            terms: [
              m.icon_label(),
              m.cover_label(),
              m.common_name(),
              m.summary_description_label(),
              m.common_tags(),
              m.workspace_kind_label(),
              m.workspace_kind_personal(),
              m.workspace_kind_class(),
            ],
            value: 'general' as const,
          },
          {
            icon: 'userAdd' as const,
            label: m.workspace_sharing(),
            terms: [
              m.share_visibility(),
              m.share_anyone_with_access(),
              m.members_people(),
              m.members_invite(),
              m.members_pending_title(),
            ],
            value: 'sharing' as const,
          },
          {
            icon: 'database' as const,
            label: m.workspace_indexing(),
            terms: [
              m.workspace_auto_process(),
              m.workspace_file_changes(),
              m.workspace_failed_files(),
            ],
            value: 'indexing' as const,
          },
          {
            icon: 'chart' as const,
            label: m.workspace_stats_title(),
            terms: [
              m.quiz_col_topics(),
              m.nav_files(),
              m.nav_quizzes(),
              m.stats_attempts(),
              m.stats_average_score(),
            ],
            value: 'statistics' as const,
          },
        ]
      : []),
    {
      icon: 'book' as const,
      label: m.workspace_tab_study(),
      terms: [m.study_hide_progress()],
      value: 'study' as const,
    },
    ...(others
      ? [
          {
            icon: 'moreHorizontal' as const,
            label: m.workspace_tab_others(),
            terms: [m.action_clone_workspace()],
            value: 'others' as const,
          },
        ]
      : []),
    ...(danger
      ? [
          {
            icon: 'alert' as const,
            label: m.workspace_tab_danger(),
            terms: owner
              ? [m.workspace_transfer_action(), m.workspace_delete_action()]
              : [m.workspace_leave_action()],
            tone: 'danger' as const,
            value: 'danger' as const,
          },
        ]
      : []),
  ];
  const content = (
    <>
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
                [m.quiz_col_topics(), stats.topics],
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
      {tab === 'study' && <StudyTab workspaceId={workspace.id} />}
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
          {owner ? (
            <>
              <SettingRow
                hint={m.workspace_transfer_hint()}
                title={m.workspace_transfer_action()}
              >
                <Button
                  onClick={() => setTransferring(true)}
                  rounded="large"
                  variant="danger-outline"
                >
                  {m.workspace_transfer_confirm()}
                </Button>
              </SettingRow>
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
            </>
          ) : (
            <SettingRow
              hint={m.workspace_leave_hint()}
              title={m.workspace_leave_action()}
            >
              <Button
                disabled={leaving || !me}
                onClick={() => setConfirmLeave(true)}
                rounded="large"
                variant="danger"
              >
                {m.action_leave()}
              </Button>
            </SettingRow>
          )}
        </DangerZone>
      )}
    </>
  );
  // A lone tab needs no list, and a phone's list is the whole page until a tab
  // is picked.
  const nav = tabs.length > 1;
  const page = phone && nav && picked;
  return (
    // A manager's tabs share one tall frame, so switching never resizes it;
    // anyone else's few rows fit their content.
    <SimpleDialog
      cardClassName={cn(manage && 'h-full')}
      cardScrollContainerClassName={cn(
        'sm:overflow-hidden',
        nav && 'sm:pl-3.5'
      )}
      className={cn('flex flex-col gap-0', manage && 'h-[88dvh]')}
      onBack={page ? () => setTab('menu') : undefined}
      onClose={onClose}
      // The dialog takes focus, not the search: a tablet's keyboard stays down.
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        (event.currentTarget as HTMLElement).focus();
      }}
      open={open}
      title={
        page
          ? tabs.find((item) => item.value === picked)?.label
          : m.workspace_settings()
      }
      width={nav ? 880 : undefined}
    >
      <div className="flex min-h-0 flex-1 flex-col sm:mt-2 sm:flex-row">
        {nav && (
          <SettingsNav
            className={cn(
              'sm:-mb-6.5 sm:w-48 sm:border-divider sm:border-r sm:pr-4 sm:pb-6.5',
              page && 'hidden'
            )}
            label={m.workspace_settings()}
            onChange={(value) => setTab(value)}
            onQueryChange={onQueryChange}
            query={query}
            tabs={tabs}
            value={picked ?? (phone ? '' : first)}
          />
        )}
        {(!phone || !nav || picked) && (
          // To the card's edges from sm: its scrollbar and the General footer's
          // padding are the dialog's own.
          <div
            className={cn(
              'min-w-0 flex-1 pt-2 sm:-mr-5.5 sm:-mb-6.5 sm:overflow-y-auto sm:pt-0.5 sm:pr-5.5 sm:pb-6.5',
              nav && 'sm:pl-4'
            )}
          >
            {content}
          </div>
        )}
      </div>
      {transferring && (
        <WorkspaceTransferDialog
          onClose={() => setTransferring(false)}
          workspaceId={workspace.id}
        />
      )}
      <ConfirmDialog
        body={m.workspace_delete_confirm_body()}
        confirmLabel={m.trash_delete_forever()}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          deleteWorkspace(workspace.id, { onSuccess: leavePage });
        }}
        open={confirmDelete}
        title={m.workspace_delete_confirm_title({ name: workspace.name })}
      />
      <ConfirmDialog
        body={m.workspace_leave_confirm_body()}
        confirmLabel={m.action_leave()}
        onClose={() => setConfirmLeave(false)}
        onConfirm={() => {
          if (me) leaveWorkspace(me.id, { onSuccess: leavePage });
        }}
        open={confirmLeave}
        title={m.workspace_leave_confirm_title({ name: workspace.name })}
      />
    </SimpleDialog>
  );
}

/** The member's own study switches for this workspace, whichever plan the
 * Study page shows. */
function StudyTab({ workspaceId }: { workspaceId: string }) {
  const { data: study } = useWorkspaceStudy(workspaceId);
  const { isPending, mutate: setShown } =
    useSetWorkspaceStudyEnabled(workspaceId);
  return (
    <div className="flex flex-col gap-6">
      <SettingRow
        hint={m.study_hide_progress_hint()}
        title={m.study_hide_progress()}
      >
        {study ? (
          <Switch
            aria-label={m.study_hide_progress()}
            checked={!study.enabled}
            disabled={isPending}
            onCheckedChange={(on) => setShown(!on)}
          />
        ) : (
          <Skeleton className="h-6 w-10 rounded-full" />
        )}
      </SettingRow>
    </div>
  );
}
