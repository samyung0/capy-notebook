import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createThumbnailCapture,
  DRAW_AFTER_MS,
  UPLOAD_AFTER_MS,
  UPLOAD_WITHIN_MS,
  uploadThumbnail,
} from './thumbnailCapture';

const drawn = new ArrayBuffer(8);

function setup({
  allowed = true,
  draw = vi.fn(async (): Promise<ArrayBuffer | null> => drawn),
} = {}) {
  const upload = vi.fn(async (_bytes: ArrayBuffer, _keepalive: boolean) => {});
  const state = { allowed };
  const capture = createThumbnailCapture({
    allowed: () => state.allowed,
    draw,
    upload,
  });
  return { capture, draw, state, upload };
}

describe('thumbnail capture scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('draws 5 s after the last edit and uploads that capture 60 s after it', async () => {
    const { capture, draw, upload } = setup();
    capture.edited();
    await vi.advanceTimersByTimeAsync(DRAW_AFTER_MS - 1);
    expect(draw).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(draw).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UPLOAD_AFTER_MS - DRAW_AFTER_MS);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledExactlyOnceWith(drawn, false);
    await vi.advanceTimersByTimeAsync(UPLOAD_WITHIN_MS);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('waits while edits keep coming, and draws again after a later edit', async () => {
    const { capture, draw, upload } = setup();
    for (let second = 0; second < 20; second++) {
      capture.edited();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(draw).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DRAW_AFTER_MS);
    capture.edited();
    await vi.advanceTimersByTimeAsync(UPLOAD_AFTER_MS);
    // The capture drawn before the last edit is stale: the idle one replaced it.
    expect(draw).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('uploads 10 minutes after the first change while editing goes on', async () => {
    const { capture, draw, upload } = setup();
    for (let elapsed = 0; elapsed < UPLOAD_WITHIN_MS; elapsed += 2000) {
      capture.edited();
      await vi.advanceTimersByTimeAsync(2000);
    }
    // Never 5 s idle: the 10-minute mark drew the one capture it sent.
    expect(draw).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledExactlyOnceWith(drawn, false);
  });

  it('captures nothing without a change, and uploads nothing while not allowed', async () => {
    const quiet = setup();
    await vi.advanceTimersByTimeAsync(UPLOAD_WITHIN_MS * 2);
    expect(quiet.draw).not.toHaveBeenCalled();

    const { capture, state, upload } = setup({ allowed: false });
    capture.edited();
    await vi.advanceTimersByTimeAsync(UPLOAD_WITHIN_MS);
    capture.leave();
    expect(upload).not.toHaveBeenCalled();
    // The next chance once the room has the edits and editing is allowed.
    state.allowed = true;
    capture.leave();
    expect(upload).toHaveBeenCalledExactlyOnceWith(drawn, true);
  });

  it('uploads the drawn capture with keepalive when the page hides, once', async () => {
    const { capture, upload } = setup();
    capture.edited();
    capture.leave();
    expect(upload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DRAW_AFTER_MS);
    capture.leave();
    capture.leave();
    await vi.advanceTimersByTimeAsync(UPLOAD_WITHIN_MS);
    expect(upload).toHaveBeenCalledExactlyOnceWith(drawn, true);
  });

  it('logs a failed draw once and never retries it', async () => {
    const draw = vi.fn(async (): Promise<ArrayBuffer | null> => {
      throw new Error('no canvas');
    });
    const { capture, upload } = setup({ draw });
    capture.edited();
    await vi.advanceTimersByTimeAsync(UPLOAD_WITHIN_MS);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(upload).not.toHaveBeenCalled();
    // A later edit starts a new capture, which logs nothing more.
    capture.edited();
    await vi.advanceTimersByTimeAsync(UPLOAD_AFTER_MS);
    expect(draw).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('never retries a failed upload', async () => {
    const { capture, draw, upload } = setup();
    upload.mockRejectedValue(new Error('429'));
    capture.edited();
    await vi.advanceTimersByTimeAsync(UPLOAD_WITHIN_MS);
    capture.leave();
    expect(draw).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('ends quietly when there is nothing to capture', async () => {
    const draw = vi.fn(async (): Promise<ArrayBuffer | null> => null);
    const { capture, upload } = setup({ draw });
    capture.edited();
    await vi.advanceTimersByTimeAsync(UPLOAD_WITHIN_MS);
    capture.leave();
    expect(draw).toHaveBeenCalledTimes(1);
    expect(upload).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('drops everything once disposed', async () => {
    const { capture, draw, upload } = setup();
    capture.edited();
    capture.dispose();
    capture.edited();
    await vi.advanceTimersByTimeAsync(UPLOAD_WITHIN_MS);
    capture.leave();
    expect(draw).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('WebP feature detection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const detect = async (type: string | null) => {
    vi.resetModules();
    if (type === null) vi.stubGlobal('OffscreenCanvas', undefined);
    else
      vi.stubGlobal(
        'OffscreenCanvas',
        class {
          getContext() {
            return {};
          }
          async convertToBlob() {
            return new Blob([], { type });
          }
        }
      );
    const { canEncodeWebp } = await import('./thumbnailCapture');
    return canEncodeWebp();
  };

  it('captures where the canvas encodes WebP, not where it falls back to PNG', async () => {
    expect(await detect('image/webp')).toBe(true);
    // Safari answers a WebP request with a PNG.
    expect(await detect('image/png')).toBe(false);
    expect(await detect(null)).toBe(false);
  });
});

describe('thumbnail upload', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the WebP to the file, keepalive when asked', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    const bytes = new ArrayBuffer(4);
    await uploadThumbnail('f_1', bytes, true);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      '/api/files/f_1/thumbnail',
      expect.objectContaining({ body: bytes, keepalive: true, method: 'POST' })
    );
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ 'Content-Type': 'image/webp' });
  });

  it('rejects a refused capture', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 429 }))
    );
    await expect(
      uploadThumbnail('f_1', new ArrayBuffer(4), false)
    ).rejects.toThrow('429');
  });
});
