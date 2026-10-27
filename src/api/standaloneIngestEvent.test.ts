import { type InfiniteData, QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { qk } from './client';
import { applyNotificationEvent } from './hooks';
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
});
