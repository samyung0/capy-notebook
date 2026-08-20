import type {
  MaterialRef,
  MaterialRefType,
  SourceFile,
  Workspace,
} from '@/api/types';

export const RECENT_ITEM_LIMIT = 20;

export type RecentItem =
  | {
      createdAt: string;
      id: string;
      kind: 'file';
      title: string;
      workspaceId: string;
      workspaceName: string;
    }
  | {
      createdAt: string;
      id: string;
      kind: 'material';
      title: string;
      type: MaterialRefType;
      workspaceId: string;
      workspaceName: string;
    };

export function mergeRecentItems(
  files: SourceFile[],
  materials: Array<{
    ref: MaterialRef;
    workspaceId: string;
    workspaceName: string;
  }>,
  workspaces: Workspace[],
  limit = RECENT_ITEM_LIMIT
): RecentItem[] {
  const workspaceName = new Map(workspaces.map((ws) => [ws.id, ws.name]));
  const items: RecentItem[] = [
    ...files.map((file) => ({
      createdAt: file.addedAt,
      id: file.id,
      kind: 'file' as const,
      title: file.name,
      workspaceId: file.workspaceId,
      workspaceName: workspaceName.get(file.workspaceId) ?? '',
    })),
    ...materials.map(({ ref, workspaceId, workspaceName: name }) => ({
      createdAt: ref.createdAt,
      id: ref.id,
      kind: 'material' as const,
      title: ref.title,
      type: ref.type,
      workspaceId,
      workspaceName: name,
    })),
  ];
  items.sort((a, b) => {
    const byDate = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    return byDate === 0 ? a.id.localeCompare(b.id) : byDate;
  });
  return items.slice(0, limit);
}
