import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { REPORT_EVERY_MS, reportInput } from './activity';

let stop: (() => void) | undefined;
// The frame's window, as an event target (the tests run without a DOM).
let frame: EventTarget;
beforeEach(() => {
  vi.useFakeTimers();
  frame = new EventTarget();
});
afterEach(() => {
  stop?.();
  vi.useRealTimers();
});

/** Input in the frame reaches Capy's idle close only as this report (review
 * B1): keyboard, pointer, touch and wheel each count, the first at once and
 * then at most once a minute. */
it('reports input in the frame at once, then at most once a minute', () => {
  const post = vi.fn();
  stop = reportInput(post, frame);
  frame.dispatchEvent(new Event('keydown'));
  expect(post).toHaveBeenCalledTimes(1);
  for (const type of ['pointerdown', 'pointermove', 'touchstart', 'wheel'])
    frame.dispatchEvent(new Event(type));
  expect(post).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(REPORT_EVERY_MS);
  frame.dispatchEvent(new Event('wheel'));
  expect(post).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(REPORT_EVERY_MS);
  frame.dispatchEvent(new Event('touchstart'));
  expect(post).toHaveBeenCalledTimes(3);
});
