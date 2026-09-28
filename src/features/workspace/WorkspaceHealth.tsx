import { Link } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useMe } from '@/api/hooks';
import { AccountState, type Workspace } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { useOnlineStatus } from '@/lib/online';

type StorageIssue =
  | { kind: 'owner-self' }
  | { kind: 'owner-other'; name?: string }
  | { kind: 'frozen' };

/**
 * What blocks adding to this workspace. The owner pays for every byte, so the
 * owner's lifecycle state speaks for everyone; the reader's own frozen account
 * only matters when the owner is fine.
 */
export function useStorageIssue(
  workspace: Workspace | undefined
): StorageIssue | null {
  const { data: me } = useMe({ errorBoundary: false });
  const owner = workspace?.storageOwnerState;
  if (
    owner === AccountState.over_quota_grace ||
    owner === AccountState.over_quota_frozen
  )
    return workspace?.isOwner
      ? { kind: 'owner-self' }
      : { kind: 'owner-other', name: workspace?.storageOwnerName };
  if (me?.account?.state === AccountState.over_quota_frozen)
    return { kind: 'frozen' };
  return null;
}

function issueCopy(issue: StorageIssue) {
  if (issue.kind === 'frozen')
    return {
      body: m.account_banner_frozen_body(),
      short: m.account_frozen_short(),
      title: m.account_banner_frozen_title(),
    };
  if (issue.kind === 'owner-self')
    return {
      body: m.workspace_storage_owner_self_body(),
      short: m.workspace_storage_owner_self_short(),
      title: m.workspace_storage_owner_self_title(),
    };
  const { name } = issue;
  return name
    ? {
        body: m.workspace_storage_owner_other_body({ name }),
        short: m.workspace_storage_owner_other_short({ name }),
        title: m.workspace_storage_owner_other_title({ name }),
      }
    : {
        body: m.workspace_storage_owner_unnamed_body(),
        short: m.workspace_storage_owner_unnamed_short(),
        title: m.workspace_storage_owner_unnamed_title(),
      };
}

/** The storage details dialog, opened from the entry toast or the header. */
export const useStorageDialog = create<{
  open: boolean;
  setOpen: (open: boolean) => void;
}>((set) => ({ open: false, setOpen: (open) => set({ open }) }));

/** Header status: storage trouble wins over being offline. */
export function useWorkspaceStatus(
  workspace: Workspace | undefined
): 'storage' | 'offline' | null {
  const issue = useStorageIssue(workspace);
  const online = useOnlineStatus();
  if (issue) return 'storage';
  return online ? null : 'offline';
}

/**
 * Toasts going offline (and arriving offline) and each storage problem once
 * per workspace visit, and hosts the storage details dialog.
 */
export function WorkspaceHealth({ workspace }: { workspace: Workspace }) {
  const issue = useStorageIssue(workspace);
  const online = useOnlineStatus();
  const { open, setOpen } = useStorageDialog();
  const shown = useRef({ id: '', kinds: new Set<string>() });

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
    if (!issue || shown.current.kinds.has(issue.kind)) return;
    shown.current.kinds.add(issue.kind);
    const copy = issueCopy(issue);
    userToast({
      button: { label: m.action_details(), onClick: () => setOpen(true) },
      description: copy.short,
      id: `workspace-storage-${workspace.id}`,
      title: copy.title,
      variant: issue.kind === 'frozen' ? 'error' : 'warning',
    });
  }, [workspace.id, issue, setOpen]);

  useEffect(() => () => setOpen(false), [setOpen]);

  if (!issue) return null;
  const copy = issueCopy(issue);
  const payer = issue.kind !== 'owner-other';
  return (
    <SimpleDialog
      footer={
        payer ? (
          <>
            <Button
              asChild
              className="rounded-input"
              size="md"
              variant="ghost-hover"
            >
              <Link to="/settings">{m.account_banner_settings()}</Link>
            </Button>
            <Button asChild className="rounded-input" size="md">
              <Link search={{ tab: 'subscription' }} to="/settings">
                {m.account_banner_subscription()}
              </Link>
            </Button>
          </>
        ) : (
          <Button
            className="rounded-input"
            onClick={() => setOpen(false)}
            size="md"
          >
            {m.action_close()}
          </Button>
        )
      }
      onClose={() => setOpen(false)}
      open={open}
      title={copy.title}
      width={440}
    >
      <p className="text-fg-secondary">{copy.body}</p>
    </SimpleDialog>
  );
}
