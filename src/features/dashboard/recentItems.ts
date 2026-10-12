import type {
  FileKind,
  MaterialKind,
  MaterialListItem,
  SourceFile,
  Workspace,
} from '@/api/types';

export const RECENT_ITEM_LIMIT = 20;

export type RecentItem =
  | {
      canClone: boolean;
      canEdit: boolean;
      createdAt: string;
      file: SourceFile;
      fileKind: FileKind;
      id: string;
      kind: 'file';
      title: string;
      workspaceId: string;
    }
  | {
      canClone: boolean;
      canEdit: boolean;
      createdAt: string;
      id: string;
      kind: 'material';
      material: MaterialListItem;
      title: string;
      type: MaterialKind;
      workspaceId: string;
    };

/** Merges the newest files and materials into one list. Each input is a
 * newest-first page of at least `limit` rows, so the merged top `limit` is
 * exact. Workspaces supply edit and clone rights. */
export function mergeRecentItems(
  files: SourceFile[],
  materials: MaterialListItem[],
  workspaces: Workspace[],
  limit = RECENT_ITEM_LIMIT
): RecentItem[] {
  const workspaceById = new Map(workspaces.map((ws) => [ws.id, ws]));
  // A standalone material in this list is always the caller's own.
  const canEdit = (workspaceId: string) =>
    !workspaceId || !!workspaceById.get(workspaceId)?.capabilities.canEdit;
  const canClone = (workspaceId: string) =>
    !workspaceId || !!workspaceById.get(workspaceId)?.canClone;
  const items: RecentItem[] = [
    ...files.map((file) => ({
      // Only a processed file copies (the server refuses others).
      canClone: file.status === 'ready' && canClone(file.workspaceId),
      canEdit: canEdit(file.workspaceId),
      createdAt: file.addedAt,
      file,
      fileKind: file.kind,
      id: file.id,
      kind: 'file' as const,
      title: file.name,
      workspaceId: file.workspaceId,
    })),
    ...materials.map((material) => ({
      canClone: canClone(material.workspaceId),
      canEdit: canEdit(material.workspaceId),
      createdAt: material.createdAt,
      id: material.id,
      kind: 'material' as const,
      material,
      title: material.title,
      type: material.kind,
      workspaceId: material.workspaceId,
    })),
  ];
  items.sort((a, b) => {
    const byDate = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    return byDate === 0 ? a.id.localeCompare(b.id) : byDate;
  });
  return items.slice(0, limit);
}
