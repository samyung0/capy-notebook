import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { api, qk } from './client';
import { filesQuery } from './hooks';
import type { SourceFile } from './types';

// The event stream replays nothing, so a terminal ingest event can be missed.
// A list read is the recovery: it refreshes a cached detail still marked
// pending or processing once the list reports completion.
describe('files list reconciliation', () => {
  it.each(['ready', 'failed'] as const)(
    'refreshes a stale detail when the list discovers %s, then stops fetching its body',
    async (status) => {
      const client = new QueryClient();
      const pending: SourceFile = {
        addedAt: '2026-09-10T00:00:00Z',
        chapterId: null,
        hasBytes: true,
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

  it('keeps client-only ingest progress across a list read while the file is still ingesting', async () => {
    const client = new QueryClient();
    const processing: SourceFile = {
      addedAt: '2026-09-10T00:00:00Z',
      chapterId: null,
      hasBytes: true,
      id: 'f_pct',
      indexed: false,
      kind: 'md',
      name: 'notes.md',
      position: 0,
      revision: 0,
      sizeBytes: 20,
      status: 'processing',
      workspaceId: 'ws_pct',
    };
    const get = vi
      .spyOn(api, 'get')
      .mockImplementation(async <T>() => [processing] as T);
    client.setQueryData(qk.files('ws_pct'), [{ ...processing, ingestPct: 40 }]);
    try {
      expect(await client.fetchQuery(filesQuery('ws_pct'))).toEqual([
        { ...processing, ingestPct: 40 },
      ]);
    } finally {
      client.clear();
      get.mockRestore();
    }
  });
});
