import { expect, it } from 'vitest';
import { percentile, StoreTimings } from './health.js';

it('summarizes one interval of store durations and starts the next empty', () => {
  expect(percentile([], 0.95)).toBe(0);
  const timings = new StoreTimings();
  for (let ms = 1; ms <= 100; ms += 1) timings.record(ms, ms !== 50);
  expect(timings.take()).toEqual({
    count: 100,
    failures: 1,
    max_ms: 100,
    p95_ms: 95,
  });
  expect(timings.take()).toEqual({
    count: 0,
    failures: 0,
    max_ms: 0,
    p95_ms: 0,
  });
});
