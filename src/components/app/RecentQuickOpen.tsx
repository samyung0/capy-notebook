import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Dialog as DialogPrimitive } from 'radix-ui';
import {
  openedFilesQuery,
  openedMaterialsQuery,
  useWorkspaces,
} from '@/api/hooks';
import { InlineErrorState } from '@/components/app/ErrorState';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { ThumbnailPanel } from '@/components/app/ThumbnailPanel';
import { BASE_BUTTON_STYLE } from '@/components/ui/Button';
import { Dialog, DialogContent } from '@/components/ui/Dialog';
import { SkeletonList } from '@/components/ui/feedback';
import {
  recentIcon,
  recentLink,
  recentThumbnail,
} from '@/features/dashboard/RecentItemsCard';
import { orderByOpens } from '@/features/dashboard/recentItems';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { unexpectedErrorId } from '@/lib/errors';
import { iconUrl } from '@/lib/icon-catalog';
import { waitsForConnection } from '@/lib/online';
import { readRecentOpens } from '@/lib/recentOpens';

const QUICK_OPEN_LIMIT = 5;

/** The files and materials this browser opened last that the caller can
 * still open, newest open first, merged once all three lists have loaded.
 * The rows come from the cache first and refetch in the background. */
function useOpenedItems() {
  const meta = { errorBoundary: false as const };
  const {
    data: files,
    error: filesError,
    fetchStatus: filesFetchStatus,
    isError: filesFailed,
    isLoading: filesLoading,
    refetch: refetchFiles,
  } = useQuery({ ...openedFilesQuery(), meta });
  const {
    data: materials,
    error: materialsError,
    fetchStatus: materialsFetchStatus,
    isError: materialsFailed,
    isLoading: materialsLoading,
    refetch: refetchMaterials,
  } = useQuery({ ...openedMaterialsQuery(), meta });
  const {
    data: workspaces,
    error: workspacesError,
    fetchStatus: workspacesFetchStatus,
    isError: workspacesFailed,
    isLoading: workspacesLoading,
    refetch: refetchWorkspaces,
  } = useWorkspaces({ sort: 'accessed' }, { errorBoundary: false });
  const items = orderByOpens(
    files ?? [],
    materials ?? [],
    workspaces ?? [],
    readRecentOpens()
  );
  const paused =
    waitsForConnection(filesFetchStatus, files) ||
    waitsForConnection(materialsFetchStatus, materials) ||
    waitsForConnection(workspacesFetchStatus, workspaces);
  const isLoading = filesLoading || materialsLoading || workspacesLoading;
  // A failed refresh keeps the cached list, so only a missing one counts.
  const missing = (
    [
      [files, filesFailed, refetchFiles, filesError],
      [materials, materialsFailed, refetchMaterials, materialsError],
      [workspaces, workspacesFailed, refetchWorkspaces, workspacesError],
    ] as const
  ).filter(([data, isError]) => !data && isError);
  return { isLoading, items, missing, paused, workspaces };
}

/** The phone's quick open: the five files this browser opened last. Links
 * carry no mode, so each opens in the mode last used on it in this browser
 * (`readDocumentMode`). */
export function RecentQuickOpen({ onClose }: { onClose: () => void }) {
  const { isLoading, items, missing, paused, workspaces } = useOpenedItems();
  return (
    // A centred card on phones too, closed by tapping outside it.
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="max-w-md" compact showCloseButton={false}>
        <DialogPrimitive.Title className="t-large-card-title pb-3">
          {m.quick_open_title()}
        </DialogPrimitive.Title>
        {paused ? (
          <QueryPausedState />
        ) : isLoading ? (
          <SkeletonList count={QUICK_OPEN_LIMIT} rowHeight={52} />
        ) : missing.length ? (
          <InlineErrorState
            className="py-6"
            errorId={
              missing
                .map(([, , , error]) => unexpectedErrorId(error))
                .find(Boolean) ?? null
            }
            message={m.dashboard_recent_error()}
            onRetry={() => {
              for (const [, , refetch] of missing) void refetch();
            }}
          />
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-fg-muted">
            {m.quick_open_empty()}
          </p>
        ) : (
          <div className="-mx-1.5 flex flex-col gap-1">
            {items.slice(0, QUICK_OPEN_LIMIT).map((item) => {
              const workspace = workspaces?.find(
                (ws) => ws.id === item.workspaceId
              );
              return (
                <Link
                  className={cn(
                    BASE_BUTTON_STYLE,
                    'flex items-center gap-3 px-1.5 py-1.5 text-left hover:bg-surface-hover-bg'
                  )}
                  key={`${item.kind}-${item.id}`}
                  // Same path (another file in the open workspace) keeps the
                  // dialog, which only closes itself on a path change.
                  onClick={onClose}
                  {...recentLink(item)}
                >
                  <ThumbnailPanel
                    icon={recentIcon(item)}
                    small
                    {...recentThumbnail(item)}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-1 leading-tight">
                    <span className="truncate font-semibold text-fg">
                      {item.title}
                    </span>
                    {workspace && (
                      <span className="flex min-w-0 items-center gap-1.5 text-fg-muted text-sm">
                        <img
                          alt=""
                          className="size-4.5 shrink-0 -translate-y-px rounded-[4px]"
                          height={18}
                          src={iconUrl(workspace.iconId)}
                          width={18}
                        />
                        <span className="min-w-0 truncate">
                          {workspace.name}
                        </span>
                      </span>
                    )}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
