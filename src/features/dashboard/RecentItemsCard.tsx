import { useQueries } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { materialsQuery, useAllFiles, useWorkspaces } from '@/api/hooks';
import type { MaterialRefType } from '@/api/types';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon, type IconName } from '@/components/ui/Icon';
import { getLocale, m } from '@/i18n';
import { mergeRecentItems } from './recentItems';

const MATERIAL_ICON: Record<MaterialRefType, IconName> = {
  diagram: 'diagram',
  flashcards: 'flashcards',
  mindmap: 'mindmap',
  note: 'write',
  quiz: 'quiz',
};

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
  const isLoading =
    (filesLoading && !files) || (workspacesLoading && !workspaces);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <h3 className="t-card-title">{m.dashboard_recent()}</h3>
      {paused ? (
        <QueryPausedState />
      ) : isLoading ? (
        <SkeletonList count={8} rowHeight={52} />
      ) : items.length === 0 ? (
        <p className="px-1 pt-2 pb-4 text-center text-fg-muted">
          {m.dashboard_recent_empty()}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {items.map((item) => (
            <Link
              className="flex items-start gap-3 rounded-button px-1 py-2 hover:bg-surface-hover-bg"
              key={`${item.kind}-${item.id}`}
              params={{ workspaceId: item.workspaceId }}
              preload="intent"
              search={
                item.kind === 'material'
                  ? { material: item.id, mode: 'view' }
                  : { file: item.id }
              }
              to="/workspaces/$workspaceId"
            >
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-button bg-surface-hover-bg text-fg-secondary">
                <Icon
                  name={
                    item.kind === 'file' ? 'files' : MATERIAL_ICON[item.type]
                  }
                  size={16}
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
          ))}
        </div>
      )}
    </div>
  );
}
