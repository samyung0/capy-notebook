import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { qk } from '@/api/client';
import { meQuery, useMe, useWorkspace, workspaceQuery } from '@/api/hooks';
import { showErrorToast } from '@/api/queryClient';
import { AccountState, StorageUsageLevel, type Workspace } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/Tooltip';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { handleWorkspaceRefusals } from '@/lib/errors';
import { useOnlineStatus } from '@/lib/online';

type StorageStatus = {
  kind: 'frozen-self' | 'frozen-owner' | 'full' | 'near';
  /** The viewer's own account speaks, so the dialog offers billing links. */
  payer: boolean;
  title: string;
  short: string;
  body: string;
};

/**
 * The workspace's storage status, most severe first: the viewer's own frozen
 * account, the owner's frozen account, the owner's full storage (grace counts
 * as full), then the owner nearing the limit. The owner is never named.
 */
export function useStorageStatus(
  workspace: Workspace | undefined
): StorageStatus | null {
  const { data: me } = useMe({ errorBoundary: false });
  return workspace ? storageStatus(workspace, me?.account?.state) : null;
}

export function storageStatus(
  workspace: Pick<Workspace, 'isOwner'> &
    Partial<Pick<Workspace, 'storageOwnerState' | 'storageOwnerUsage'>>,
  ownState: AccountState | undefined
): StorageStatus | null {
  const ownerState = workspace.storageOwnerState;
  const self = workspace.isOwner;
  if (
    ownState === AccountState.over_quota_frozen ||
    (self && ownerState === AccountState.over_quota_frozen)
  )
    return {
      body: m.account_banner_frozen_body(),
      kind: 'frozen-self',
      payer: true,
      short: m.account_frozen_short(),
      title: m.account_banner_frozen_title(),
    };
  if (ownerState === AccountState.over_quota_frozen)
    return {
      body: m.workspace_storage_owner_frozen_body(),
      kind: 'frozen-owner',
      payer: false,
      short: m.workspace_storage_owner_frozen_short(),
      title: m.workspace_storage_owner_frozen_title(),
    };
  if (
    ownerState === AccountState.over_quota_grace ||
    workspace.storageOwnerUsage === StorageUsageLevel.full
  )
    return self
      ? {
          body: m.workspace_storage_owner_self_body(),
          kind: 'full',
          payer: true,
          short: m.workspace_storage_owner_self_short(),
          title: m.workspace_storage_owner_self_title(),
        }
      : {
          body: m.workspace_storage_owner_full_body(),
          kind: 'full',
          payer: false,
          short: m.workspace_storage_owner_full_short(),
          title: m.workspace_storage_owner_full_title(),
        };
  if (workspace.storageOwnerUsage === StorageUsageLevel.near_limit)
    return self
      ? {
          body: m.workspace_storage_near_self_body(),
          kind: 'near',
          payer: true,
          short: m.workspace_storage_near_self_short(),
          title: m.workspace_storage_near_self_title(),
        }
      : {
          body: m.workspace_storage_owner_near_body(),
          kind: 'near',
          payer: false,
          short: m.workspace_storage_owner_near_short(),
          title: m.workspace_storage_owner_near_title(),
        };
  return null;
}

/** The storage details dialog, opened from the entry toast or the header. */
export const useStorageDialog = create<{
  open: boolean;
  setOpen: (open: boolean) => void;
}>((set) => ({ open: false, setOpen: (open) => set({ open }) }));

/** The file status slot's offline icon; renders nothing while online. */
export function OfflineStatus() {
  const online = useOnlineStatus();
  if (online) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        className="ml-1 inline-flex shrink-0 items-center rounded-sm px-1 outline-none focus-visible:ring-2 focus-visible:ring-focus"
        data-connection-status="offline"
        render={<span role="status" />}
        tabIndex={0}
      >
        <Icon className="size-4 lg:size-5" name="wifiOff" />
        <span className="sr-only">{m.connection_offline_title()}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {m.connection_offline_title()}
      </TooltipContent>
    </Tooltip>
  );
}

/** The viewer's own account is frozen (read-only): global create controls
 * outside workspaces are disabled, read from /me. */
export function useAccountFrozen(): boolean {
  const { data: me } = useMe({ errorBoundary: false });
  return me?.account?.state === AccountState.over_quota_frozen;
}

function StatusTriangle({
  onClick,
  status,
}: {
  onClick: () => void;
  status: StorageStatus;
}) {
  const near = status.kind === 'near';
  return (
    <ToolbarButton
      className={cn(
        'ml-0.5 lg:[&_svg]:size-5',
        near
          ? 'text-tint-warning-fg hover:bg-tint-warning/85 hover:text-tint-warning-fg'
          : 'text-tint-error-fg hover:bg-tint-error/85 hover:text-tint-error-fg'
      )}
      data-storage-status={status.kind}
      label={status.title}
      onClick={onClick}
    >
      <Icon name="error" />
    </ToolbarButton>
  );
}

/**
 * The workspace status triangle: amber near the limit, red when full or
 * frozen. It opens the details dialog; its tooltip is the status title.
 */
