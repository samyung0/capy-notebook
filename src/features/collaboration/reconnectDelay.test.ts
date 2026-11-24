import { afterEach, expect, it, vi } from 'vitest';
import {
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  reconnectDelay,
} from './reconnectDelay';

afterEach(() => vi.restoreAllMocks());

// Epo 2026-11-24 ("Add jitter"): the first reconnect waits 0–1 s, each later
// one up to a ceiling that doubles until 30 s.
it('waits from nothing up to a ceiling that doubles to its cap', () => {
  expect(RECONNECT_BASE_MS).toBe(1000);
  expect(RECONNECT_MAX_MS).toBe(30_000);
  const random = vi.spyOn(Math, 'random');
  random.mockReturnValue(0);
  for (const attempt of [0, 3, 10]) expect(reconnectDelay(attempt)).toBe(0);
  random.mockReturnValue(0.999_999);
  const ceilings = [0, 1, 2, 4, 5, 20].map((attempt) =>
    Math.round(reconnectDelay(attempt))
  );
  expect(ceilings).toEqual([1000, 2000, 4000, 16_000, 30_000, 30_000]);
});
