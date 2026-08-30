import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { api, qk } from './client';
import { replaceSourceFile, updateSourceFileCaches } from './hooks';
import type { SourceFile } from './types';

function officeFile(revision: number): SourceFile {
  return {
    addedAt: '2026-08-30T00:00:00Z',
    chapterId: null,
    id: 'file_office',
    indexed: true,
    kind: 'sheet',
    name: 'study-plan.xlsx',
    position: 0,
    revision,
    sizeBytes: 1024,
    status: 'ready',
    url: '/api/files/file_office/raw',
    workspaceId: 'workspace_1',
  };
}

describe('source replacement caches', () => {
  it('reopens a saved Office file with the committed revision before saving again', async () => {
    const qc = new QueryClient();
    const original = officeFile(1);
    const reservationBodies: unknown[] = [];
    let completedRevision = 2;
    async function post<T>(path: string, body?: unknown): Promise<T> {
      if (path.endsWith('/replacement-uploads')) {
        reservationBodies.push(body);
        return {
          expiresAt: '2026-08-30T01:00:00Z',
          headers: {},
          method: 'PUT',
          uploadId: `upload_${completedRevision}`,
          url: `https://blob.test/upload_${completedRevision}`,
        } as T;
      }
      return officeFile(completedRevision++) as T;
    }
    vi.spyOn(api, 'post').mockImplementation(post);
    vi.spyOn(api, 'putFile').mockResolvedValue(undefined);
    qc.setQueryData(qk.file(original.id), original);
    qc.setQueryData(qk.files(original.workspaceId), [original]);
    qc.setQueryData(qk.allFiles, [original]);

    const firstSave = await replaceSourceFile(
      original,
      new Uint8Array([1]),
      original.revision
    );
    updateSourceFileCaches(qc, firstSave);

    let selectedFileId: string | null = original.id;
    selectedFileId = null;
    selectedFileId = original.id;
    const reopened = qc
      .getQueryData<SourceFile[]>(qk.allFiles)
      ?.find((file) => file.id === selectedFileId);
    if (!reopened)
      throw new Error('saved file did not remain in the global cache');
    expect(reopened).toEqual(officeFile(2));
    await replaceSourceFile(reopened, new Uint8Array([2]), reopened.revision);

    expect(reservationBodies).toEqual([
      {
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        expectedRevision: 1,
        sizeBytes: 1,
      },
      {
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        expectedRevision: 2,
        sizeBytes: 1,
      },
    ]);
    expect(qc.getQueryData(qk.file(original.id))).toEqual(officeFile(2));
    expect(qc.getQueryData(qk.files(original.workspaceId))).toEqual([
      officeFile(2),
    ]);
  });
});
