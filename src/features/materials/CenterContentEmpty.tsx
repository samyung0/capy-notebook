import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useWorkspaceRecent } from '@/api/hooks';
import { ThumbnailPanel } from '@/components/app/ThumbnailPanel';
import { Button } from '@/components/ui/Button';
import { FileIcon } from '@/components/ui/FileIcon';
import { Icon } from '@/components/ui/Icon';
import {
  recentIcon,
  recentThumbnail,
} from '@/features/dashboard/RecentItemsCard';
import {
  mergeRecentItems,
  type RecentItem,
} from '@/features/dashboard/recentItems';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** The empty center pane's body (CenterContent's EmptyCenter): the
 * workspace's recent items and shortcuts, or the plain prompt without a
 * workspace. Loaded when no item is open, so a file's page never loads the
 * recent items' cards. */
export function EmptyCenterBody({
  onAddFile,
  onOpenSettings,
  workspaceId,
}: {
  onAddFile?: () => void;
  onOpenSettings?: () => void;
  workspaceId: string;
}) {
  return workspaceId ? (
    <RecentInWorkspace
      actions={<QuickActions onOpenSettings={onOpenSettings} />}
      onAddFile={onAddFile}
      workspaceId={workspaceId}
    />
  ) : (
    <PickAFile />
  );
}

function PickAFile({ actions }: { actions?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <Icon className="non-scaling-svg size-8" name="files" />
      <p>{m.material_select()}</p>
      {actions && <div className="mt-6">{actions}</div>}
    </div>
  );
}

/** Workspace shortcuts under the recent files: as tall as a file tree row,
 * muted until hovered. */
function QuickActions({ onOpenSettings }: { onOpenSettings?: () => void }) {
  return (
    <div className="flex flex-col items-start">
      {onOpenSettings && (
        <Button
          className="h-8 px-3 text-xs"
          iconLeft="settings"
          onClick={onOpenSettings}
          size="sm"
          variant="ghost-muted"
        >
          {m.workspace_settings()}
        </Button>
      )}
      {/* TODO: open the study progress page once it exists. */}
      <Button
        className="h-8 px-3 text-xs"
        iconLeft="knowledge"
        size="sm"
        variant="ghost-muted"
      >
        {m.workspace_study_progress()}
      </Button>
    </div>
  );
}

/** The workspace's four newest files and materials as cards for a quick
 * open. Blank while loading; an empty workspace gets a dashed add file card
 * instead, or the plain prompt when the viewer cannot add. */
function RecentInWorkspace({
  actions,
  onAddFile,
  workspaceId,
}: {
  actions: ReactNode;
  onAddFile?: () => void;
  workspaceId: string;
}) {
  const { data, isLoading } = useWorkspaceRecent(workspaceId);
  if (isLoading) return null;
  const items = mergeRecentItems(
    data?.files ?? [],
    data?.materials ?? [],
    [],
    4
  );
  if (!items.length && !onAddFile) return <PickAFile actions={actions} />;
  const single = items.length <= 1;
  return (
    // Lifted by half the subtitle row so the grid, not the block, sits centred.
    <div className="flex w-full max-w-[400px] -translate-y-4 flex-col gap-2.5">
      <h3 className="t-subtitle px-1">{m.dashboard_recent()}</h3>
      <div
        className={cn(
          'grid gap-1',
          // A lone card keeps its two-column width, centred.
          single ? 'grid-cols-[calc(50%-2px)] justify-center' : 'grid-cols-2'
        )}
      >
        {items.map((item) => (
          <QuickOpenCard
            item={item}
            key={`${item.kind}-${item.id}`}
            workspaceId={workspaceId}
          />
        ))}
        {!items.length && onAddFile && <AddFileCard onClick={onAddFile} />}
      </div>
      <div className="mt-6">{actions}</div>
    </div>
  );
}

/** The empty workspace's only card: a dashed tile the size of a preview,
 * as the dashed new workspace card on Workspaces. */
function AddFileCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="cursor-pointer rounded-[15px] p-1 outline-none focus-visible:ring-2 focus-visible:ring-action"
      onClick={onClick}
      type="button"
    >
      <span className="flex aspect-[16/10] flex-col items-center justify-center gap-2 rounded-[13px] text-fg-muted transition-colors hover:bg-surface-hover-bg">
        <Icon name="plus" size={20} />
        <span className="t-meta">{m.action_add_file()}</span>
      </span>
    </button>
  );
}

/** A borderless card: the preview, then the kind icon and title. No hint
 * line or pill, so the grid stays quiet beside the empty viewer. */
function QuickOpenCard({
  item,
  workspaceId,
}: {
  item: RecentItem;
  workspaceId: string;
}) {
  const icon = recentIcon(item);
  return (
    <Link
      className="flex min-w-0 flex-col gap-1.5 rounded-[15px] p-1 outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action"
      params={{ workspaceId }}
      preload="intent"
      search={
        item.kind === 'material' ? { material: item.id } : { file: item.id }
      }
      to="/workspaces/$workspaceId"
    >
      <ThumbnailPanel
        dense
        icon={icon}
        {...recentThumbnail(item)}
        pill={undefined}
      />
      <span className="flex min-w-0 items-center gap-1.5 px-1 pb-0.5">
        <FileIcon className="size-3.5 shrink-0" name={icon} />
        <span className="truncate text-[13px] leading-tight">{item.title}</span>
      </span>
    </Link>
  );
}
