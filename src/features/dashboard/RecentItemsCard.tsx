import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, linkOptions } from '@tanstack/react-router';
import {
  recentFilesQuery,
  recentMaterialsQuery,
  useWorkspaces,
} from '@/api/hooks';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { FileIcon } from '@/components/ui/FileIcon';
import { SkeletonList } from '@/components/ui/feedback';
import { ContentActions } from '@/features/workspace/ContentActions';
import {
  toFileActionTarget,
  toMaterialActionTarget,
} from '@/features/workspace/contentActionTarget';
import { getLocale, m } from '@/i18n';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { mergeRecentItems, type RecentItem } from './recentItems';

function formatRecentDate(iso: string): string {
  const locale = getLocale() === 'zh' ? 'zh-CN' : 'en';
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
  }).format(new Date(iso));
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
    <div className="flex flex-col gap-3">
      <h3 className="t-card-title px-4">{m.dashboard_recent()}</h3>
      {paused ? (
        <QueryPausedState />
      ) : isLoading ? (
        <SkeletonList count={8} rowHeight={52} />
      ) : items.length === 0 ? (
        <p className="px-1 pt-2 pb-4 text-center text-fg-muted">
          {m.dashboard_recent_empty()}
        </p>
      ) : (
        <div className="flex -translate-x-0.5 flex-col gap-1 px-2">
          {items.map((item) => (
            <div
              className="group relative rounded-button"
              key={`${item.kind}-${item.id}`}
            >
              <Link
                className="flex items-start gap-3 rounded-button px-1 py-2 hover:bg-surface-hover-bg"
                preload="intent"
                {...recentLink(item)}
              >
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-button">
                  <FileIcon
                    className="size-5"
                    name={
                      item.kind === 'file'
                        ? fileIconName({
                            kind: item.fileKind,
                            name: item.title,
                          })
                        : materialIconName(item.type)
                    }
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 font-semibold text-fg">
                    {item.title}
                  </span>
                  <span className="line-clamp-1 text-fg-muted text-sm">
                    {[item.workspaceName, formatRecentDate(item.createdAt)]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </Link>
              {/* Move is left out: the list spans workspaces, so there is no
               * single chapter list to move within. */}
              <ContentActions
                chapters={[]}
                content={
                  item.kind === 'file'
                    ? toFileActionTarget(item.file)
                    : toMaterialActionTarget(item.material)
                }
                display="hover"
                hoverClassName="absolute top-1.5 right-1"
                readOnly={!item.canEdit}
                showMove={false}
                workspaceId={item.workspaceId}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
