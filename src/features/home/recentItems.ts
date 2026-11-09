import type {
  FileKind,
  MaterialKind,
  MaterialListItem,
  RecentOpen,
  SourceFile,
} from '@/api/types';

export type RecentItem =
  | {
      createdAt: string;
      file: SourceFile;
      fileKind: FileKind;
      id: string;
      kind: 'file';
      title: string;
      workspaceId: string;
    }
  | {
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

/** The rows as recent items. */
function toRecentItems(
  files: SourceFile[],
  materials: MaterialListItem[]
): RecentItem[] {
  return [
    ...files.map((file) => ({
      createdAt: file.addedAt,
      file,
      fileKind: file.kind,
      id: file.id,
      kind: 'file' as const,
      title: file.name,
      workspaceId: file.workspaceId,
    })),
    ...materials.map((material) => ({
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
  limit: number
): RecentItem[] {
  return toRecentItems(files, materials)
    .sort((a, b) => {
      const byDate = Date.parse(b.createdAt) - Date.parse(a.createdAt);
      return byDate === 0 ? a.id.localeCompare(b.id) : byDate;
    })
    .slice(0, limit);
}

/** GET /recent's rows as recent items, in its open order, each with its open
 * time. */
export function fromRecent(rows: RecentOpen[]): OpenedRecentItem[] {
  return rows.flatMap((row) => {
    const [item] = toRecentItems(
      row.file ? [row.file] : [],
      row.material ? [row.material] : []
    );
    return item ? [{ ...item, openedAt: row.openedAt }] : [];
  });
}
