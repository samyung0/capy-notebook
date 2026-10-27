import { useQuery } from '@tanstack/react-query';
import { Link, linkOptions } from '@tanstack/react-router';
import { recentQuery, useWorkspaces } from '@/api/hooks';
import { InlineErrorState } from '@/components/app/ErrorState';
import {
  ItemCard,
  ItemGrid,
  ItemSkeletonGrid,
} from '@/components/app/ItemCard';
import { ListViewToggle, useListView } from '@/components/app/ListToolbar';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import {
  type Thumbnail,
  ThumbnailPanel,
} from '@/components/app/ThumbnailPanel';
import { SkeletonList } from '@/components/ui/feedback';
import {
  materialDetails,
  relativeTime,
} from '@/features/materials/MaterialListCard';
import { ContentActions } from '@/features/workspace/ContentActions';
import {
  toFileActionTarget,
  toMaterialActionTarget,
} from '@/features/workspace/contentActionTarget';
import { m } from '@/i18n';
import { unexpectedErrorId } from '@/lib/errors';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { iconUrl } from '@/lib/icon-catalog';
import { PREF_KEYS } from '@/lib/localPrefs';
import { waitsForConnection } from '@/lib/online';
import {
  fromRecent,
  type OpenedRecentItem,
  type RecentItem,
} from './recentItems';

/** The row's one hint line: when the caller last opened it (creating counts),
 * the order the list follows. */
export function recentHint(item: OpenedRecentItem): string {
  return relativeTime(item.openedAt);
}

export function recentIcon(item: RecentItem) {
  return item.kind === 'file'
    ? fileIconName({ kind: item.fileKind, name: item.title })
    : materialIconName(item.type);
}

export function recentThumbnail(item: RecentItem): Thumbnail {
  return item.kind === 'file'
    ? {
        fileKind: item.fileKind,
        preview: item.file.preview,
        thumbnailUrl: item.file.thumbnailUrl,
      }
    : {
        pill: materialDetails(item.material) || undefined,
        preview: item.material.preview,
      };
}

/** Move is left out: the list spans workspaces, so there is no single
 * chapter list to move within. */
function RecentActions({
  item,
  display,
}: {
  item: RecentItem;
  display: 'hover' | 'menu';
}) {
  return (
    <ContentActions
      canClone={item.canClone}
      chapters={[]}
      content={
        item.kind === 'file'
          ? toFileActionTarget(item.file)
          : toMaterialActionTarget(item.material)
      }
      display={display}
      hoverClassName="mr-1.5"
      menuAlign="end"
      // Its menu shows only on the grid card; the list row has hover actions.
      menuTriggerIcon="moreVertical"
      readOnly={!item.canEdit}
      showMove={false}
      workspaceId={item.workspaceId}
    />
  );
}

export function recentLink(item: RecentItem) {
  if (!item.workspaceId) {
    return linkOptions({
      params: { materialId: item.id },
      to: '/materials/$materialId',
    });
  }
  return linkOptions({
    params: { workspaceId: item.workspaceId },
    search:
      item.kind === 'material' ? { material: item.id } : { file: item.id },
    to: '/workspaces/$workspaceId',
  });
}

/** The caller's newest opened (or created) files and materials, in open
 * order, once both lists have loaded: Recent Files and the quick open. The
 * rows come from the cache first and refetch in the background. */
