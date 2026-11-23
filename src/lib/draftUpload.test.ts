import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DRAFT_STALL_MS, draftSendTimeout, postDraft } from './draftUpload';

/** A browser's XHR as `postDraft` drives it: the test moves its upload and
 * answers it. */
class FakeXhr {
  static last: FakeXhr | null = null;
  aborted = false;
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  responseText = '';
  status = 0;
  upload: { onload: (() => void) | null; onprogress: (() => void) | null } = {
    onload: null,
    onprogress: null,
  };
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  answer(status: number, text: string) {
    this.status = status;
    this.responseText = text;
    this.onload?.();
  }
  open = vi.fn();
  send() {
    FakeXhr.last = this;
  }
  setRequestHeader = vi.fn();
}

const PIECE = new Uint8Array(2 * 1024 * 1024);
const SERVICE = new URL('https://collab.test/drafts');

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Round 4, finding 9: a 2 MiB piece at 20 KB/s takes 105 s, past the 51 s a
// send was given in all. Fails with a limit on the whole send.
it('keeps a slow upload going while it moves, then waits for its answer', async () => {
  const answer = postDraft(SERVICE, PIECE, {});
  const xhr = FakeXhr.last as FakeXhr;
  for (let second = 0; second < 105; second += 5) {
    vi.advanceTimersByTime(5000);
    xhr.upload.onprogress?.();
  }
  xhr.upload.onload?.();
  vi.advanceTimersByTime(draftSendTimeout(PIECE.byteLength) - 1);
  expect(xhr.aborted).toBe(false);
  xhr.answer(200, '{"type":"checkpoint-persisted"}');
  const response = await answer;
  expect(response.ok).toBe(true);
  expect(await response.json()).toEqual({ type: 'checkpoint-persisted' });
});

// A captive portal or a half-open connection (Q360): the send fails as a try.
// Fails if an upload that never moved, or one that stopped, is never cut.
it('cuts an upload that moved nothing for 30 s', async () => {
  const never = expect(postDraft(SERVICE, PIECE, {})).rejects.toThrow();
  const silent = FakeXhr.last as FakeXhr;
  const stopped = expect(postDraft(SERVICE, PIECE, {})).rejects.toThrow();
  const xhr = FakeXhr.last as FakeXhr;
  vi.advanceTimersByTime(10_000);
  xhr.upload.onprogress?.();
  vi.advanceTimersByTime(DRAFT_STALL_MS - 10_000);
  expect(silent.aborted).toBe(true);
  expect(xhr.aborted).toBe(false);
  vi.advanceTimersByTime(10_000);
  expect(xhr.aborted).toBe(true);
  await never;
  await stopped;
});

// Round 5, finding 2: upload progress counts bytes handed to the network
// stack, so a 2 MiB piece may say "uploaded" at once and still drain at
// 20 KB/s; its answer coming 120 s later lands. Fails with the wait at
// 100 KB/s (51 s).
it('waits for an answer while what the upload handed over may still drain', async () => {
  const answer = postDraft(SERVICE, PIECE, {});
  const xhr = FakeXhr.last as FakeXhr;
  xhr.upload.onprogress?.();
  xhr.upload.onload?.();
  vi.advanceTimersByTime(120_000);
  expect(xhr.aborted).toBe(false);
  xhr.answer(200, '{"type":"checkpoint-persisted"}');
  expect((await answer).ok).toBe(true);
});

// Fails if a send whose answer never comes waits for ever.
it('cuts a send whose answer did not come in its time after the upload', async () => {
  const cut = expect(postDraft(SERVICE, PIECE, {})).rejects.toThrow();
  const xhr = FakeXhr.last as FakeXhr;
  xhr.upload.onload?.();
  vi.advanceTimersByTime(draftSendTimeout(PIECE.byteLength));
  expect(xhr.aborted).toBe(true);
  await cut;
});

it('waits 30 s plus the bytes at the slowest uplink for an answer', () => {
  expect(draftSendTimeout(0)).toBe(30_000);
  // A 2 MiB piece: 30 s and 262 s for its bytes at 8 KB/s.
  expect(draftSendTimeout(2 * 1024 * 1024)).toBe(292_144);
});
