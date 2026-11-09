import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { frameInput, HIDDEN_SLEEP_MS, IDLE_MS, watchIdle } from './idle';

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

/** Typing inside an Office frame reaches this page only as the runtime's
 * report: it keeps the connections open and wakes them (review B1). */
it('counts input inside an Office frame', () => {
  const { sleep, wake } = watch();
  vi.advanceTimersByTime(IDLE_MS - 1);
  frameInput(page);
  vi.advanceTimersByTime(IDLE_MS - 1);
  expect(sleep).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(sleep).toHaveBeenCalledTimes(1);
  frameInput(page);
  expect(wake).toHaveBeenCalledTimes(1);
});

/** A clean hidden tab sleeps at 5 minutes and rejoins invisibly when it shows
 * (Epo 2026-11-04). */
describe('a hidden page', () => {
  function hideable(mayHide: () => boolean) {
    const target = new EventTarget();
    const shown = Object.assign(target, {
      visibilityState: 'visible' as DocumentVisibilityState,
    });
    const calls = { mayHide, sleep: vi.fn(), wake: vi.fn() };
    stop = watchIdle(calls, page, shown as never);
    const set = (state: DocumentVisibilityState) => {
      shown.visibilityState = state;
      target.dispatchEvent(new Event('visibilitychange'));
    };
    return { calls, set };
  }

  it('sleeps at 5 minutes hidden, and wakes when it shows', () => {
    const { calls, set } = hideable(() => true);
    set('hidden');
    vi.advanceTimersByTime(HIDDEN_SLEEP_MS - 1);
    expect(calls.sleep).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(calls.sleep).toHaveBeenCalledTimes(1);
    set('visible');
    expect(calls.wake).toHaveBeenCalledTimes(1);
  });

  it('stays while something forbids it, and sleeps once nothing does', () => {
    let clean = false;
    const { calls, set } = hideable(() => clean);
    set('hidden');
    vi.advanceTimersByTime(HIDDEN_SLEEP_MS);
    expect(calls.sleep).not.toHaveBeenCalled();
    clean = true;
    vi.advanceTimersByTime(30_000);
    expect(calls.sleep).toHaveBeenCalledTimes(1);
  });

  it('does nothing when it shows again in time', () => {
    const { calls, set } = hideable(() => true);
    set('hidden');
    vi.advanceTimersByTime(HIDDEN_SLEEP_MS - 1);
    set('visible');
    vi.advanceTimersByTime(HIDDEN_SLEEP_MS);
    expect(calls.sleep).not.toHaveBeenCalled();
    expect(calls.wake).not.toHaveBeenCalled();
  });
});
