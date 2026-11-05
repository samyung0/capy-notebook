import { useQuery } from '@tanstack/react-query';
import { linkOptions } from '@tanstack/react-router';
import { recentQuery, useWorkspaces } from '@/api/hooks';
import type { Thumbnail } from '@/components/app/ThumbnailPanel';
import {
  materialDetails,
  relativeTime,
} from '@/features/materials/MaterialListCard';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
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
    : materialIconName(item.type, item.material.assigned);
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

/** The topic-only Move is left out: the list spans workspaces, so there is
 * no single topic list to move within. Move to… picks its own. */
export function recentLink(item: RecentItem) {
  // A standalone item (no workspace) opens on its own page.
  if (!item.workspaceId && item.kind === 'file') {
    return linkOptions({
      params: { fileId: item.id },
      to: '/files/$fileId',
    });
  }
  if (!item.workspaceId) {
    return linkOptions({
      params: { materialId: item.id },
      to: '/materials/$materialId',
    });
  }
  return linkOptions({
    params: { workspaceId: item.workspaceId },
    search: recentSearch(item),
    to: '/workspaces/$workspaceId',
  });
}

/** What a recent row opens in its workspace: an assignee's quiz, its assignment. */
export function recentSearch(item: RecentItem) {
  if (item.kind === 'file') return { file: item.id };
  const assignment = item.material.assignmentId;
  return assignment
    ? { assignment, study: 'assignments' as const }
    : { material: item.id };
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
