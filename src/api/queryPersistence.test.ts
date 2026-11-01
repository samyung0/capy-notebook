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

it('keeps the latest 40 messages of the ten chat histories fetched most recently, in the store and in memory', async () => {
  const client = new QueryClient();
  await client.prefetchQuery({
    ...persisted,
    queryFn: () => ({ id: 'ws' }),
    queryKey: ['workspace', 'ws'],
  });
  for (let i = 0; i < 12; i++) {
    vi.setSystemTime(1000 + i);
    await client.prefetchQuery({
      ...persisted,
      queryFn: () => Array.from({ length: 50 }, (_, m) => m),
      queryKey: ['conversation', `c${i}`, 'messages'],
    });
  }
  vi.useRealTimers();

  const queries = dehydratePersisted(client).queries;
  const kept = queries.map((query) => query.queryKey[1]);

  expect(kept).toHaveLength(11);
  expect(queries.at(-1)?.state.data).toEqual(
    Array.from({ length: 40 }, (_, m) => m + 10)
  );
  expect(kept).toContain('ws');
  expect(kept).not.toContain('c0');
  expect(kept).not.toContain('c1');
  expect(
    client.getQueryData(['conversation', 'c0', 'messages'])
  ).toBeUndefined();
});

it('stores the kept data of a failed refetch as data', async () => {
  const client = new QueryClient();
  await client.prefetchQuery({
    ...persisted,
    queryFn: () => ['m_0'],
    queryKey: ['conversation', 'c', 'messages'],
  });
  await client.prefetchQuery({
    ...persisted,
    queryFn: () => Promise.reject(new Error('offline')),
    queryKey: ['conversation', 'c', 'messages'],
    retry: false,
    staleTime: 0,
  });

  const [query] = dehydratePersisted(client).queries;

  expect(query?.state).toMatchObject({
    data: ['m_0'],
    error: null,
    status: 'success',
  });
});
