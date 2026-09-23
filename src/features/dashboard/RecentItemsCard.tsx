import { useQueries } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { materialsQuery, useAllFiles, useWorkspaces } from '@/api/hooks';
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
import { mergeRecentItems } from './recentItems';

function formatRecentDate(iso: string): string {
  const locale = getLocale() === 'zh' ? 'zh-CN' : 'en';
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
  }).format(new Date(iso));
}

export function RecentItemsCard() {
  const {
    data: files,
    fetchStatus: filesFetchStatus,
    isLoading: filesLoading,
  } = useAllFiles({ errorBoundary: false });
  const {
    data: workspaces,
    fetchStatus: workspacesFetchStatus,
    isLoading: workspacesLoading,
  } = useWorkspaces({ sort: 'accessed' }, { errorBoundary: false });
  const materialQueries = useQueries({
    queries: (workspaces ?? []).map((ws) => ({
      ...materialsQuery(ws.id),
      meta: { errorBoundary: false as const },
    })),
  });

  const materials = materialQueries.flatMap((query, index) => {
    const { data } = query;
    const workspace = workspaces?.[index];
    if (!data || !workspace) return [];
    return data.map((ref) => ({
      ref,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    }));
  });
  const items = mergeRecentItems(files ?? [], materials, workspaces ?? []);
  const paused =
    filesFetchStatus === 'paused' ||
    workspacesFetchStatus === 'paused' ||
    materialQueries.some((query) => {
      const { fetchStatus } = query;
      return fetchStatus === 'paused';
    });
  const materialsLoading = materialQueries.some((query) => {
    const { isLoading: queryLoading } = query;
    return queryLoading;
  });
  const isLoading =
    (filesLoading && !files) ||
    (workspacesLoading && !workspaces) ||
    materialsLoading;

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
                params={{ workspaceId: item.workspaceId }}
                preload="intent"
                search={
                  item.kind === 'material'
                    ? { material: item.id, mode: 'view' }
                    : { file: item.id }
                }
                to="/workspaces/$workspaceId"
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
                    : toMaterialActionTarget(item.ref)
                }
                display="hover"
                hoverClassName="absolute top-1.5 right-1"
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
