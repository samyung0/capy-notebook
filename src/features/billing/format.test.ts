import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatCredits,
  MICROS_PER_CREDIT,
  storageLimitLabel,
  usagePercent,
} from './format';
import { PLAN_LIMITS } from './planLimits';

describe('billing formatters', () => {
  it('formats byte counts with decimal units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2000)).toBe('2 KB');
    expect(formatBytes(2_500_000)).toBe('2.5 MB');
  });

  it('formats the plan limits as 100 MB and 1 GB', () => {
    expect(storageLimitLabel(PLAN_LIMITS.free.storageLimitBytes)).toBe(
      '100 MB'
    );
    expect(storageLimitLabel(PLAN_LIMITS.pro.storageLimitBytes)).toBe('1 GB');
  });

  it('keeps both plans unlimited for owned workspaces', () => {
    expect(PLAN_LIMITS.free.ownedWorkspaceLimit).toBeNull();
    expect(PLAN_LIMITS.pro.ownedWorkspaceLimit).toBeNull();
    expect(PLAN_LIMITS.free.materialRevisionLimit).toBe(3);
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
