import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, linkOptions } from '@tanstack/react-router';
import {
  recentFilesQuery,
  recentMaterialsQuery,
  useWorkspaces,
} from '@/api/hooks';
import { ItemCard, ItemSkeletonGrid } from '@/components/app/ItemCard';
import { ListViewToggle, useListView } from '@/components/app/ListToolbar';
import { PanelHeader } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import {
  type Thumbnail,
  ThumbnailPanel,
} from '@/components/app/ThumbnailPanel';
import { SkeletonList } from '@/components/ui/feedback';
import { ContentActions } from '@/features/workspace/ContentActions';
import {
  toFileActionTarget,
  toMaterialActionTarget,
} from '@/features/workspace/contentActionTarget';
import { getLocale, m } from '@/i18n';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
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

function recentIcon(item: RecentItem) {
  return item.kind === 'file'
    ? fileIconName({ kind: item.fileKind, name: item.title })
    : materialIconName(item.type);
}

function recentThumbnail(item: RecentItem): Thumbnail {
  return item.kind === 'file'
    ? {
        fileKind: item.fileKind,
        preview: item.file.preview,
        thumbnailUrl: item.file.thumbnailUrl,
      }
    : { preview: item.material.preview };
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
      chapters={[]}
      content={
        item.kind === 'file'
          ? toFileActionTarget(item.file)
          : toMaterialActionTarget(item.material)
      }
      display={display}
      hoverClassName="mr-1.5"
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
  const [view, setView] = useListView('capy.recents.view', 'list');
  const meta = { errorBoundary: false as const };
  const {
    data: files,
    fetchStatus: filesFetchStatus,
    isLoading: filesLoading,
  } = useInfiniteQuery({ ...recentFilesQuery(), meta });
  const {
    data: materials,
    fetchStatus: materialsFetchStatus,
    isLoading: materialsLoading,
  } = useInfiniteQuery({ ...recentMaterialsQuery(), meta });
  const {
    data: workspaces,
    fetchStatus: workspacesFetchStatus,
    isLoading: workspacesLoading,
  } = useWorkspaces({ sort: 'accessed' }, { errorBoundary: false });

  const items = mergeRecentItems(
    files?.pages[0]?.items ?? [],
    materials?.pages[0]?.items ?? [],
    workspaces ?? []
  );
  const paused = [
    filesFetchStatus,
    materialsFetchStatus,
    workspacesFetchStatus,
  ].includes('paused');
  const isLoading = filesLoading || materialsLoading || workspacesLoading;

  return (
    <div className="flex min-h-full shrink-0 flex-col gap-3">
      <PanelHeader
        actions={<ListViewToggle onViewChange={setView} view={view} />}
        title={m.dashboard_recent()}
      />
      {paused ? (
        <QueryPausedState className="h-full min-h-full flex-1" />
      ) : isLoading ? (
        view === 'grid' ? (
          <ItemSkeletonGrid
            className="px-2 sm:grid-cols-2 sm:gap-2.5"
            count={6}
          />
        ) : (
          <SkeletonList className="px-3" count={8} rowHeight={60} />
        )
      ) : items.length === 0 ? (
        <p className="px-1 pt-2 pb-4 text-center text-fg-muted">
          {m.dashboard_recent_empty()}
        </p>
      ) : view === 'grid' ? (
        <div className="grid grid-cols-2 gap-2.5 px-2">
          {items.map((item) => (
            <ItemCard
              actions={<RecentActions display="menu" item={item} />}
              icon={recentIcon(item)}
              key={`${item.kind}-${item.id}`}
              link={{ ...recentLink(item), preload: 'intent' }}
              meta={recentHint(item)}
              thumbnail={recentThumbnail(item)}
              title={item.title}
              view="grid"
            />
          ))}
        </div>
      ) : (
        <div className="flex -translate-x-0.5 flex-col gap-1 px-2">
          {items.map((item) => (
            <div
              className="group relative flex items-center justify-between rounded-button hover:bg-surface-hover-bg"
              key={`${item.kind}-${item.id}`}
            >
              <Link
                className="flex min-w-0 flex-1 items-center gap-3 rounded-button px-1.5 py-2"
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
    </div>
  );
}
