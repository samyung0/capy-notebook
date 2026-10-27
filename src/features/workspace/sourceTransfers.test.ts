import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import type { SourceFile } from '@/api/types';
import { uploadWithTicket } from '@/api/uploadTurn';
import { m } from '@/i18n';
import { CopyError } from '@/lib/copyError';
import {
  type LocalTransferRequest,
  type RemoteTransferRequest,
  removeSourceTransfer,
  resetSourceTransfers,
  type SourceTransfer,
  startSourceTransfer,
  useSourceTransfers,
} from './sourceTransfers';
import { SOURCE_UPLOAD_CONCURRENCY } from './sourceUpload';
import { transferStatus } from './transferStatus';

const { del, get, post } = vi.hoisted(() => ({
  del: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
}));
vi.mock('@/api/client', async (load) => {
  const client = await load<typeof import('@/api/client')>();
  return { ...client, api: { ...client.api, del, get, post } };
});
vi.mock('@/api/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/auth')>()),
  USE_MSW: true,
}));
const userToast = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/userToast', () => ({ userToast }));
const compressSource = vi.hoisted(() => vi.fn());
vi.mock('./sourceCompress', () => ({ compressSource }));

/** The caps the browser compresses to and checks before sending. */
const limits = { imageMaxBytes: 2 << 20, maxBytes: 10 << 20 };

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

const remote = (name: string): RemoteTransferRequest => ({
  chapterId: null,
  chapterName: null,
  fileId: `drive_${name}`,
  key: name,
  kind: 'pdf',
  name,
  parseMode: 'none',
  provider: 'google',
});

afterEach(() => {
  resetSourceTransfers();
  userToast.mockReset();
  vi.resetAllMocks();
});

/** An upload that runs until its signal aborts. */
const runUntilAborted = ({ signal }: { signal: AbortSignal }) =>
  new Promise<SourceFile>((_, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason))
  );

