import type {
  FileKind,
  ItemKind,
  ItemListParams,
  ItemListSort,
  MaterialListKind,
} from '@/api/types';
import { PREF_KEYS, readPref, type SortedList, writePref } from './localPrefs';
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

/** A sort menu pick for the URL; the default order leaves both keys out.
 * The pick is remembered for `list`, see `savedSort`. */
export function sortSearch<S extends string>(
  list: SortedList,
  sort: S,
  ascending: boolean,
  fallback: S
) {
  const search = {
    dir: ascending ? ('asc' as const) : undefined,
    sort: sort === fallback ? undefined : sort,
  };
  writePref(PREF_KEYS.sort(list), search);
  return search;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** The list's remembered sort when the URL names none, for the route to
 * redirect to, so the URL and the loader's prefetch carry it. Only known,
 * non-default values come back, which every parser keeps, so the redirect
 * cannot loop. */
export function savedSort<S extends string>(
  list: SortedList,
  options: readonly S[],
  fallback: S,
  search: { sort?: unknown; dir?: unknown }
): { sort?: S; dir?: 'asc' } | undefined {
  if (search.sort !== undefined || search.dir !== undefined) return;
  const saved = readPref(PREF_KEYS.sort(list), {}, isRecord);
  const known = one(options, saved.sort);
  const sort = known === fallback ? undefined : known;
  const dir = dirOf(saved.dir);
  return sort || dir ? { dir, sort } : undefined;
}

export const WORKSPACE_SORTS = [
  'accessed',
  'created',
  'topics',
  'files',
] as const;
export type WorkspaceSort = (typeof WORKSPACE_SORTS)[number];
export const WORKSPACE_SORT_DEFAULT: WorkspaceSort = 'accessed';
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
export const workspaceListParams = (search: WorkspacesSearch) => {
  const tag = commaList(search.tag);
  // With no tags it shares the query every other reader of the list uses.
  return {
    sort: search.sort ?? WORKSPACE_SORT_DEFAULT,
    ...(tag.length > 0 ? { tag } : {}),
  };
};

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
export const MATERIAL_KINDS: MaterialListKind[] = [
  'note',
  'quiz',
  'flashcards',
];
/** The Files page's Kind filter: every file kind, then the blocks; image and
 * audio also take embedded images and audio. */
export const ITEM_KINDS: ItemKind[] = [
  ...FILE_KINDS,
  ...MATERIAL_KINDS,
  'canvas',
];
export const ITEM_SORTS: ItemListSort[] = [
  'added',
  'name',
  'size',
  'kind',
  'workspace',
];
export const ITEM_SORT_DEFAULT: ItemListSort = 'added';

/** The Files page: the tab, then the list's sort and filters (Canvas and
 * Trash have none). */
export type FilesSearch = {
  tab?: FilesTab;
  /** All files adds every file and block of the caller's own and member
   * workspaces to what it pays for (My files, the default). */
  owner?: 'all';
  sort?: ItemListSort;
  dir?: 'asc';
  kind?: string;
  workspace?: string;
  /** One switch (Epo 2026-10-30): only what sits in a workspace. */
  location?: 'workspace';
};
export function parseFilesSearch(search: Record<string, unknown>): FilesSearch {
  const tab = one(FILES_TABS, search.tab);
  // Canvas and Trash have no sort or filters; `files`, the default, drops
  // out of the URL.
  if (tab && tab !== 'files') return { tab };
  return {
    dir: dirOf(search.dir),
    kind: csv(listOf<string>(ITEM_KINDS, search.kind)),
    location: search.location === 'workspace' ? 'workspace' : undefined,
    owner: search.owner === 'all' ? 'all' : undefined,
    sort: one(ITEM_SORTS, search.sort),
    workspace: anyList(search.workspace),
  };
}
export function itemListParams(search: FilesSearch): ItemListParams {
  const kinds = listOf(ITEM_KINDS, search.kind);
  const workspaceIds = commaList(search.workspace);
  return {
    dir: search.dir ?? 'desc',
    sort: search.sort ?? ITEM_SORT_DEFAULT,
    ...(kinds.length ? { kinds } : {}),
    ...(search.location ? { locations: [search.location] } : {}),
    ...(search.owner ? { scope: search.owner } : {}),
    ...(workspaceIds.length ? { workspaceIds } : {}),
  };
}

/* The To do page (Epo 2026-11-08): its tab, sort and filters. To do sorts by
   Due or To do from the table's headers, Done by its date (Epo 2026-11-10); a
   sort the tab lacks reads as its default. `dir` is set only when it differs
   from the column's own order (due and title ascending, done newest first). */
export const TODO_SORTS = ['due', 'title', 'done'] as const;
export type TodoSort = (typeof TODO_SORTS)[number];
export const TODO_TYPES = ['quiz', 'task'] as const;
export type TodoType = (typeof TODO_TYPES)[number];
export type TodoSearch = {
  tab?: 'done';
  sort?: TodoSort;
  dir?: 'asc' | 'desc';
  type?: string;
};
export const parseTodoSearch = (
  search: Record<string, unknown>
): TodoSearch => ({
  dir: search.dir === 'asc' || search.dir === 'desc' ? search.dir : undefined,
  sort: one(TODO_SORTS, search.sort),
  tab: search.tab === 'done' ? 'done' : undefined,
  type: csv(listOf(TODO_TYPES, search.type)),
});
