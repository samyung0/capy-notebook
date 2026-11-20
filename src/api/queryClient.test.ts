import { expect, it } from 'vitest';
import { ApiError } from './client';
import { queryClient } from './queryClient';
import { PERSIST_MAX_AGE } from './queryPersistence';

// security regression: rate-limit audit L12
it('leaves a rate-limited read to the user instead of retrying it', () => {
  const retry = queryClient.getDefaultOptions().queries?.retry as (
    failureCount: number,
    error: unknown
  ) => boolean;
  expect(retry(0, new ApiError(429, 'Too Many Requests'))).toBe(false);
  expect(retry(0, new ApiError(503, 'Service Unavailable'))).toBe(true);
});

// Q39 (review 2026-11-20): a stored read of an item now deleted keeps its
// data, which the page showing it keeps its unsent edits and header on; one
// now missing drops it.
it("keeps a stored read's data when the item was deleted, and drops it when missing", async () => {
  const read = async (id: string, error: ApiError) => {
    queryClient.setQueryData(['stored', id], { id });
    await queryClient
      .fetchQuery({
        gcTime: PERSIST_MAX_AGE,
        queryFn: () => Promise.reject(error),
        queryKey: ['stored', id],
        retry: false,
        staleTime: 0,
      })
      .catch(() => undefined);
    return queryClient.getQueryData(['stored', id]);
  };
  const deleted = new ApiError(410, 'Gone', undefined, {
    code: 'item_deleted',
    kind: 'doc',
    name: 'Notes.docx',
  } as never);
  expect(await read('deleted', deleted)).toEqual({ id: 'deleted' });
  expect(await read('missing', new ApiError(404, 'Not Found'))).toBeUndefined();
});
