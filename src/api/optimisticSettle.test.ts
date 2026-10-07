import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { api, qk } from './client';
import { useSetStudyPreferences } from './hooks';
import type { User } from './types';

vi.mock('./auth', () => ({ authHeaders: async () => ({}), USE_MSW: false }));
afterEach(() => vi.restoreAllMocks());

it('refetches only after the last overlapping optimistic save settles', async () => {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  client.setQueryData(qk.me, {
    studyPreferences: { quizLength: 8 },
  } as User);
  const pending: (() => void)[] = [];
  vi.spyOn(api, 'patch').mockImplementation(
    () => new Promise<void>((resolve) => pending.push(resolve))
  );
  let save:
    | ReturnType<typeof useSetStudyPreferences>['mutateAsync']
    | undefined;
  function Probe() {
    const { mutateAsync } = useSetStudyPreferences();
    save = mutateAsync;
    return null;
  }
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(Probe))
  );
  if (!save) throw new Error('Mutation was not initialized');
  const quizLength = () =>
    client.getQueryData<User>(qk.me)?.studyPreferences?.quizLength;

  try {
    const first = save({ quizLength: 10 });
    const second = save({ quizLength: 15 });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(quizLength()).toBe(15);

    pending[0]();
    await first;
    // The second save is still in flight, so its optimistic value stays.
    expect(client.getQueryState(qk.me)?.isInvalidated).toBe(false);
    expect(quizLength()).toBe(15);

    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]();
    await second;
    expect(client.getQueryState(qk.me)?.isInvalidated).toBe(true);
  } finally {
    client.clear();
  }
});
