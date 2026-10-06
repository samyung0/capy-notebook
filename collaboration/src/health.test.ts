import { expect, it, vi } from 'vitest';
import { percentile, SLOW_SAVE_MS, StoreTimings } from './health.js';

it('summarizes one interval of store durations and starts the next empty', () => {
  expect(percentile([], 0.95)).toBe(0);
  const timings = new StoreTimings('material');
  const save = { bytes: 1, room: 'material:m_1:schema:1' };
  for (let ms = 1; ms <= 100; ms += 1) timings.record(ms, ms !== 50, save);
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

it('logs one line per slow save with its room and size', () => {
  const lines: string[] = [];
  const record = (line: unknown) => void lines.push(String(line));
  const warns = vi.spyOn(console, 'warn').mockImplementation(record);
  const infos = vi.spyOn(console, 'info').mockImplementation(record);
  try {
    const timings = new StoreTimings('source');
    const save = { bytes: 4096, room: 'source:f_1:epoch:1' };
    timings.record(SLOW_SAVE_MS - 1, true, save);
    timings.record(SLOW_SAVE_MS + 500, false, save);
  } finally {
    warns.mockRestore();
    infos.mockRestore();
  }
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('slow_save');
  for (const field of ['"bytes":4096', '"kind":"source"', '"ok":false', 'f_1'])
    expect(lines[0]).toContain(field);
});
