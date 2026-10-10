import type {
  FileKind,
  FileListParams,
  FileListSort,
  MaterialListKind,
  MaterialListLocation,
  MaterialListParams,
  MaterialListSort,
} from '@/api/types';
import { FILES_TABS, type FilesTab } from './tabSearch';

/*
 * List pages keep their sort menu and filters in the URL: `sort`, `dir` (only
 * `asc`, descending is the default) and one comma list per filter, e.g.
 * /files?sort=name&dir=asc&kind=pdf,doc. Defaults and empty filters are left
 * out and unknown values drop. Pages build their list query from the search,
 * and route loaders prefetch the same query.
 */

const one = <T extends string>(options: readonly T[], value: unknown) =>
  options.includes(value as T) ? (value as T) : undefined;
/** A comma list; the router parses number-like values, so numbers count. */
export const commaList = (value: string | undefined) =>
  value ? value.split(',').filter(Boolean) : [];
const listOf = <T extends string>(options: readonly T[], value: unknown) =>
  (typeof value === 'string' || typeof value === 'number'
    ? commaList(String(value))
    : []
  ).filter((item): item is T => options.includes(item as T));
/** A filter for the URL: a comma list, or nothing when empty. */
export const csv = (items: readonly string[]) =>
  items.length ? items.join(',') : undefined;
const anyList = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number'
    ? csv(commaList(String(value)))
    : undefined;
const dirOf = (value: unknown) => (value === 'asc' ? 'asc' : undefined);

/** A sort menu pick for the URL; the default order leaves both keys out. */
export const sortSearch = <S extends string>(
  sort: S,
  ascending: boolean,
  fallback: S
) => ({
  dir: ascending ? ('asc' as const) : undefined,
  sort: sort === fallback ? undefined : sort,
});

export const WORKSPACE_SORTS = [
  'accessed',
  'created',
  'chapters',
  'files',
] as const;
export type WorkspaceSort = (typeof WORKSPACE_SORTS)[number];
export const WORKSPACE_SORT_DEFAULT: WorkspaceSort = 'created';
export type WorkspacesSearch = {
  sort?: WorkspaceSort;
  dir?: 'asc';
  tag?: string;
};
export const parseWorkspacesSearch = (
  search: Record<string, unknown>
): WorkspacesSearch => ({
  dir: dirOf(search.dir),
  sort: one(WORKSPACE_SORTS, search.sort),
  tag: anyList(search.tag),
});
/** The server sorts and filters workspaces; the page reverses for `asc`. */
export const workspaceListParams = (search: WorkspacesSearch) => ({
  sort: search.sort ?? WORKSPACE_SORT_DEFAULT,
  tag: commaList(search.tag),
});

export const FILE_KINDS: FileKind[] = [
  'pdf',
  'doc',
  'md',
  'image',
  'txt',
  'sheet',
  'slides',
  'audio',
  'json',
  'unknown',
];
const FILE_SORTS: FileListSort[] = ['added', 'name', 'size', 'kind'];
export const FILE_SORT_DEFAULT: FileListSort = 'added';
export const MATERIAL_KINDS: MaterialListKind[] = [
  'note',
  'quiz',
  'flashcards',
];
export const MATERIAL_LOCATIONS: MaterialListLocation[] = [
  'workspace',
  'standalone',
];
const MATERIAL_SORTS: MaterialListSort[] = [
  'updated',
  'created',
  'title',
  'kind',
];
export const MATERIAL_SORT_DEFAULT: MaterialListSort = 'updated';

/** The Files page: the tab, then the Files or Blocks tab's own sort and
 * filters (`location` is Blocks only); Trash keeps none. */
export type FilesSearch = {
  tab?: FilesTab;
  sort?: FileListSort | MaterialListSort;
  dir?: 'asc';
  kind?: string;
  workspace?: string;
  location?: MaterialListLocation;
};
export function parseFilesSearch(search: Record<string, unknown>): FilesSearch {
  const tab = one(FILES_TABS, search.tab);
  if (tab === 'trash') return { tab };
  const blocks = tab === 'blocks';
  return {
    dir: dirOf(search.dir),
    kind: csv(
      listOf<string>(blocks ? MATERIAL_KINDS : FILE_KINDS, search.kind)
    ),
    location: blocks ? one(MATERIAL_LOCATIONS, search.location) : undefined,
    sort: blocks
      ? one(MATERIAL_SORTS, search.sort)
      : one(FILE_SORTS, search.sort),
    tab,
    workspace: anyList(search.workspace),
  };
}
const workspaceIds = (search: FilesSearch) => {
  const ids = commaList(search.workspace);
  return ids.length ? { workspaceIds: ids } : {};
};
export function fileListParams(search: FilesSearch): FileListParams {
  const kinds = listOf(FILE_KINDS, search.kind);
  return {
    dir: search.dir ?? 'desc',
    sort: one(FILE_SORTS, search.sort) ?? FILE_SORT_DEFAULT,
    ...(kinds.length ? { kinds } : {}),
    ...workspaceIds(search),
  };
}
export function materialListParams(search: FilesSearch): MaterialListParams {
  const kinds = listOf(MATERIAL_KINDS, search.kind);
  return {
    dir: search.dir ?? 'desc',
    sort: one(MATERIAL_SORTS, search.sort) ?? MATERIAL_SORT_DEFAULT,
    ...(kinds.length ? { kinds } : {}),
    ...(search.location ? { locations: [search.location] } : {}),
    ...workspaceIds(search),
  };
}