describe('source transfers', () => {
  it('sends every file after one fails and merges failures into one toast', async () => {
    const uploadSource = vi.fn(
      ({ file }: { batchId: string; batchTotal: number; file: File }) => {
        if (file.name === 'full.pdf') {
          return Promise.reject(
            // The uploader pays, so the refusal carries its own numbers.
            new ApiError(413, 'Payload Too Large', '', {
              code: 'storage_quota_exceeded',
              ownerUserId: 'u_me',
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
      limits,
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

describe('compressing before the upload', () => {
  const office = (name: string, size: number): LocalTransferRequest => ({
    ...request(name),
    file: new File([new Uint8Array(size)], name),
    kind: 'doc',
  });

  // Office pictures are compressed and EMF/WMF pictures removed before the
  // upload, the per-file cap applies to the compressed file, and the toast
  // names how many pictures went (Epo 2026-10-24).
  it('uploads the compressed file, checks its cap, and tells how many pictures were removed', async () => {
    compressSource.mockImplementation(
      async ({ file }: { file: File }, onProgress: (value: number) => void) => {
        onProgress(50);
        return file.name === 'huge.docx'
          ? {
              file: new File([new Uint8Array(limits.maxBytes + 1)], file.name),
              removed: 0,
            }
          : { file: new File(['small'], file.name), removed: 3 };
      }
    );
    const uploadSource = vi.fn(async ({ file }: { file: File }) => ({
      id: `f_${file.name}`,
    }));
    startSourceTransfer({
      importSources: vi.fn(),
      limits,
      local: [office('plan.docx', limits.maxBytes + 5), office('huge.docx', 9)],
      uploadSource: uploadSource as never,
      workspaceId: 'ws_1',
    });
    await vi.waitFor(() =>
      expect(useSourceTransfers.getState().unsent).toBe(0)
    );
    expect(compressSource.mock.calls.map(([call]) => call.compression)).toEqual(
      ['office', 'office']
    );
    // The picked file was over the cap; what is sent is the compressed one.
    expect(uploadSource).toHaveBeenCalledTimes(1);
    expect(uploadSource.mock.calls[0][0].file.size).toBe(5);
    expect(
      useSourceTransfers
        .getState()
        .transfers.map(({ error, stage }) => [stage, error])
    ).toEqual([
      ['added', undefined],
      ['failed', m.source_files_too_large({ mb: 10 })],
    ]);
    expect(userToast).toHaveBeenCalledWith({
      description: m.source_pictures_removed_body({ count: 3 }),
      title: m.source_pictures_removed({ name: 'plan.docx' }),
      variant: 'warning',
    });
  });

  it('refuses an image source no decoder reads before anything is sent', async () => {
    compressSource.mockRejectedValue(
      new CopyError(m.source_image_unreadable())
    );
    const uploadSource = vi.fn();
    startSourceTransfer({
      importSources: vi.fn(),
      limits,
      local: [{ ...request('photo.heic'), kind: 'image' }],
      uploadSource,
      workspaceId: 'ws_1',
    });
    await vi.waitFor(() =>
      expect(useSourceTransfers.getState().unsent).toBe(0)
    );
    expect(compressSource.mock.calls[0][0].compression).toBe('image');
    expect(uploadSource).not.toHaveBeenCalled();
    expect(useSourceTransfers.getState().transfers[0]).toMatchObject({
      error: m.source_image_unreadable(),
      stage: 'failed',
    });
  });

  it('tells how many pictures an import removed', async () => {
    const importSources = vi.fn().mockResolvedValue({
      jobs: [{ jobId: 'imp_1', name: 'deck.pptx', uploadId: 'up_1' }],
      rejected: [],
    });
    get.mockResolvedValue({
      fileId: 'f_1',
      jobId: 'imp_1',
      name: 'deck.pptx',
      removedPictures: 2,
      status: 'succeeded',
    });
    startSourceTransfer({
      importSources: importSources as never,
      remote: [remote('deck.pptx')],
      uploadSource: vi.fn(),
      workspaceId: 'ws_1',
    });
    await vi.waitFor(() =>
      expect(userToast).toHaveBeenCalledWith({
        description: m.source_pictures_removed_body({ count: 2 }),
        title: m.source_pictures_removed({ name: 'deck.pptx' }),
        variant: 'warning',
      })
    );
  });
});

// A standalone import (no workspace) polls the unscoped import route and
// lands the file in the Files page's list.
describe('a standalone transfer', () => {
  it('polls the unscoped import status', async () => {
    const importSources = vi.fn().mockResolvedValue({
      jobs: [{ jobId: 'imp_1', name: 'notes.pdf', uploadId: 'up_1' }],
      rejected: [],
    });
    get.mockResolvedValue({
      fileId: 'f_alone',
      jobId: 'imp_1',
      name: 'notes.pdf',
      status: 'succeeded',
    });
    startSourceTransfer({
      importSources: importSources as never,
      remote: [remote('notes.pdf')],
      uploadSource: vi.fn(),
      workspaceId: null,
    });
    await vi.waitFor(() =>
      expect(useSourceTransfers.getState().transfers[0]).toMatchObject({
        fileId: 'f_alone',
        stage: 'added',
        workspaceId: null,
      })
    );
    expect(get.mock.calls[0][0]).toBe('/sources/imports/imp_1');
  });
});

// An upload past the upload rate class waits in the gateway's line; one the
// gateway still refuses 429 fails its row without a browser retry (security
// regression: rate-limit audit Q282).
describe('a limited upload', () => {
  it('fails an upload answered 429 without retrying it', async () => {
    const uploadSource = vi.fn(() =>
      Promise.reject(
        new ApiError(429, 'Too Many Requests', '', { retryAfterSeconds: 1 })
      )
    );
    startSourceTransfer({
      importSources: vi.fn(),
      limits,
      local: [request('a.pdf')],
      uploadSource: uploadSource as never,
      workspaceId: 'ws_1',
    });
    // Long enough for a retry after the 1 s to show.
    await vi.waitFor(
      () => expect(useSourceTransfers.getState().unsent).toBe(0),
      { timeout: 5000 }
    );
    expect(uploadSource).toHaveBeenCalledTimes(1);
    expect(useSourceTransfers.getState().transfers[0].stage).toBe('failed');
  });
});

describe('removing a row', () => {
  // Each row's remove cancels its upload and gives up its place in the
  // gateway's line, and its batch counts it as removed at once (Epo
  // 2026-10-22).
  it('gives back the ticket of a file waiting in line as removed', async () => {
    post.mockResolvedValueOnce({ position: 2, ticketId: 'utk_wait' });
    get.mockImplementation(
      (_path: string, options: { signal: AbortSignal }) =>
        new Promise((_, reject) =>
          options.signal.addEventListener('abort', () =>
            reject(options.signal.reason)
          )
        )
    );
    del.mockResolvedValue(undefined);
    const send = vi.fn();
    startSourceTransfer({
      importSources: vi.fn(),
      limits,
      local: [request('waiting.pdf')],
      uploadSource: (({
        onQueued,
        signal,
      }: {
        onQueued: (position: number) => void;
        signal: AbortSignal;
      }) =>
        uploadWithTicket('/workspaces/ws_1/sources/uploads', {}, send, {
          onQueued,
          signal,
        })) as never,
      workspaceId: 'ws_1',
    });
    await vi.waitFor(() =>
      expect(useSourceTransfers.getState().transfers[0]?.queuePosition).toBe(2)
    );
    removeSourceTransfer('waiting.pdf');
    await vi.waitFor(() =>
      expect(del).toHaveBeenCalledWith(
        '/uploads/tickets/utk_wait?reason=removed'
      )
    );
    expect(useSourceTransfers.getState().transfers).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    // The ticket's give-back counts it; nothing else does.
    expect(post).toHaveBeenCalledTimes(1);
    expect(userToast).not.toHaveBeenCalled();
  });

  it('counts a file removed before it was sent as removed in its batch', async () => {
    post.mockResolvedValue(undefined);
    // Each started upload holds a ticket, whose give-back counts it.
    const uploadSource = vi.fn(
      (upload: {
        onQueued: (position: number) => void;
        signal: AbortSignal;
      }) => {
        upload.onQueued(1);
        return runUntilAborted(upload);
      }
    );
    const names = ['a.pdf', 'b.pdf', 'c.pdf', 'later.pdf'];
    expect(names.length).toBe(SOURCE_UPLOAD_CONCURRENCY + 1);
    startSourceTransfer({
      importSources: vi.fn(),
      limits,
      local: names.map(request),
      uploadSource: uploadSource as never,
      workspaceId: 'ws_1',
    });
    await vi.waitFor(() =>
      expect(uploadSource).toHaveBeenCalledTimes(SOURCE_UPLOAD_CONCURRENCY)
    );
    const { batchId } = uploadSource.mock.calls[0][0] as unknown as {
      batchId: string;
    };
    // later.pdf waits for a.pdf's slot, so it starts, removed, only after
    // a.pdf's give-up has run.
    removeSourceTransfer('later.pdf');
    removeSourceTransfer('a.pdf');
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        `/workspaces/ws_1/sources/batches/${batchId}/removed`,
        { source: 'upload', total: 4 }
      )
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(uploadSource).toHaveBeenCalledTimes(SOURCE_UPLOAD_CONCURRENCY);
    expect(userToast).not.toHaveBeenCalled();
  });

  // Upload-limits review r2 L1: the ticket request is not aborted, so a file
  // removed while it is out is counted once, by its ticket's give-back.
  it('counts a removal during its ticket request once', async () => {
    let answer = (_: unknown) => undefined as void;
    post.mockImplementation(
      (path: string, _body: unknown, options?: { signal?: AbortSignal }) =>
        path.endsWith('/tickets')
          ? new Promise((resolve, reject) => {
              options?.signal?.addEventListener('abort', () =>
                reject(options.signal?.reason)
              );
              answer = resolve;
            })
          : Promise.resolve(undefined)
    );
    del.mockResolvedValue(undefined);
    startSourceTransfer({
      importSources: vi.fn(),
      limits,
      local: [request('late.pdf')],
      uploadSource: (({
        onQueued,
        signal,
      }: {
        onQueued: (position: number) => void;
        signal: AbortSignal;
      }) =>
        uploadWithTicket('/workspaces/ws_1/sources/uploads', {}, vi.fn(), {
          onQueued,
          signal,
        })) as never,
      workspaceId: 'ws_1',
    });
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    removeSourceTransfer('late.pdf');
    answer({ position: 1, ticketId: 'utk_late' });
    await vi.waitFor(() =>
      expect(useSourceTransfers.getState().unsent).toBe(0)
    );
    expect(del).toHaveBeenCalledWith(
      '/uploads/tickets/utk_late?reason=removed'
    );
    expect(post).toHaveBeenCalledTimes(1);
  });

  // Upload-limits review r2 L7: an importing row's remove aborts its import
  // request, and counts the file only when the server holds nothing of it.

  it('counts an import removed while it waits to retry', async () => {
    post.mockResolvedValue(undefined);
    const importSources = vi.fn().mockRejectedValue(
      new ApiError(429, 'Too Many Requests', undefined, {
        retryAfterSeconds: 30,
      })
    );
    startSourceTransfer({
      importSources: importSources as never,
      remote: [remote('paper.pdf')],
      uploadSource: vi.fn(),
      workspaceId: 'ws_1',
    });
    await vi.waitFor(() => expect(importSources).toHaveBeenCalledTimes(1));
    const { batchId } = importSources.mock.calls[0][0] as { batchId: string };
    removeSourceTransfer('paper.pdf');
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        `/workspaces/ws_1/sources/batches/${batchId}/removed`,
        { source: 'import', total: 1 }
      )
    );
    expect(userToast).not.toHaveBeenCalled();
  });

  it('leaves an import removed during its request to the server', async () => {
    const importSources = vi.fn(runUntilAborted);
    startSourceTransfer({
      importSources: importSources as never,
      remote: [remote('paper.pdf')],
      uploadSource: vi.fn(),
      workspaceId: 'ws_1',
    });
    await vi.waitFor(() => expect(importSources).toHaveBeenCalledTimes(1));
    removeSourceTransfer('paper.pdf');
    await vi.waitFor(() =>
      expect(useSourceTransfers.getState().unsent).toBe(0)
    );
    // The request may have reached the server, which then counts the import.
    expect(post).not.toHaveBeenCalled();
    expect(importSources.mock.calls[0][0].signal.aborted).toBe(true);
  });
});

// Safari before 17.4 has no AbortSignal.any; uploads must not need it.
it('sends without AbortSignal.any', async () => {
  const any = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
  Object.defineProperty(AbortSignal, 'any', {
    configurable: true,
    value: undefined,
  });
  try {
    startSourceTransfer({
      importSources: vi.fn(),
      limits,
      local: [request('old-safari.pdf')],
      uploadSource: (async () => ({ id: 'f_1' }) as SourceFile) as never,
      workspaceId: 'ws_1',
    });
    await vi.waitFor(() =>
      expect(useSourceTransfers.getState().transfers[0]?.stage).toBe('added')
    );
  } finally {
    if (any) Object.defineProperty(AbortSignal, 'any', any);
  }
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
          indexLimit: 'tabular_column_limit',
          status: 'ready',
        })
      )
    ).toMatchObject({
      detail: m.files_not_indexed_too_large(),
      kind: 'info',
    });
    expect(
      transferStatus(
        transfer,
        file({ indexed: false, indexLimit: 'element_limit', status: 'ready' })
      )
    ).toMatchObject({
      detail: m.files_not_indexed_too_many_elements(),
      kind: 'info',
    });
    expect(
      transferStatus(transfer, file({ indexed: false, status: 'failed' }))
    ).toMatchObject({ detail: m.files_not_indexed_failed(), kind: 'error' });
    // A failed file that is still indexed (a part missing) keeps answering
    // search, so AI still knows its contents.
    expect(
      transferStatus(transfer, file({ indexed: true, status: 'failed' }))
    ).toMatchObject({ detail: m.files_processing_error(), kind: 'error' });
  });

  it('shows the transfer stage before the file exists', () => {
    expect(
      transferStatus({ ...transfer, stage: 'importing' }, undefined).kind
    ).toBe('indeterminate');
    // Waiting in the gateway's line, then uploading once its turn comes.
    const uploading: SourceTransfer = {
      ...transfer,
      stage: 'uploading',
      uploadPct: 0,
    };
    expect(
      transferStatus({ ...uploading, queuePosition: 3 }, undefined)
    ).toEqual({
      kind: 'queued',
      label: m.source_transfer_upload_queued({ position: 3 }),
    });
    expect(
      transferStatus({ ...uploading, queuePosition: 0 }, undefined)
    ).toMatchObject({ label: m.source_transfer_uploading() });
    expect(
      transferStatus(
        { ...transfer, error: 'Storage limit reached', stage: 'failed' },
        undefined
      )
    ).toMatchObject({ detail: 'Storage limit reached', kind: 'error' });
  });
});
