import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import type { SourceFile } from '@/api/types';
import { m } from '@/i18n';
import {
  type LocalTransferRequest,
  resetSourceTransfers,
  type SourceTransfer,
  startSourceTransfer,
  useSourceTransfers,
} from './sourceTransfers';
import { transferStatus } from './transferStatus';

vi.mock('@/api/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/auth')>()),
  USE_MSW: true,
}));
const userToast = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/userToast', () => ({ userToast }));

// Store-only PDFs skip ingest, so the runner does not wait on the files cache.
const request = (name: string): LocalTransferRequest => ({
  chapterId: null,
  chapterName: null,
  estimatedCreditMicros: 0,
  file: new File(['x'], name),
  key: name,
  kind: 'pdf',
  name,
  parseMode: 'none',
});

afterEach(() => {
  resetSourceTransfers();
  userToast.mockReset();
});

describe('source transfers', () => {
  it('sends every file after one fails and merges failures into one toast', async () => {
    const uploadSource = vi.fn(
      ({ file }: { batchId: string; batchTotal: number; file: File }) => {
        if (file.name === 'full.pdf') {
          return Promise.reject(
            new ApiError(413, 'Payload Too Large', '', {
              code: 'storage_quota_exceeded',
            })
          );
        }
        if (file.name === 'broken.pdf') {
          return Promise.reject(new Error('network'));
        }
        return Promise.resolve({ id: `f_${file.name}` } as SourceFile);
      }
    );

    startSourceTransfer({
      importSources: vi.fn(),
      local: ['a.pdf', 'full.pdf', 'broken.pdf', 'b.pdf'].map(request),
      uploadSource: uploadSource as never,
      workspaceId: 'ws_1',
    });
    await vi.waitFor(() =>
      expect(useSourceTransfers.getState().unsent).toBe(0)
    );

    expect(uploadSource).toHaveBeenCalledTimes(4);
    // The whole submission is one notification batch.
    const batches = new Set(
      uploadSource.mock.calls.map(([v]) => `${v.batchId}/${v.batchTotal}`)
    );
    expect(batches.size).toBe(1);
    expect([...batches][0].endsWith('/4')).toBe(true);
    expect(
      useSourceTransfers
        .getState()
        .transfers.map(({ name, stage }) => [name, stage])
    ).toEqual([
      ['a.pdf', 'added'],
      ['full.pdf', 'failed'],
      ['broken.pdf', 'failed'],
      ['b.pdf', 'added'],
    ]);
    const ids = new Set(userToast.mock.calls.map(([toast]) => toast.id));
    expect(ids.size).toBe(1);
    expect(userToast.mock.lastCall?.[0]).toMatchObject({
      description: [
        m.source_import_file_error({
          name: 'full.pdf',
          reason: m.error_quota_title(),
        }),
        m.source_import_file_error({
          name: 'broken.pdf',
          reason: m.error_generic_title(),
        }),
      ].join('\n'),
      title: m.source_transfer_failed_many({ count: 2 }),
    });
  });
});

describe('transfer status', () => {
  const transfer: SourceTransfer = {
    fileId: 'f_1',
    key: 'k',
    kind: 'pdf',
    name: 'paper.pdf',
    stage: 'added',
    uploadPct: 100,
    workspaceId: 'ws_1',
  };
  const file = (fields: Partial<SourceFile>) =>
    ({ id: 'f_1', indexed: true, ...fields }) as SourceFile;

  it('follows the file through parsing to its terminal state', () => {
    expect(transferStatus(transfer, undefined)).toMatchObject({
      kind: 'progress',
      value: 0,
    });
    expect(
      transferStatus(transfer, file({ ingestPct: 60, status: 'processing' }))
    ).toMatchObject({ kind: 'progress', value: 60 });
    expect(transferStatus(transfer, file({ status: 'ready' })).kind).toBe(
      'done'
    );
    expect(transferStatus(transfer, file({ status: undefined })).kind).toBe(
      'done'
    );
    // Stored without an index is information, not a warning.
    expect(
      transferStatus(transfer, file({ indexed: false, status: 'ready' })).kind
    ).toBe('info');
    // So is a file over an ingest limit: it opens, only search skips it.
    expect(
      transferStatus(
        transfer,
        file({
          indexed: false,
          indexLimit: 'tabular_cell_limit',
          status: 'ready',
        })
      )
    ).toMatchObject({
      detail: m.files_not_indexed_too_large(),
      kind: 'info',
    });
    expect(
      transferStatus(transfer, file({ indexed: false, status: 'failed' })).kind
    ).toBe('error');
  });

  it('shows the transfer stage before the file exists', () => {
    expect(
      transferStatus({ ...transfer, stage: 'importing' }, undefined).kind
    ).toBe('indeterminate');
    expect(
      transferStatus(
        { ...transfer, error: 'Storage limit reached', stage: 'failed' },
        undefined
      )
    ).toMatchObject({ detail: 'Storage limit reached', kind: 'error' });
  });
});
