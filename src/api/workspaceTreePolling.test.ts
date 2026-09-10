import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { api, qk } from './client';
import { filesQuery, materialsQuery } from './hooks';
import type { SourceFile } from './types';

// The workspace page polls its file and material lists through useFiles /
// useMaterials. The polling must stay on those hooks: the dashboard's
// RecentItemsCard spreads materialsQuery across every workspace at once, so a
// refetchInterval on the factory would quietly poll all of them.
describe('workspace tree query factories', () => {
  it('carry no polling of their own', () => {
    for (const options of [filesQuery('ws_1'), materialsQuery('ws_1')]) {
      expect(options).not.toHaveProperty('refetchInterval');
      expect(options).not.toHaveProperty('refetchOnWindowFocus');
    }
  });

  it.each(['ready', 'failed'] as const)(
    'refreshes a stale detail when the list discovers %s, then stops fetching its body',
    async (status) => {
      const client = new QueryClient();
      const pending: SourceFile = {
        addedAt: '2026-09-10T00:00:00Z',
        chapterId: null,
        id: 'f_poll',
        indexed: false,
        kind: 'md',
        name: 'notes.md',
        position: 0,
        revision: 0,
        sizeBytes: 20,
        status: 'processing',
        workspaceId: 'ws_poll',
      };
      const completed = { ...pending, indexed: status === 'ready', status };
      const detail = { ...completed, content: '# notes' };
      const get = vi
        .spyOn(api, 'get')
        .mockImplementation(
          async <T>(path: string) =>
            (path === '/files/f_poll' ? detail : [completed]) as T
        );
      client.setQueryData(qk.file(pending.id), pending);
      const observer = new QueryObserver(client, {
        queryFn: () => api.get<SourceFile>('/files/f_poll'),
        queryKey: qk.file(pending.id),
        staleTime: Number.POSITIVE_INFINITY,
      });
      const unsubscribe = observer.subscribe(() => {});
      try {
        expect(await client.fetchQuery(filesQuery('ws_poll'))).toEqual([
          completed,
        ]);
        await vi.waitFor(() =>
          expect(client.getQueryData(qk.file(pending.id))).toEqual(detail)
        );
        await client.fetchQuery(filesQuery('ws_poll'));
        expect(
          get.mock.calls.filter(([path]) => path === '/files/f_poll')
        ).toHaveLength(1);
      } finally {
        unsubscribe();
        client.clear();
        get.mockRestore();
      }
    }
  );
});
