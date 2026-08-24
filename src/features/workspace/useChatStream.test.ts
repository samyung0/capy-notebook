import { describe, expect, it } from 'vitest';
import { shouldApplyCitations } from './useChatStream';

describe('shouldApplyCitations', () => {
  it('keeps a later version and ignores an older one', () => {
    expect(shouldApplyCitations(2, 1)).toBe(true);
    expect(shouldApplyCitations(1, 1)).toBe(true);
    expect(shouldApplyCitations(0, 1)).toBe(false);
  });
});