export function WorkspaceStatusButton({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const { data: workspace } = useWorkspace(workspaceId, {
    errorBoundary: false,
  });
  const status = useStorageStatus(workspace);
  const openDialog = useStorageDialog((state) => state.setOpen);
  if (!status) return null;
  return <StatusTriangle onClick={() => openDialog(true)} status={status} />;
}

/**
 * The same red triangle in the header of a page whose create controls a frozen
 * account disables; it hosts its own details dialog.
 */
export function AccountStatusButton() {
  const frozen = useAccountFrozen();
  const [open, setOpen] = useState(false);
  if (!frozen) return null;
  const status = storageStatus(
    { isOwner: true },
    AccountState.over_quota_frozen
  ) as StorageStatus;
  return (
    <>
      <StatusTriangle onClick={() => setOpen(true)} status={status} />
      <StorageDialog
        onClose={() => setOpen(false)}
        open={open}
        status={status}
      />
    </>
  );
}

function StorageDialog({
  onClose,
  open,
  status,
}: {
  onClose: () => void;
  open: boolean;
  status: StorageStatus;
}) {
  return (
    <SimpleDialog
      footer={
        status.payer ? (
          <>
            <Button asChild rounded="large" size="md" variant="ghost-hover">
              <Link to="/settings">{m.account_banner_settings()}</Link>
            </Button>
            <Button asChild rounded="large" size="md">
              <Link search={{ tab: 'subscription' }} to="/billing">
                {m.account_banner_subscription()}
              </Link>
            </Button>
          </>
        ) : (
          <Button onClick={onClose} rounded="large" size="md">
            {m.action_close()}
          </Button>
        )
      }
      onClose={onClose}
      open={open}
      title={status.title}
      width={440}
    >
      <p className="text-fg-secondary">{status.body}</p>
    </SimpleDialog>
  );
}

/**
 * A write refused inside a workspace: `refresh` re-reads the workspace and
 * account, then the refreshed status shows (`showStatus`). Refusals arriving
 * while a refresh runs share it. When the refresh fails (react-query keeps the
 * stale data) or shows no status that refuses writes, the error's own toast
 * shows instead (`showError`, the offline one when offline).
 */
export function refusalHandler(
  refresh: () => Promise<StorageStatus | null>,
  showStatus: () => void,
  showError: (error: unknown) => void
) {
  let running = false;
  return (error: unknown) => {
    if (running) return;
    running = true;
    void refresh()
      .then(
        (status) => {
          if (!status || status.kind === 'near') showError(error);
          else showStatus();
        },
        () => showError(error)
      )
      .finally(() => {
        running = false;
      });
  };
}

/**
 * Toasts going offline (and arriving offline) and the storage status once per
 * workspace visit, and hosts the storage details dialog. A write refused for a
 * frozen account or a storage limit refreshes the workspace and account, then
 * shows the status again (owner or member wording) as a fresh toast instead of
 * a generic one (see refusalHandler).
 */
export function WorkspaceHealth({ workspace }: { workspace: Workspace }) {
  const status = useStorageStatus(workspace);
  const online = useOnlineStatus();
  const { open, setOpen } = useStorageDialog();
  const shown = useRef({ id: '', kinds: new Set<string>() });
  const qc = useQueryClient();
  const [refusals, setRefusals] = useState(0);

  useEffect(
    () =>
      handleWorkspaceRefusals(
        refusalHandler(
          async () => {
            const refresh = { throwOnError: true };
            await Promise.all([
              qc.invalidateQueries(
                { queryKey: qk.workspace(workspace.id) },
                refresh
              ),
              qc.invalidateQueries({ queryKey: qk.me }, refresh),
            ]);
            const fresh = qc.getQueryData(
              workspaceQuery(workspace.id).queryKey
            );
            return fresh
              ? storageStatus(
                  fresh,
                  qc.getQueryData(meQuery().queryKey)?.account?.state
                )
              : null;
          },
          () => {
            shown.current.kinds.clear();
            setRefusals((count) => count + 1);
          },
          showErrorToast
        ),
        workspace.isOwner
      ),
    [qc, workspace.id, workspace.isOwner]
  );

  useEffect(() => {
    if (online) return;
    userToast({
      description: m.connection_offline_body(),
      id: 'workspace-offline',
      title: m.connection_offline_title(),
      variant: 'warning',
    });
  }, [online, workspace.id]);

  useEffect(() => {
    if (shown.current.id !== workspace.id)
      shown.current = { id: workspace.id, kinds: new Set() };
    if (!status || shown.current.kinds.has(status.kind)) return;
    shown.current.kinds.add(status.kind);
    userToast({
      button: { label: m.action_details(), onClick: () => setOpen(true) },
      description: status.short,
      // A refusal or a new kind re-shows the status as a new toast with its
      // full timer.
      id: `workspace-storage-${workspace.id}:${status.kind}:${refusals}`,
      title: status.title,
      variant: status.kind === 'near' ? 'warning' : 'error',
    });
  }, [workspace.id, status, setOpen, refusals]);

  useEffect(() => () => setOpen(false), [setOpen]);

  if (!status) return null;
  return (
    <StorageDialog onClose={() => setOpen(false)} open={open} status={status} />
  );
}
