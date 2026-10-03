import { describe, expect, it } from 'vitest';
import { createSourceInspectionGuard } from './sourceInspectionGuard';

describe('source inspection guard', () => {
  it('ignores an inspection result after the chooser closes', async () => {
    const guard = createSourceInspectionGuard();
    const isCurrent = guard.begin();
    let releaseInspection: (() => void) | undefined;
    let selected = false;
    const inspection = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    }).then(() => {
      if (isCurrent()) selected = true;
    });

    guard.invalidate();
    releaseInspection?.();
    await inspection;

    expect(selected).toBe(false);
  });
});
