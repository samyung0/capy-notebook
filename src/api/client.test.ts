import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from './client';

class FakeUploadXHR {
  static latest: FakeUploadXHR | undefined;
  static autoComplete = true;

  readonly upload = {
    onprogress: null as
      | ((event: {
          lengthComputable: boolean;
          loaded: number;
          total: number;
        }) => void)
      | null,
  };
  readonly open = vi.fn();
  readonly setRequestHeader = vi.fn();
  readonly send = vi.fn(() => {
    this.upload.onprogress?.({
      lengthComputable: true,
      loaded: 25,
      total: 100,
    });
    if (FakeUploadXHR.autoComplete) this.onload?.();
  });
  readonly abort = vi.fn(() => this.onabort?.());
  status = 201;
  statusText = 'Created';
  responseText = '{"ok":true}';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeUploadXHR.latest = this;
  }
}

afterEach(() => {
  FakeUploadXHR.autoComplete = true;
  vi.unstubAllGlobals();
});

describe('multipart upload client', () => {
  it('reports upload progress and completes with the JSON response', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeUploadXHR);
    const progress: number[] = [];

    await expect(
      api.upload<{ ok: boolean }>(
        '/workspaces/ws_1/sources',
        new FormData(),
        (pct) => progress.push(pct)
      )
    ).resolves.toEqual({ ok: true });

    expect(progress).toEqual([25, 100]);
    expect(FakeUploadXHR.latest?.open).toHaveBeenCalledWith(
      'POST',
      '/api/workspaces/ws_1/sources'
    );
  });

  it('aborts an in-flight multipart request through the signal', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeUploadXHR);
    FakeUploadXHR.autoComplete = false;
    const controller = new AbortController();
    const request = api.upload(
      '/workspaces/ws_1/sources',
      new FormData(),
      undefined,
      controller.signal
    );

    await Promise.resolve();
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });
});
