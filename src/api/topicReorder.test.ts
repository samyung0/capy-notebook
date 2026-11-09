import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { api, qk } from './client';
import { useReorderTopics } from './hooks';
import type { Topic } from './types';

vi.mock('./auth', () => ({ authHeaders: async () => ({}), USE_MSW: false }));
afterEach(() => vi.restoreAllMocks());

it.each(['success', 'failure'])(
  'reorders topics before the server responds and reconciles on %s',
  async (result) => {
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const key = qk.topics('workspace');
    const original: Topic[] = ['first', 'second', 'third'].map((id, order) => ({
      description: '',
      fileIds: [],
      id,
      name: id,
      order,
      workspaceId: 'workspace',
    }));
    client.setQueryData(key, original);
    let resolveRequest!: () => void;
    let rejectRequest!: (error: Error) => void;
    const request = new Promise<void>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const post = vi.spyOn(api, 'post').mockReturnValue(request);
    let reorder: ReturnType<typeof useReorderTopics>['mutateAsync'] | undefined;
    function Probe() {
      const { mutateAsync } = useReorderTopics('workspace');
      reorder = mutateAsync;
      return null;
    }
    renderToStaticMarkup(
      createElement(QueryClientProvider, { client }, createElement(Probe))
    );
    if (!reorder) throw new Error('Mutation was not initialized');
    const ids = ['third', 'first', 'second'];
    const optimistic = ids.map((id, order) => ({
      ...original.find((topic) => topic.id === id),
      order,
    }));
    const failure = new Error('Save failed');
    const settled = reorder(ids).catch((error: unknown) => error);
    try {
      await vi.waitFor(() =>
        expect(client.getQueryData(key)).toEqual(optimistic)
      );
      expect(post).toHaveBeenCalledWith(
        '/workspaces/workspace/topics/reorder',
        { ids }
      );
      expect(original.map((topic) => topic.order)).toEqual([0, 1, 2]);
      if (result === 'success') resolveRequest();
      else rejectRequest(failure);
      expect(await settled).toBe(result === 'success' ? undefined : failure);
      expect(client.getQueryData(key)).toEqual(
        result === 'success' ? optimistic : original
      );
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    } finally {
      client.clear();
    }
  }
);
