import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, linkOptions } from '@tanstack/react-router';
import {
  recentFilesQuery,
  recentMaterialsQuery,
  useWorkspaces,
} from '@/api/hooks';
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
import { materialDetails } from '@/features/materials/MaterialListCard';
import { ContentActions } from '@/features/workspace/ContentActions';
import {
  toFileActionTarget,
  toMaterialActionTarget,
} from '@/features/workspace/contentActionTarget';
import { getLocale, m } from '@/i18n';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { PREF_KEYS } from '@/lib/localPrefs';
import { waitsForConnection } from '@/lib/online';
import { mergeRecentItems, type RecentItem } from './recentItems';

/** The row's one hint line: when it was last added or edited. Materials
 * carry `updatedAt`; file rows carry only `addedAt`. */
function recentHint(item: RecentItem): string {
  const locale = getLocale() === 'zh' ? 'zh-CN' : 'en';
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
  }).format(
    new Date(item.kind === 'file' ? item.file.addedAt : item.material.updatedAt)
  );
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
      menuTriggerIcon="moreHorizontal"
      readOnly={!item.canEdit}
      showMove={false}
      workspaceId={item.workspaceId}
    />
  );
}

function recentLink(item: RecentItem) {
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

/** Newest files and materials across the caller's member workspaces plus
 * their standalone materials. Renders once all three lists have loaded. */
export function RecentItemsCard() {
  const [view, setView] = useListView(PREF_KEYS.recentsView);
  const meta = { errorBoundary: false as const };
  const {
    data: files,
    fetchStatus: filesFetchStatus,
    isError: filesFailed,
    isLoading: filesLoading,
    refetch: refetchFiles,
  } = useInfiniteQuery({ ...recentFilesQuery(), meta });
  const {
    data: materials,
    fetchStatus: materialsFetchStatus,
    isError: materialsFailed,
    isLoading: materialsLoading,
    refetch: refetchMaterials,
  } = useInfiniteQuery({ ...recentMaterialsQuery(), meta });
  const {
    data: workspaces,
    fetchStatus: workspacesFetchStatus,
    isError: workspacesFailed,
    isLoading: workspacesLoading,
    refetch: refetchWorkspaces,
  } = useWorkspaces({ sort: 'accessed' }, { errorBoundary: false });

  const items = mergeRecentItems(
    files?.pages[0]?.items ?? [],
    materials?.pages[0]?.items ?? [],
    workspaces ?? []
  );
  const paused =
    waitsForConnection(filesFetchStatus, files) ||
    waitsForConnection(materialsFetchStatus, materials) ||
    waitsForConnection(workspacesFetchStatus, workspaces);
  const isLoading = filesLoading || materialsLoading || workspacesLoading;
  // A list without data would drop its rows silently; a failed refresh keeps
  // the cached list, so only a missing one counts.
  const failed = [
    [files, filesFailed, refetchFiles],
    [materials, materialsFailed, refetchMaterials],
    [workspaces, workspacesFailed, refetchWorkspaces],
  ] as const;
  const missing = failed.filter(([data, isError]) => !data && isError);

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
          <SkeletonList count={8} rowHeight={52} />
        )
      ) : missing.length ? (
        <InlineErrorState
          className="pt-10 pb-6"
          message={m.dashboard_recent_error()}
          onRetry={() => {
            for (const [, , refetch] of missing) void refetch();
          }}
        />
      ) : items.length === 0 ? (
        <p className="pt-10 pb-6 text-center text-fg-muted">
          {m.dashboard_recent_empty()}
        </p>
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
        <div className="-mx-1.5 flex flex-col gap-0.5">
          {items.map((item) => (
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
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="line-clamp-2 font-semibold text-fg">
                    {item.title}
                  </span>
                  <span className="line-clamp-1 text-fg-muted text-sm">
                    {recentHint(item)}
                  </span>
                </span>
              </Link>
              <RecentActions display="hover" item={item} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
