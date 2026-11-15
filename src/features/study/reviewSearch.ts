import type {
  HistoryKind,
  HistoryParams,
  HistorySort,
  HistoryStatus,
  ReviewMode,
  ReviewStart,
} from '@/api/types';
import { commaList } from '@/lib/listSearch';

/** Where a review session was started from, so Back returns there. */
export type ReviewFrom = 'workspace' | 'review';

/** A review session's URL: a new session (group, topic, mode) or an
 * unfinished one to continue (session). */
export type ReviewSearch = Omit<Partial<ReviewStart>, 'mode'> & {
  from?: ReviewFrom;
  /** The suggestion's mode; `mode` is taken by the material pages. */
  reviewMode?: ReviewMode;
  session?: string;
};

const GROUPS = ['topic', 'others', 'workspace'] as const;
const MODES: readonly ReviewMode[] = ['tricky', 'fading', 'learned'];
const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

export function parseReviewSearch(
  search: Record<string, unknown>
): ReviewSearch {
  const out: ReviewSearch = {};
  if (search.from === 'review' || search.from === 'workspace')
    out.from = search.from;
  const group = GROUPS.find((g) => g === search.group);
  if (group) out.group = group;
  const mode = MODES.find((md) => md === search.reviewMode);
  if (mode) out.reviewMode = mode;
  out.topicId = text(search.topicId);
  out.session = text(search.session);
  return out;
}

/* Learning → History keeps its sort and filters in the URL like the list
 * pages: sort, dir (asc only), kind, status and workspace as comma lists; the server
 * sorts, filters and pages. */
export const HISTORY_SORTS: readonly HistorySort[] = [
  'date',
  'workspace',
  'name',
  'topic',
  'score',
];
export const HISTORY_SORT_DEFAULT: HistorySort = 'date';
export const HISTORY_KINDS: readonly HistoryKind[] = [
  'revision',
  'quiz',
  'flashcards',
];
export const HISTORY_STATUSES: readonly HistoryStatus[] = [
  'open',
  'partial',
  'done',
];
export type HistorySearch = {
  sort?: HistorySort;
  dir?: 'asc';
  kind?: string;
  status?: string;
  workspace?: string;
};

export function parseHistorySearch(
  search: Record<string, unknown>
): HistorySearch {
  const out: HistorySearch = {};
  const sort = HISTORY_SORTS.find((s) => s === search.sort);
  if (sort && sort !== HISTORY_SORT_DEFAULT) out.sort = sort;
  if (search.dir === 'asc') out.dir = 'asc';
  const workspace = commaList(text(search.workspace));
  if (workspace.length) out.workspace = workspace.join(',');
  const kind = historyKinds(text(search.kind));
  if (kind.length) out.kind = kind.join(',');
  const status = historyStatuses(text(search.status));
  if (status.length) out.status = status.join(',');
  return out;
}

const historyStatuses = (value?: string): HistoryStatus[] =>
  commaList(value).filter((s): s is HistoryStatus =>
    HISTORY_STATUSES.includes(s as HistoryStatus)
  );

const historyKinds = (value?: string): HistoryKind[] =>
  commaList(value).filter((k): k is HistoryKind =>
    HISTORY_KINDS.includes(k as HistoryKind)
  );

export const historyParams = (search: HistorySearch): HistoryParams => ({
  dir: search.dir,
  kinds: historyKinds(search.kind),
  sort: search.sort,
  statuses: historyStatuses(search.status),
  workspaceIds: commaList(search.workspace),
});
