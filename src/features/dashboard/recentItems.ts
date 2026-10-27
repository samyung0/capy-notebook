import type {
  FileKind,
  MaterialKind,
  MaterialListItem,
  RecentOpen,
  SourceFile,
  Workspace,
} from '@/api/types';
import { fileCanClone } from '@/features/files/fileUtils';

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

/** A Recent row: the item and when the caller last opened it. */
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

/** GET /recent's rows as recent items, in its open order, each with its open
 * time; workspaces supply edit and clone rights. */
export function fromRecent(
  rows: RecentOpen[],
  workspaces: Workspace[]
): OpenedRecentItem[] {
  return rows.flatMap((row) => {
    const [item] = toRecentItems(
      row.file ? [row.file] : [],
      row.material ? [row.material] : [],
      workspaces
    );
    return item ? [{ ...item, openedAt: row.openedAt }] : [];
  });
}
