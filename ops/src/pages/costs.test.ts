import { describe, expect, it } from 'vitest';
import { bucketFor } from './costs';

describe('usage explorer buckets', () => {
  it('uses daily buckets for current month and quarter', () => {
    expect(
      bucketFor({
        from: '2026-07-01',
        group: 'day',
        preset: 'quarter',
        to: '2026-08-28',
      })
    ).toBe('day');
  });

  it('uses monthly buckets for current year and longer custom ranges', () => {
    expect(
      bucketFor({
        from: '2026-01-01',
        group: 'day',
        preset: 'year',
        to: '2026-08-28',
      })
    ).toBe('month');
    expect(
      bucketFor({
        from: '2026-01-01',
        group: 'day',
        preset: 'custom',
        to: '2026-08-28',
      })
    ).toBe('month');
  });
});
