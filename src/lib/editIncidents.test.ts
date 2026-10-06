import { afterEach, describe, expect, it, vi } from 'vitest';

const post = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ api: { post } }));

const {
  editIncidentReporter,
  reportEditIncident,
  reportOnce,
  storageFailureReason,
} = await import('./editIncidents');

afterEach(() => {
  post.mockReset();
  vi.restoreAllMocks();
});

describe('edit incident reports', () => {
  it('posts one validated incident and never retries a failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    post.mockRejectedValue(new Error('offline'));
    editIncidentReporter('source_file', 'f_1')(
      'offline_episode',
      'unreachable',
      2048
    );
    expect(post).toHaveBeenCalledExactlyOnceWith('/edit-incidents', {
      fileId: 'f_1',
      fileKind: 'source_file',
      kind: 'offline_episode',
      reason: 'unreachable',
      sizeBytes: 2048,
    });
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        'Edit incident report failed:',
        expect.any(Error)
      )
    );
    expect(post).toHaveBeenCalledOnce();
  });

  it('sends nothing the generated validator refuses', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    reportEditIncident({
      fileId: 'f_1',
      fileKind: 'source_file',
      kind: 'unconfirmed_edit',
      reason: 'not a token',
    });
    expect(post).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('reports a recovery group once per page load', () => {
    const report = vi.fn();
    reportOnce('session_1:state', report);
    reportOnce('session_1:state', report);
    reportOnce('session_2:state', report);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('names a full quota, missing storage and a failed write', () => {
    expect(
      storageFailureReason(new DOMException('full', 'QuotaExceededError'))
    ).toBe('quota');
    // This environment has no IndexedDB, as some private modes.
    expect(storageFailureReason(new Error('IndexedDB is unavailable'))).toBe(
      'unavailable'
    );
    vi.stubGlobal('indexedDB', {});
    expect(storageFailureReason(new Error('aborted'))).toBe('write');
    vi.unstubAllGlobals();
  });
});
