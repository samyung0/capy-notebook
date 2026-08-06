import { Link } from '@tanstack/react-router';
import { AccountState, type Workspace } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** Whether the owner's lifecycle state blocks growth in their workspaces. */
function isOverQuota(state: Workspace['storageOwnerState']): boolean {
  return (
    state === AccountState.over_quota_grace ||
    state === AccountState.over_quota_frozen
  );
}

/**
 * Warns that the account paying for this workspace's bytes is out of storage.
 *
 * The subject is always the workspace owner, never the reader: every byte a
 * member adds is charged to the owner, so a healthy member still cannot upload
 * or generate here. Without naming the owner, an editor sees uploads fail for
 * no visible reason while their own account looks fine.
 */
export function StorageOwnerBanner({
  workspace,
}: {
  workspace: Workspace | undefined;
}) {
  if (!workspace || !isOverQuota(workspace.storageOwnerState)) return null;

  const owner = workspace.storageOwnerName;
  const title = workspace.isOwner
    ? m.workspace_storage_owner_self_title()
    : owner
      ? m.workspace_storage_owner_other_title({ name: owner })
      : m.workspace_storage_owner_unnamed_title();
  const body = workspace.isOwner
    ? m.workspace_storage_owner_self_body()
    : owner
      ? m.workspace_storage_owner_other_body({ name: owner })
      : m.workspace_storage_owner_unnamed_body();

  return (
    <div
      className={cn(
        'flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3',
        'border-solid-warning/40 bg-tint-warning text-tint-warning-fg'
      )}
      role="status"
    >
      <div className="min-w-0 flex-1">
        <p className="t-subtitle font-bold">{title}</p>
        <p className="mt-1 text-sm opacity-90">{body}</p>
      </div>
      {workspace.isOwner && (
        <Button asChild size="sm" variant="outline">
          <Link to="/subscription">{m.account_banner_subscription()}</Link>
        </Button>
      )}
    </div>
  );
}