export function useRecentItems() {
  const {
    data: recent,
    error: recentError,
    fetchStatus: recentFetchStatus,
    isError: recentFailed,
    isLoading: recentLoading,
    refetch: refetchRecent,
  } = useQuery({ ...recentQuery(), meta: { errorBoundary: false } });
  const {
    data: workspaces,
    error: workspacesError,
    fetchStatus: workspacesFetchStatus,
    isError: workspacesFailed,
    isLoading: workspacesLoading,
    refetch: refetchWorkspaces,
  } = useWorkspaces({ sort: 'accessed' }, { errorBoundary: false });

  const items = fromRecent(recent?.items ?? [], workspaces ?? []);
  const paused =
    waitsForConnection(recentFetchStatus, recent) ||
    waitsForConnection(workspacesFetchStatus, workspaces);
  const isLoading = recentLoading || workspacesLoading;
  // A list without data would drop its rows silently; a failed refresh keeps
  // the cached list, so only a missing one counts.
  const failed = [
    [recent, recentFailed, refetchRecent, recentError],
    [workspaces, workspacesFailed, refetchWorkspaces, workspacesError],
  ] as const;
  const missing = failed.filter(([data, isError]) => !data && isError);
  return { isLoading, items, missing, paused, workspaces };
}

export type RecentItems = ReturnType<typeof useRecentItems>;

/** The dashboard leaves it out while `recent.items` is empty and loaded. */
export function RecentItemsCard({ recent }: { recent: RecentItems }) {
  const [view, setView] = useListView(PREF_KEYS.recentsView);
  const { isLoading, items, missing, paused, workspaces } = recent;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="t-large-card-title">{m.dashboard_recent()}</h2>
        <ListViewToggle onViewChange={setView} view={view} />
      </div>
      {paused ? (
        <QueryPausedState />
      ) : isLoading ? (
        view === 'grid' ? (
          <ItemSkeletonGrid count={8} dense />
        ) : (
          <SkeletonList
            className="grid gap-1 md:grid-cols-2 md:gap-x-4"
            count={8}
            rowHeight={52}
          />
        )
      ) : missing.length ? (
        <InlineErrorState
          className="pt-10 pb-6"
          // The first failed list's id: the line has room for one.
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
      ) : view === 'grid' ? (
        <ItemGrid>
          {items.map((item) => {
            const workspace = workspaces?.find(
              (ws) => ws.id === item.workspaceId
            );
            return (
              <ItemCard
                actions={<RecentActions display="menu" item={item} />}
                dense
                icon={recentIcon(item)}
                key={`${item.kind}-${item.id}`}
                link={{ ...recentLink(item), preload: 'intent' }}
                meta={recentHint(item)}
                thumbnail={recentThumbnail(item)}
                title={item.title}
                view="grid"
                workspace={workspace?.name}
                workspaceIconId={workspace?.iconId}
              />
            );
          })}
        </ItemGrid>
      ) : (
        // Two items to a row from `md`, filled left to right.
        <div className="-mx-1.5 grid gap-1 md:grid-cols-2 md:gap-x-4">
          {items.map((item) => {
            const workspace = workspaces?.find(
              (ws) => ws.id === item.workspaceId
            );
            return (
              <div
                className="group relative flex items-center justify-between rounded-button hover:bg-surface-hover-bg"
                key={`${item.kind}-${item.id}`}
              >
                <Link
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-button px-1.5 py-1.5"
                  preload="intent"
                  {...recentLink(item)}
                >
                  <ThumbnailPanel
                    icon={recentIcon(item)}
                    small
                    {...recentThumbnail(item)}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-1 leading-tight">
                    <span className="line-clamp-2 font-semibold text-fg">
                      {item.title}
                    </span>
                    {/* Like the grid card's hint: workspace · date. */}
                    <span className="flex min-w-0 items-center gap-1.5 text-sm">
                      {workspace && (
                        <>
                          <img
                            alt=""
                            className="size-4.5 shrink-0 -translate-y-px rounded-[4px]"
                            height={18}
                            src={iconUrl(workspace.iconId)}
                            width={18}
                          />
                          <span className="min-w-0 truncate text-fg">
                            {workspace.name}
                          </span>
                          <span aria-hidden className="shrink-0 text-fg-muted">
                            ·
                          </span>
                        </>
                      )}
                      <span className="shrink-0 whitespace-nowrap text-fg-muted">
                        {recentHint(item)}
                      </span>
                    </span>
                  </span>
                </Link>
                <RecentActions display="hover" item={item} />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
