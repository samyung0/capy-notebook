import type {
  PastReviewHas,
  PastReviewParams,
  PastReviewSort,
  ReviewMode,
  ReviewStart,
} from '@/api/types';
import { commaList } from '@/lib/listSearch';

/** Where a review session was started from, so Back returns there. */
export type ReviewFrom = 'workspace' | 'review';

/** A review session's URL: a new session (group, chapter, mode) or an
 * unfinished one to continue (session). */
export type ReviewSearch = Omit<Partial<ReviewStart>, 'mode'> & {
  from?: ReviewFrom;
  /** The suggestion's mode; `mode` is taken by the material pages. */
  reviewMode?: ReviewMode;
  session?: string;
};

const GROUPS = ['chapter', 'others', 'workspace'] as const;
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
  out.chapterId = text(search.chapterId);
  out.session = text(search.session);
  return out;
}

/* Learning → Past reviews keeps its sort and filters in the URL like the
 * list pages: sort, dir (asc only), workspace and has as comma lists. */
export const PAST_REVIEW_SORTS: readonly PastReviewSort[] = [
  'date',
  'quiz',
  'cards',
  'time',
];
export const PAST_REVIEW_SORT_DEFAULT: PastReviewSort = 'date';
const HAS: readonly PastReviewHas[] = ['quiz', 'flashcards'];
export type PastReviewsSearch = {
  sort?: PastReviewSort;
  dir?: 'asc';
  workspace?: string;
  has?: string;
};

export function parsePastReviewsSearch(
  search: Record<string, unknown>
): PastReviewsSearch {
  const out: PastReviewsSearch = {};
  const sort = PAST_REVIEW_SORTS.find((s) => s === search.sort);
  if (sort && sort !== PAST_REVIEW_SORT_DEFAULT) out.sort = sort;
  if (search.dir === 'asc') out.dir = 'asc';
  const workspace = commaList(text(search.workspace));
  if (workspace.length) out.workspace = workspace.join(',');
  const has = commaList(text(search.has)).filter((h) =>
    HAS.includes(h as PastReviewHas)
  );
  if (has.length) out.has = has.join(',');
  return out;
}

export function pastReviewParams(search: PastReviewsSearch): PastReviewParams {
  return {
    dir: search.dir,
    has: commaList(search.has) as PastReviewHas[],
    sort: search.sort,
    workspaceIds: commaList(search.workspace),
  };
}

/* Learning → All results: the same keys, sorted and filtered in the browser
 * since the attempts list arrives whole. */
export const RESULT_SORTS = ['date', 'score'] as const;
export type ResultSort = (typeof RESULT_SORTS)[number];
export const RESULT_SORT_DEFAULT: ResultSort = 'date';
export type ResultsSearch = {
  sort?: ResultSort;
  dir?: 'asc';
  workspace?: string;
};

export function parseResultsSearch(
  search: Record<string, unknown>
): ResultsSearch {
  const out: ResultsSearch = {};
  const sort = RESULT_SORTS.find((s) => s === search.sort);
  if (sort && sort !== RESULT_SORT_DEFAULT) out.sort = sort;
  if (search.dir === 'asc') out.dir = 'asc';
  const workspace = commaList(text(search.workspace));
  if (workspace.length) out.workspace = workspace.join(',');
  return out;
}
