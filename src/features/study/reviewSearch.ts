/** Where a review session was started from, so Back returns there. */
export type ReviewFrom = 'workspace' | 'learning';

export function parseReviewSearch(search: Record<string, unknown>): {
  from?: ReviewFrom;
} {
  return search.from === 'learning' || search.from === 'workspace'
    ? { from: search.from }
    : {};
}
