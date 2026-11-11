import {
  type InfiniteData,
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
} from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { mockConvertedEvent } from '@/mocks/officeFixtures';
import { api, qk } from './client';
import { applyNotificationEvent, fileQuery, ownedFilesQuery } from './hooks';
import type { FilePage, SourceFile } from './types';

const file = {
  id: 'f_alone',
  name: 'Past paper.pdf',
  status: 'pending',
  workspaceId: '',
} as SourceFile;

// A standalone file's ingest rides the owner's notifications (P1,
// 2026-10-27): it patches every owned files list and the file's own query,
// and its end refetches the lists, which brings the thumbnail.
describe('standalone ingest event', () => {
  it('patches the owned files lists and refetches them when it ends', () => {
    const qc = new QueryClient();
    const params = { sort: 'added' as const };
    qc.setQueryData<InfiniteData<FilePage>>(qk.ownedFiles(params), {
      pageParams: [''],
      pages: [{ items: [file] }],
    });
    qc.setQueryData(qk.file(file.id), file);

    applyNotificationEvent(qc, {
      fileId: file.id,
      pct: 40,
      status: 'processing',
      type: 'ingest',
    });
    const listed = qc.getQueryData<InfiniteData<FilePage>>(
      qk.ownedFiles(params)
    )?.pages[0].items[0];
    expect(listed).toMatchObject({ ingestPct: 40, status: 'processing' });
    expect(qc.getQueryData(qk.file(file.id))).toMatchObject({
      ingestPct: 40,
      status: 'processing',
    });

    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    applyNotificationEvent(qc, {
      fileId: file.id,
      indexed: true,
      pct: 100,
      status: 'ready',
      type: 'ingest',
    });
    expect(qc.getQueryData(qk.file(file.id))).toMatchObject({
      indexed: true,
      status: 'ready',
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.ownedFilesRoot });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.file(file.id) });
  });

  // A standalone file has no tree event, and no event names a converted
  // legacy Office file. The worker's one event after the swap rereads the
  // owned files list and the detail still named as legacy.
  const legacy = { ...file, id: 'f_legacy', name: 'essay.doc' } as SourceFile;
  /** The owned files list and the open file, both read from `stored`. */
  function watched(stored: { file: SourceFile }) {
    const qc = new QueryClient();
    const get = vi
      .spyOn(api, 'get')
      .mockImplementation(
        async <T>(path: string) =>
          (path.startsWith('/files/')
            ? stored.file
            : { items: [stored.file] }) as T
      );
    const list = new InfiniteQueryObserver(qc, ownedFilesQuery());
    const detail = new QueryObserver(qc, fileQuery(legacy.id));
    const stop = [list.subscribe(() => {}), detail.subscribe(() => {})];
    const row = () =>
      qc.getQueryData<InfiniteData<FilePage>>(qk.ownedFiles({}))?.pages[0]
        .items[0];
    return {
      detail: () => qc.getQueryData<SourceFile>(qk.file(legacy.id)),
      end: () => {
        for (const unsubscribe of stop) unsubscribe();
        qc.clear();
        get.mockRestore();
      },
      get,
      qc,
      row,
    };
  }

  it('shows the converted name at the pending event, before the parse', async () => {
    const stored = { file: { ...legacy, status: 'processing' } as SourceFile };
    const tab = watched(stored);
    try {
      await vi.waitFor(() => expect(tab.row()?.name).toBe('essay.doc'));
      await vi.waitFor(() => expect(tab.detail()?.name).toBe('essay.doc'));
      stored.file = { ...legacy, name: 'essay.docx', status: 'pending' };
      applyNotificationEvent(tab.qc, {
        fileId: legacy.id,
        ...mockConvertedEvent('essay.docx', 'fast'),
        type: 'ingest',
      });
      await vi.waitFor(() => expect(tab.row()?.name).toBe('essay.docx'));
      await vi.waitFor(() => expect(tab.detail()?.name).toBe('essay.docx'));

      // Renamed: the parse's own progress rereads nothing.
      const reads = tab.get.mock.calls.length;
      applyNotificationEvent(tab.qc, {
        fileId: legacy.id,
        pct: 40,
        status: 'processing',
        type: 'ingest',
      });
      expect(tab.row()).toMatchObject({ ingestPct: 40, name: 'essay.docx' });
      expect(tab.get.mock.calls).toHaveLength(reads);
    } finally {
      tab.end();
    }
  });

  it('shows a file converted with parsing off as ready under its new name', async () => {
    const stored = { file: { ...legacy, status: 'processing' } as SourceFile };
    const tab = watched(stored);
    try {
      await vi.waitFor(() => expect(tab.row()?.name).toBe('essay.doc'));
      await vi.waitFor(() => expect(tab.detail()?.name).toBe('essay.doc'));
      stored.file = {
        ...legacy,
        indexed: false,
        name: 'essay.docx',
        status: 'ready',
      };
      applyNotificationEvent(tab.qc, {
        fileId: legacy.id,
        ...mockConvertedEvent('essay.docx', 'none'),
        type: 'ingest',
      });
      const converted = { indexed: false, name: 'essay.docx', status: 'ready' };
      await vi.waitFor(() => expect(tab.row()).toMatchObject(converted));
      await vi.waitFor(() => expect(tab.detail()).toMatchObject(converted));
    } finally {
      tab.end();
    }
  });
});
