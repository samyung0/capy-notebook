import { captureException } from '@sentry/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HEARTBEAT_MS } from './protocol';

vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

const SOURCE = 'blob:heartbeat';

/** A dedicated worker the test starts (`ready`), ticks (`beat`) or fails. */
class FakeWorker {
  static started: FakeWorker[] = [];
  onerror: ((event: Partial<ErrorEvent>) => void) | null = null;
  onmessage: ((event: { data: 'ready' | null }) => void) | null = null;
  terminated = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeWorker.started.push(this);
  }
  terminate() {
    this.terminated = true;
  }
  ready() {
    this.onmessage?.({ data: 'ready' });
  }
  beat() {
    if (!this.terminated) this.onmessage?.({ data: null });
  }
  /** A load failure: a plain event, with no message. */
  fail() {
    this.onerror?.({ preventDefault() {} });
  }
}

let blobs: Blob[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.mocked(captureException).mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  FakeWorker.started = [];
  blobs = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    blobs.push(blob as Blob);
    return SOURCE;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// One clock a tab (protocol 41, the 2026-11-24 reviews): a dedicated worker's
// timer, which Chrome's intensive throttling of hidden pages' timers leaves
// alone, built from an inline blob (no built file a deploy can take away),
// started by the first socket and stopped with the last. Fails with a clock
// per socket, a built worker file, a blob URL kept once the worker started,
// or a clock left running once no socket is open.
it('ticks every socket from one inline heartbeat worker while any is open', async () => {
  const { onHeartbeat } = await import('./heartbeat');
  const first = vi.fn();
  const second = vi.fn();
  const stopFirst = onHeartbeat(first);
  const stopSecond = onHeartbeat(second);
  expect(FakeWorker.started).toHaveLength(1);
  const [clock] = FakeWorker.started;
  expect(clock.url).toBe(SOURCE);
  expect(await blobs[0].text()).toContain(
    `setInterval(() => postMessage(null), ${HEARTBEAT_MS})`
  );
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  clock.ready();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(SOURCE);
  clock.beat();
  expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 1]);
  stopFirst();
  clock.beat();
  expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 2]);
  expect(clock.terminated).toBe(false);
  stopSecond();
  expect(clock.terminated).toBe(true);
  onHeartbeat(first);
  expect(FakeWorker.started).toHaveLength(2);
});

// A worker that fails, or never starts, is an error reported once with a
// message that says so, and nothing stands in for it: no page timer beats
// (Epo's rule, no silent downgrade). Fails with a fallback timer, an
// unreported failure, or a report of the bare event ("failed: undefined").
it('reports a heartbeat worker that fails or cannot start, with no page timer in its place', async () => {
  vi.useFakeTimers();
  const { onHeartbeat } = await import('./heartbeat');
  const beat = vi.fn();
  onHeartbeat(beat);
  FakeWorker.started[0].fail();
  expect(FakeWorker.started[0].terminated).toBe(true);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(SOURCE);
  expect(captureException).toHaveBeenCalledTimes(1);
  const [[reported]] = vi.mocked(captureException).mock.calls;
  expect(reported).toBeInstanceOf(Error);
  expect((reported as Error).message).toBe(
    'The heartbeat worker failed: it did not load or start'
  );
  onHeartbeat(vi.fn());
  expect(FakeWorker.started).toHaveLength(1);
  vi.advanceTimersByTime(120_000);
  expect(beat).not.toHaveBeenCalled();

  vi.resetModules();
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        throw new DOMException('blocked', 'SecurityError');
      }
    }
  );
  const fresh = await import('./heartbeat');
  const stop = fresh.onHeartbeat(beat);
  expect(captureException).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(120_000);
  expect(beat).not.toHaveBeenCalled();
  stop();
});
