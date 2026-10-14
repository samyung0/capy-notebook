import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthTokenGetter } from '@/api/auth';
import {
  createThumbnailCapture,
  DRAW_AFTER_MS,
  type DrawnThumbnail,
  MAX_UPLOAD_BYTES,
  NOT_DRAWN_YET,
  openedOn,
  ThumbnailUploadRefused,
  UPLOAD_AFTER_MS,
  UPLOAD_WITHIN_MS,
  uploadThumbnail,
} from './thumbnailCapture';

const bytes = new ArrayBuffer(8);
const drawn: DrawnThumbnail = {
  bytes,
  headers: { Authorization: 'Bearer drawn' },
};
/** An upload of the drawn capture. */
const sent = (keepalive: boolean) => [
  expect.objectContaining({ bytes }),
  keepalive,
];

function setup({
  allowed = true,
  draw = vi.fn(
    async (): Promise<DrawnThumbnail | null | typeof NOT_DRAWN_YET> => drawn
  ),
} = {}) {
  const upload = vi.fn(
    async (_drawn: DrawnThumbnail, _keepalive: boolean) => {}
  );
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
    expect(upload).toHaveBeenCalledExactlyOnceWith(...sent(false));
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
    expect(upload).toHaveBeenCalledExactlyOnceWith(...sent(false));
    // Nothing is drawn or sent again for the edits the capture covered.
    await vi.advanceTimersByTimeAsync(UPLOAD_AFTER_MS);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('keeps the idle upload when the 10-minute mark comes while saving', async () => {
    const { capture, state, upload } = setup({ allowed: false });
    for (let elapsed = 0; elapsed < UPLOAD_WITHIN_MS; elapsed += 2000) {
      capture.edited();
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(upload).not.toHaveBeenCalled();
    // The room has the edits now: the upload 60 s after the last one goes.
    state.allowed = true;
    await vi.advanceTimersByTimeAsync(UPLOAD_AFTER_MS);
    expect(upload).toHaveBeenCalledExactlyOnceWith(...sent(false));
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
    expect(upload).toHaveBeenCalledExactlyOnceWith(...sent(true));
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
    expect(upload).toHaveBeenCalledExactlyOnceWith(...sent(true));
  });

  it('logs a failed draw once and never retries it', async () => {
    const draw = vi.fn(async (): Promise<DrawnThumbnail | null> => {
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

  it('never retries a failed upload, and leaving sends its edits again', async () => {
    const { capture, draw, upload } = setup();
    upload.mockRejectedValueOnce(new Error('429'));
    capture.edited();
    await vi.advanceTimersByTimeAsync(UPLOAD_WITHIN_MS);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    capture.leave();
    expect(draw).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenLastCalledWith(...sent(true));
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('a refused 10-minute upload goes again 60 s after the last edit', async () => {
    const { capture, upload } = setup();
    upload.mockRejectedValueOnce(new Error('429'));
    for (let elapsed = 0; elapsed < UPLOAD_WITHIN_MS; elapsed += 2000) {
      capture.edited();
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(upload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UPLOAD_AFTER_MS);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it(`never sends a capture of ${MAX_UPLOAD_BYTES} bytes or more`, async () => {
    const big = vi.fn(async () => ({
      bytes: new ArrayBuffer(MAX_UPLOAD_BYTES),
      headers: {},
    }));
    const refused = setup({ draw: big });
    refused.capture.edited();
    await vi.advanceTimersByTimeAsync(UPLOAD_WITHIN_MS);
    refused.capture.leave();
    expect(refused.upload).not.toHaveBeenCalled();

    const fits = setup({
      draw: vi.fn(async () => ({
        bytes: new ArrayBuffer(MAX_UPLOAD_BYTES - 1),
        headers: {},
      })),
    });
    fits.capture.edited();
    await vi.advanceTimersByTimeAsync(UPLOAD_AFTER_MS);
    expect(fits.upload).toHaveBeenCalledTimes(1);
  });

  it('ends quietly when there is nothing to capture', async () => {
    const draw = vi.fn(async (): Promise<DrawnThumbnail | null> => null);
    const { capture, upload } = setup({ draw });
    capture.edited();
    await vi.advanceTimersByTimeAsync(UPLOAD_WITHIN_MS);
    capture.leave();
    expect(draw).toHaveBeenCalledTimes(1);
    expect(upload).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('keeps the cycle when a DOCX draw comes before its layout, and uploads once from the next draw', async () => {
    const draw = vi
      .fn(
        async (): Promise<DrawnThumbnail | null | typeof NOT_DRAWN_YET> => drawn
      )
      .mockResolvedValueOnce(NOT_DRAWN_YET);
    const { capture, upload } = setup({ draw });
    capture.edited();
    await vi.advanceTimersByTimeAsync(DRAW_AFTER_MS);
    expect(draw).toHaveBeenCalledTimes(1);
    // Nothing was drawn, so leaving has nothing to send yet.
    capture.leave();
    expect(upload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(UPLOAD_AFTER_MS - DRAW_AFTER_MS);
    expect(draw).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenCalledExactlyOnceWith(...sent(false));
    await vi.advanceTimersByTimeAsync(UPLOAD_WITHIN_MS);
    capture.leave();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('captures a stale card once on open, and nothing for a fresh one', async () => {
    const stale = setup();
    stale.capture.opened(true);
    // A frame restart within the same open counts for nothing.
    stale.capture.opened(true);
    await vi.advanceTimersByTimeAsync(UPLOAD_WITHIN_MS);
    stale.capture.leave();
    expect(stale.draw).toHaveBeenCalledTimes(1);
    expect(stale.upload).toHaveBeenCalledExactlyOnceWith(...sent(false));

    const fresh = setup();
    fresh.capture.opened(false);
    fresh.capture.opened(true);
    await vi.advanceTimersByTimeAsync(UPLOAD_WITHIN_MS);
    fresh.capture.leave();
    expect(fresh.draw).not.toHaveBeenCalled();
    expect(fresh.upload).not.toHaveBeenCalled();
  });

  it('counts a stale session once, though the editor opens again on it', async () => {
    const seen = new WeakSet<object>();
    const session = { thumbnailStale: true };
    const first = setup();
    openedOn(first.capture, session, seen);
    await vi.advanceTimersByTimeAsync(UPLOAD_AFTER_MS);
    expect(first.upload).toHaveBeenCalledOnce();
    // View and back: a new editor on the same session read.
    first.capture.dispose();
    const again = setup();
    openedOn(again.capture, session, seen);
    await vi.advanceTimersByTimeAsync(UPLOAD_WITHIN_MS);
    expect(again.upload).not.toHaveBeenCalled();
    // A new read that is stale again counts.
    const next = setup();
    openedOn(next.capture, { thumbnailStale: true }, seen);
    await vi.advanceTimersByTimeAsync(UPLOAD_AFTER_MS);
    expect(next.upload).toHaveBeenCalledOnce();
  });

  it('a stale open the editor may not capture yet goes with the idle upload', async () => {
    const { capture, state, upload } = setup({ allowed: false });
    capture.opened(true);
    await vi.advanceTimersByTimeAsync(DRAW_AFTER_MS);
    expect(upload).not.toHaveBeenCalled();
    state.allowed = true;
    await vi.advanceTimersByTimeAsync(UPLOAD_AFTER_MS);
    expect(upload).toHaveBeenCalledExactlyOnceWith(...sent(false));
  });

  it('ends a stale open refused as too soon, with nothing of its own to send', async () => {
    const { capture, upload } = setup();
    upload.mockRejectedValueOnce(new ThumbnailUploadRefused(429));
    capture.opened(true);
    await vi.advanceTimersByTimeAsync(UPLOAD_WITHIN_MS);
    capture.leave();
    expect(upload).toHaveBeenCalledTimes(1);

    // With a local edit in the cycle, the refused capture still goes again.
    const edited = setup();
    edited.upload.mockRejectedValueOnce(new ThumbnailUploadRefused(429));
    edited.capture.opened(true);
    edited.capture.edited();
    await vi.advanceTimersByTimeAsync(UPLOAD_WITHIN_MS);
    edited.capture.leave();
    expect(edited.upload).toHaveBeenCalledTimes(2);
  });

  it('never sends a drawing an update from elsewhere came after', async () => {
    let drawing = 0;
    const draw = vi.fn(async () => ({
      bytes: new ArrayBuffer(++drawing),
      headers: {},
    }));
    const { capture, upload } = setup({ draw });
    capture.edited();
    await vi.advanceTimersByTimeAsync(DRAW_AFTER_MS);
    expect(draw).toHaveBeenCalledTimes(1);
    // The agent edits; then the user leaves the file.
    capture.remote();
    capture.leave();
    expect(upload).not.toHaveBeenCalled();
    // A pending idle upload draws again first.
    await vi.advanceTimersByTimeAsync(UPLOAD_AFTER_MS);
    expect(draw).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenCalledOnce();
    expect(upload.mock.calls[0]?.[0].bytes.byteLength).toBe(2);
  });

  it('drops a drawing an update from elsewhere reached during the draw', async () => {
    let finish: (value: DrawnThumbnail) => void = () => {};
    const draw = vi.fn(
      () =>
        new Promise<DrawnThumbnail>((resolve) => {
          finish = resolve;
        })
    );
    const { capture, upload } = setup({ draw });
    capture.edited();
    await vi.advanceTimersByTimeAsync(DRAW_AFTER_MS);
    capture.remote();
    finish(drawn);
    await vi.advanceTimersByTimeAsync(0);
    capture.leave();
    expect(upload).not.toHaveBeenCalled();
  });

  it('keeps no drawing after a refused upload once an update from elsewhere came', async () => {
    let refuse: (error: Error) => void = () => {};
    const { capture, draw, upload } = setup();
    upload.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          refuse = reject;
        })
    );
    capture.edited();
    await vi.advanceTimersByTimeAsync(UPLOAD_AFTER_MS);
    expect(upload).toHaveBeenCalledTimes(1);
    capture.remote();
    refuse(new Error('429'));
    await vi.advanceTimersByTimeAsync(0);
    // Leaving would have sent the refused drawing again; it is stale now.
    capture.leave();
    expect(draw).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
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
  afterEach(() => {
    vi.unstubAllGlobals();
    setAuthTokenGetter(null);
  });

  it('sends a keepalive upload at once, with the headers fetched when drawing', () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    setAuthTokenGetter(async () => 'fresh');
    void uploadThumbnail('f_1', drawn, true);
    // Called before anything is awaited: the page may be going away.
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      '/api/files/f_1/thumbnail',
      expect.objectContaining({ body: bytes, keepalive: true, method: 'POST' })
    );
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer drawn',
      'Content-Type': 'image/webp',
    });
  });

  it('fetches fresh headers for any other upload', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    setAuthTokenGetter(async () => 'fresh');
    await uploadThumbnail('f_1', drawn, false);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer fresh' });
  });

  it('rejects a refused capture', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 429 }))
    );
    await expect(uploadThumbnail('f_1', drawn, false)).rejects.toEqual(
      new ThumbnailUploadRefused(429)
    );
  });
});
