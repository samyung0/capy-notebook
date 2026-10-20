import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDLE_MS, watchIdle } from './idle';

let stop: (() => void) | undefined;
// The page's window, as an event target (the tests run without a DOM).
let page: EventTarget;
beforeEach(() => {
  vi.useFakeTimers();
  page = new EventTarget();
});
afterEach(() => {
  stop?.();
  vi.useRealTimers();
});

function watch() {
  const calls = { sleep: vi.fn(), wake: vi.fn() };
  stop = watchIdle(calls, page);
  return calls;
}

/** The page's collaboration connections close after 60 minutes without
 * input and open again on the next input (Epo 2026-10-20). */
it('sleeps after 60 minutes without input and wakes on the next', () => {
  const { sleep, wake } = watch();
  vi.advanceTimersByTime(IDLE_MS / 2);
  page.dispatchEvent(new Event('pointermove'));
  vi.advanceTimersByTime(IDLE_MS - 1);
  expect(sleep).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(sleep).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(IDLE_MS * 3);
  expect(sleep).toHaveBeenCalledTimes(1);
  page.dispatchEvent(new Event('keydown'));
  expect(wake).toHaveBeenCalledTimes(1);
  page.dispatchEvent(new Event('keydown'));
  expect(wake).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(IDLE_MS);
  expect(sleep).toHaveBeenCalledTimes(2);
});

/** A hidden page gets no input: 60 minutes hidden closes them, and focus
 * when the user comes back opens them. */
it('sleeps after 60 minutes hidden and wakes on focus', () => {
  const { sleep, wake } = watch();
  page.dispatchEvent(new Event('wheel'));
  vi.advanceTimersByTime(IDLE_MS);
  expect(sleep).toHaveBeenCalledTimes(1);
  page.dispatchEvent(new Event('focus'));
  expect(wake).toHaveBeenCalledTimes(1);
});
