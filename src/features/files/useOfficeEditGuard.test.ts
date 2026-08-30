import { describe, expect, it, vi } from 'vitest';
import { confirmOfficeEditDiscard } from './useOfficeEditGuard';

describe('Office edit discard confirmation', () => {
  it('allows clean viewers without prompting', () => {
    const confirm = vi.fn(() => false);

    expect(confirmOfficeEditDiscard(false, confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('keeps a dirty viewer when discard is rejected', () => {
    expect(confirmOfficeEditDiscard(true, () => false)).toBe(false);
  });

  it('allows a dirty viewer to be replaced after confirmation', () => {
    expect(confirmOfficeEditDiscard(true, () => true)).toBe(true);
  });
});
