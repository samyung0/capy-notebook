import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SaveDelayClock } from './saveDelay';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

it('warns once the oldest unanswered request waits the limit, and a receipt for it moves the clock on', () => {
  const late = vi.fn();
  const clock = new SaveDelayClock(25_000, late);
  clock.connected();
  clock.requested('first');
  vi.advanceTimersByTime(10_000);
  clock.requested('second');
  // A resend keeps the first request's time.
  clock.requested('first');
  vi.advanceTimersByTime(14_999);
  expect(late).not.toHaveBeenCalled();
  // The receipt answers the first: the second, 10 s younger, is the oldest.
  clock.retain(['second']);
  vi.advanceTimersByTime(10_000);
  expect(late).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(late).toHaveBeenCalledTimes(1);
  clock.retain([]);
  vi.advanceTimersByTime(60_000);
  expect(late).toHaveBeenCalledTimes(1);
});

it('does not count time spent disconnected', () => {
  const late = vi.fn();
  const clock = new SaveDelayClock(25_000, late);
  // Requested before the first sync: the clock starts on connect.
  clock.requested('pending');
  vi.advanceTimersByTime(30_000);
  clock.connected();
  vi.advanceTimersByTime(20_000);
  clock.disconnected();
  vi.advanceTimersByTime(60_000);
  expect(late).not.toHaveBeenCalled();
  clock.connected();
  vi.advanceTimersByTime(4999);
  expect(late).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(late).toHaveBeenCalledTimes(1);
});
