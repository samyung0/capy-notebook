import type {
  FileKind,
  MaterialKind,
  MaterialListItem,
  SourceFile,
  Workspace,
} from '@/api/types';
import { fileCanClone } from '@/features/files/fileUtils';
import type { RecentOpen } from '@/lib/recentOpens';

/** The dashboard's Recent Files size. */
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

/** A quick open row: the item and when this browser last opened it. */
export type OpenedRecentItem = RecentItem & { openedAt: string };

/** The rows as recent items; workspaces supply edit and clone rights. */
function toRecentItems(
  files: SourceFile[],
  materials: MaterialListItem[],
  workspaces: Workspace[]
): RecentItem[] {
  const workspaceById = new Map(workspaces.map((ws) => [ws.id, ws]));
  // A standalone material in this list is always the caller's own.
  const canEdit = (workspaceId: string) =>
    !workspaceId || !!workspaceById.get(workspaceId)?.capabilities.canEdit;
  const canClone = (workspaceId: string) =>
    !workspaceId || !!workspaceById.get(workspaceId)?.canClone;
  return [
    ...files.map((file) => ({
      canClone: fileCanClone(file) && canClone(file.workspaceId),
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
}

/** Merges the newest files and materials into one list. Each input is a
 * newest-first page of at least `limit` rows, so the merged top `limit` is
 * exact. */
export function mergeRecentItems(
  files: SourceFile[],
  materials: MaterialListItem[],
  workspaces: Workspace[],
  limit: number
): RecentItem[] {
  return toRecentItems(files, materials, workspaces)
    .sort((a, b) => {
      const byDate = Date.parse(b.createdAt) - Date.parse(a.createdAt);
      return byDate === 0 ? a.id.localeCompare(b.id) : byDate;
    })
    .slice(0, limit);
}

/** The rows in the order this browser opened them, each with its open time.
 * Opens whose row the lists left out (deleted, access lost) are skipped. */
export function orderByOpens(
  files: SourceFile[],
  materials: MaterialListItem[],
  workspaces: Workspace[],
  opens: RecentOpen[]
): OpenedRecentItem[] {
  const byKey = new Map(
    toRecentItems(files, materials, workspaces).map((item) => [
      `${item.kind}:${item.id}`,
      item,
    ])
  );
  return opens.flatMap((open) => {
    const item = byKey.get(`${open.kind}:${open.id}`);
    return item ? [{ ...item, openedAt: open.openedAt }] : [];
  });
}
