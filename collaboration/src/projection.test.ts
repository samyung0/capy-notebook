import { afterEach, describe, expect, it, vi } from 'vitest';
import type { YjsDocumentStore } from './persistence.js';

const { captureError } = vi.hoisted(() => ({
  captureError: vi.fn(),
}));

vi.mock('./observability.js', () => ({ captureError }));

import { ProjectionService } from './projection.js';

const content = {
  schemaVersion: 1 as const,
  value: [{ children: [{ text: 'saved' }], id: 'block_1', type: 'p' }],
};

function projectionStore(overrides: Record<string, unknown> = {}) {
  return {
    contentFromState: vi.fn().mockReturnValue(content),
    pending: vi.fn().mockResolvedValue([]),
    recordProjectionError: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as YjsDocumentStore;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  captureError.mockReset();
});

describe('projection failure handling', () => {
  it('records a failed committed projection and still rejects a synchronous caller', async () => {
    const store = projectionStore();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('temporarily down', { status: 503 }))
    );
    const service = new ProjectionService(store, 'http://api', 'secret');

    await expect(
      service.projectAndRecord(
        'mat_1',
        7,
        content,
        'service_command_projection'
      )
    ).rejects.toThrow('projection failed (503)');

    expect(store.recordProjectionError).toHaveBeenCalledWith(
      'mat_1',
      7,
      expect.stringContaining('projection failed (503)')
    );
    expect(captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        materialId: 'mat_1',
        stage: 'service_command_projection',
      })
    );
  });

  it('contains a projection-error write failure without replacing the projection error', async () => {
    const recordError = new Error('database unavailable');
    const store = projectionStore({
      recordProjectionError: vi.fn().mockRejectedValue(recordError),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('upstream down', { status: 502 }))
    );
    const service = new ProjectionService(store, 'http://api', 'secret');

    await expect(
      service.projectAndRecord('mat_1', 8, content, 'document_projection')
    ).rejects.toThrow('projection failed (502)');

    expect(captureError).toHaveBeenCalledWith(recordError, {
      materialId: 'mat_1',
      stage: 'document_projection_record_error',
    });
  });

  it('contains a pending-query failure and permits the next retry', async () => {
    const queryError = new Error('pending query failed');
    const pending = vi
      .fn()
      .mockRejectedValueOnce(queryError)
      .mockResolvedValueOnce([]);
    const service = new ProjectionService(
      projectionStore({ pending }),
      'http://api',
      'secret'
    );

    await expect(service.retryPending()).resolves.toBeUndefined();
    await expect(service.retryPending()).resolves.toBeUndefined();

    expect(pending).toHaveBeenCalledTimes(2);
    expect(captureError).toHaveBeenCalledWith(queryError, {
      stage: 'projection_pending_query',
    });
  });

  it('records one failed pending row and continues with later rows', async () => {
    const store = projectionStore({
      pending: vi.fn().mockResolvedValue([
        { materialId: 'mat_1', state: new Uint8Array(), version: 3 },
        { materialId: 'mat_2', state: new Uint8Array(), version: 4 },
      ]),
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('down', { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new ProjectionService(store, 'http://api', 'secret');

    await expect(service.retryPending()).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.recordProjectionError).toHaveBeenCalledTimes(1);
    expect(store.recordProjectionError).toHaveBeenCalledWith(
      'mat_1',
      3,
      expect.stringContaining('projection failed (503)')
    );
  });

  it('records a malformed pending state and continues with later rows', async () => {
    const decodeError = new Error('invalid stored Yjs state');
    const contentFromState = vi
      .fn()
      .mockImplementationOnce(() => {
        throw decodeError;
      })
      .mockReturnValueOnce(content);
    const store = projectionStore({
      contentFromState,
      pending: vi.fn().mockResolvedValue([
        { materialId: 'mat_1', state: new Uint8Array(), version: 3 },
        { materialId: 'mat_2', state: new Uint8Array(), version: 4 },
      ]),
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new ProjectionService(store, 'http://api', 'secret');

    await expect(service.retryPending()).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.recordProjectionError).toHaveBeenCalledWith(
      'mat_1',
      3,
      'invalid stored Yjs state'
    );
    expect(captureError).toHaveBeenCalledWith(decodeError, {
      materialId: 'mat_1',
      stage: 'projection_pending_decode',
    });
  });

  it('contains an unexpected detached retry rejection started by the timer', async () => {
    const service = new ProjectionService(
      projectionStore(),
      'http://api',
      'secret'
    );
    const retryError = new Error('unexpected retry failure');
    vi.spyOn(service, 'retryPending').mockRejectedValue(retryError);

    service.start();
    await vi.waitFor(() => {
      expect(captureError).toHaveBeenCalledWith(retryError, {
        stage: 'projection_pending_retry',
      });
    });
    service.stop();
  });

  it('does not let an older failure replace a newer successful projection', async () => {
    let projectedVersion = 0;
    let projectionError: string | null = null;
    let releaseOld!: () => void;
    const oldResponse = new Promise<Response>((resolve) => {
      releaseOld = () =>
        resolve(new Response('older projection failed', { status: 503 }));
    });
    const store = projectionStore({
      recordProjectionError: vi.fn(
        async (_materialId: string, version: number, message: string) => {
          if (projectedVersion < version) projectionError = message;
        }
      ),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { yjsVersion: number };
        if (body.yjsVersion === 7) return oldResponse;
        projectedVersion = body.yjsVersion;
        projectionError = null;
        return new Response(null, { status: 204 });
      })
    );
    const service = new ProjectionService(store, 'http://api', 'secret');

    const older = service.projectAndRecord('mat_1', 7, content);
    await service.projectAndRecord('mat_1', 8, content);
    releaseOld();
    await expect(older).rejects.toThrow('projection failed (503)');

    expect(projectedVersion).toBe(8);
    expect(projectionError).toBeNull();
    expect(store.recordProjectionError).toHaveBeenCalledWith(
      'mat_1',
      7,
      expect.stringContaining('projection failed (503)')
    );
  });
});
