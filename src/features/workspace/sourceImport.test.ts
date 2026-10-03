import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import type { SourceImportStatus } from '@/api/types';
import {
  parseSourceImportAcceptedResponse,
  SourceImportPollingTimeoutError,
  waitForSourceImport,
  withSourceImportRequestRetry,
} from './sourceImport';

function status(
  value: SourceImportStatus['status'],
  fields: Partial<SourceImportStatus> = {}
): SourceImportStatus {
  return {
    jobId: 'imp_1',
    name: 'file.pdf',
    status: value,
    ...fields,
  };
}

describe('waitForSourceImport', () => {
  it('polls pending work until the file id exists', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(status('pending'))
      .mockResolvedValueOnce(status('running'))
      .mockResolvedValueOnce(status('succeeded', { fileId: 'f_1' }));

    await expect(
      waitForSourceImport(read, 'imp_1', { initialDelayMilliseconds: 0 })
    ).resolves.toBe('f_1');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('surfaces the server terminal error code', async () => {
    const read = vi
      .fn()
      .mockResolvedValue(status('failed', { errorCode: 'file_too_large' }));

    await expect(
      waitForSourceImport(read, 'imp_1', { initialDelayMilliseconds: 0 })
    ).rejects.toMatchObject({
      code: 'file_too_large',
      fileName: 'file.pdf',
      name: 'SourceImportFailedError',
    });
  });

  it('fails closed when success has no file id', async () => {
    const read = vi.fn().mockResolvedValue(status('succeeded'));

    await expect(
      waitForSourceImport(read, 'imp_1', { initialDelayMilliseconds: 0 })
    ).rejects.toMatchObject({
      code: 'import_result_missing',
      fileName: 'file.pdf',
    });
  });

  it('rejects malformed and unknown status payloads at the API seam', async () => {
    await expect(
      waitForSourceImport(vi.fn().mockResolvedValue(null), 'imp_1')
    ).rejects.toMatchObject({ code: 'invalid_import_response' });
    await expect(
      waitForSourceImport(
        vi.fn().mockResolvedValue({
          jobId: 'imp_1',
          name: 'file.pdf',
          status: 'paused',
        }),
        'imp_1'
      )
    ).rejects.toMatchObject({
      code: 'unknown_import_status',
      fileName: 'file.pdf',
    });
  });

  it('treats cancellation as a terminal status', async () => {
    const read = vi.fn().mockResolvedValue(status('cancelled'));

    await expect(waitForSourceImport(read, 'imp_1')).rejects.toMatchObject({
      code: 'source_import_cancelled',
      fileName: 'file.pdf',
    });
  });

  it('does not issue a read after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const read = vi.fn();

    await expect(
      waitForSourceImport(read, 'imp_1', {
        initialDelayMilliseconds: 0,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
  });

  it('stops polling while non-terminal work continues in the background', async () => {
    const read = vi.fn().mockResolvedValue(status('pending'));

    await expect(
      waitForSourceImport(read, 'imp_1', {
        initialDelayMilliseconds: 0,
        maxWaitMilliseconds: 0,
      })
    ).rejects.toEqual(new SourceImportPollingTimeoutError());
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('uses jittered exponential delays between reads', async () => {
    vi.useFakeTimers();
    try {
      const read = vi
        .fn()
        .mockResolvedValueOnce(status('pending'))
        .mockResolvedValueOnce(status('running'))
        .mockResolvedValueOnce(status('succeeded', { fileId: 'f_1' }));
      const result = waitForSourceImport(read, 'imp_1', {
        initialDelayMilliseconds: 100,
        maxDelayMilliseconds: 1000,
        random: () => 0,
      });

      await vi.advanceTimersByTimeAsync(74);
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(149);
      expect(read).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe('f_1');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('source import request retries', () => {
  it('keeps retrying a transient response through the same closure', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(503, 'Service Unavailable', undefined, null)
      )
      .mockResolvedValue({ jobs: [], rejected: [] });
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(withSourceImportRequestRetry(request, wait)).resolves.toEqual({
      jobs: [],
      rejected: [],
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(1000);
  });

  it('does not retry a terminal request error', async () => {
    const error = new ApiError(400, 'Bad Request', undefined, null);
    const request = vi.fn().mockRejectedValue(error);

    await expect(withSourceImportRequestRetry(request, vi.fn())).rejects.toBe(
      error
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('stops before another POST when cancellation happens during backoff', async () => {
    const controller = new AbortController();
    const request = vi.fn().mockRejectedValue(new TypeError('network failed'));
    const wait = vi.fn().mockImplementation(async () => controller.abort());

    await expect(
      withSourceImportRequestRetry(request, wait, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('accepted import responses', () => {
  it('rejects malformed accepted POST payloads', () => {
    expect(() =>
      parseSourceImportAcceptedResponse({
        jobs: [{ jobId: 'imp_1' }],
        rejected: [],
      })
    ).toThrow('Source import failed');
    expect(() =>
      parseSourceImportAcceptedResponse({ jobs: [], rejected: [] })
    ).toThrow('Source import failed');
    expect(() =>
      parseSourceImportAcceptedResponse(
        {
          jobs: [],
          rejected: [{ code: 'unsupported_file', fileId: 'other' }],
        },
        'expected'
      )
    ).toThrow('Source import failed');
  });
});
