import { QueryClient } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { dehydratePersisted, persisted } from './queryPersistence';

it('stores only opted-in successful queries, infinite lists cut to one page', async () => {
  const client = new QueryClient();
  await client.prefetchQuery({
    ...persisted,
    queryFn: () => ({ id: 'ws' }),
    queryKey: ['workspace', 'ws'],
  });
  await client.prefetchQuery({
    queryFn: () => ({ content: 'body' }),
    queryKey: ['material', 'm'],
  });
  await client.prefetchQuery({
    ...persisted,
    queryFn: () => Promise.reject(new Error('offline')),
    queryKey: ['me'],
    retry: false,
  });
  await client.prefetchInfiniteQuery({
    ...persisted,
    getNextPageParam: (_last, pages) => pages.length,
    initialPageParam: 0,
    pages: 3,
    queryFn: ({ pageParam }) => [`row ${pageParam}`],
    queryKey: ['notifications'],
  });

  const queries = dehydratePersisted(client).queries;

  expect(queries.map((query) => query.queryKey)).toEqual([
    ['workspace', 'ws'],
    ['notifications'],
  ]);
  expect(queries[1]?.state.data).toEqual({
    pageParams: [0],
    pages: [['row 0']],
  });
});

it('keeps the ten most recently fetched chat histories', async () => {
  const client = new QueryClient();
  for (let i = 0; i < 12; i++) {
    vi.setSystemTime(1000 + i);
    await client.prefetchQuery({
      ...persisted,
      queryFn: () => [],
      queryKey: ['conversation', `c${i}`, 'messages'],
    });
  }
  vi.useRealTimers();

  const kept = dehydratePersisted(client).queries.map(
    (query) => query.queryKey[1]
  );

  expect(kept).toHaveLength(10);
  expect(kept).not.toContain('c0');
  expect(kept).not.toContain('c1');
});
