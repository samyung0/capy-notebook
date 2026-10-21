import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, api, qk } from './client';
import { useDeleteLabel } from './hooks';

vi.mock('./auth', () => ({ authHeaders: async () => ({}), USE_MSW: false }));
afterEach(() => vi.restoreAllMocks());

// Epo 2026-10-21: a label that is already gone counts as deleted (no error,
// the list refreshes); any other failure still fails.
it.each([
  [404, undefined],
  [500, 'failed'],
] as const)('deleting a label answered %i', async (status, outcome) => {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  client.setQueryData(qk.labels, []);
  vi.spyOn(api, 'del').mockRejectedValue(new ApiError(status, 'Error'));
  let remove: ReturnType<typeof useDeleteLabel>['mutateAsync'] | undefined;
  function Probe() {
    const { mutateAsync } = useDeleteLabel();
    remove = mutateAsync;
    return null;
  }
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(Probe))
  );
  if (!remove) throw new Error('Mutation was not initialized');
  try {
    const result = await remove('lb_gone').then(
      () => undefined,
      () => 'failed'
    );
    expect(result).toBe(outcome);
    expect(client.getQueryState(qk.labels)?.isInvalidated).toBe(status === 404);
  } finally {
    client.clear();
  }
});
