import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HIDDEN_LEAVE_MS, whileVisible } from './whileVisible';

/* A reader tab hidden for 5 minutes leaves its room and joins again once it
 * shows (REVIEW5 N5). */

function page(state: DocumentVisibilityState) {
  const target = new EventTarget();
  return Object.assign(target, {
    show(next: DocumentVisibilityState) {
      this.visibilityState = next;
      target.dispatchEvent(new Event('visibilitychange'));
    },
    visibilityState: state,
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('leaves after 5 hidden minutes and joins again when the tab shows', () => {
  const tab = page('visible');
  const joins: string[] = [];
  const stop = whileVisible(() => {
    joins.push('join');
    return () => joins.push('leave');
  }, tab);
  expect(joins).toEqual(['join']);
  // Hidden for less than the delay: still joined.
  tab.show('hidden');
  vi.advanceTimersByTime(HIDDEN_LEAVE_MS - 1);
  tab.show('visible');
  vi.advanceTimersByTime(HIDDEN_LEAVE_MS);
  expect(joins).toEqual(['join']);
  tab.show('hidden');
  vi.advanceTimersByTime(HIDDEN_LEAVE_MS);
  expect(joins).toEqual(['join', 'leave']);
  tab.show('visible');
  expect(joins).toEqual(['join', 'leave', 'join']);
  stop();
  expect(joins).toEqual(['join', 'leave', 'join', 'leave']);
  // Stopped: no more joins.
  tab.show('hidden');
  tab.show('visible');
  expect(joins).toHaveLength(4);
});

it('counts the delay from the start for a tab opened hidden', () => {
  const tab = page('hidden');
  const joins: string[] = [];
  whileVisible(() => {
    joins.push('join');
    return () => joins.push('leave');
  }, tab);
  vi.advanceTimersByTime(HIDDEN_LEAVE_MS);
  expect(joins).toEqual(['join', 'leave']);
});
