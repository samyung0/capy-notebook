import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatCredits,
  MICROS_PER_CREDIT,
  usagePercent,
} from './format';

describe('billing formatters', () => {
  it('formats byte counts with binary units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KiB');
    expect(formatBytes(2.5 * 1024 ** 2)).toBe('2.5 MiB');
  });

  it('formats micro-credits as whole credits once the number is large', () => {
    expect(formatCredits(MICROS_PER_CREDIT / 2)).toContain('0.5');
    expect(formatCredits(20_000 * MICROS_PER_CREDIT).replaceAll(',', '')).toBe(
      '20000'
    );
  });

  it('treats reserved spend as part of the meter', () => {
    expect(usagePercent(50, 50, 100)).toBe(100);
    expect(usagePercent(0, 0, 0)).toBe(0);
    expect(usagePercent(200, 0, 100)).toBe(100);
  });
});
